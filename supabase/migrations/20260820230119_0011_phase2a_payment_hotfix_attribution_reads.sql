/*
# DigiXO Desk API — Phase 2A: Payment Integrity Hotfix, Attribution, Reads

## Purpose
Phase 2A of the DigiXO Desk API. This migration:
1. Fixes a pre-existing bug: sales.amount_received was referenced by add_payment
   but never existed as a column. Adds it, backfills from valid payments, and
   patches create_sale to set it on creation.
2. Adds attribution columns to sales for future Hermes/Store/API integration.
3. Adds a stable integration_id to api_keys that survives key rotation.
4. Updates create_api_key and rotate_api_key to manage integration_id.
5. Updates validate_api_key to return integration_id.
6. Hardens log_activity: moves the core to an internal schema function that
   accepts a trusted actor, with a public authenticated wrapper.
7. Creates the internal schema for service-role-only helpers.
8. Adds a read-only reports summary RPC.

## Security
- internal schema: REVOKE ALL FROM PUBLIC, anon, authenticated. GRANT USAGE
  TO service_role only.
- All new internal functions: SECURITY DEFINER, SET search_path = '', REVOKE
  FROM PUBLIC/anon/authenticated, GRANT TO service_role.
- log_activity: removes PUBLIC grant, adds explicit authenticated + service_role.
- No existing RLS policies changed. No existing data destroyed.
- No existing columns dropped. No tables renamed.

## Important Notes
1. amount_received is backfilled from SUM(valid payments) for ALL sales, not
   just zero rows. The backfill uses SET LOCAL app.bypass_payment_guard='on'
   to pass through the existing guard trigger. A DO block assertion aborts
   the migration if any mismatch remains afterward.
2. create_sale is patched minimally to store amount_received = v_amount_received.
   The full shared-core refactor belongs in Phase 2B.
3. integration_id is NOT NULL with a DEFAULT gen_random_uuid(), so existing
   rows are automatically backfilled with distinct values.
4. rotate_api_key copies the old key's integration_id to the new key.
5. The partial unique index on (created_via_integration_id, external_reference)
   provides database-level protection against duplicate Store imports, even
   across key rotation.
*/
-- =========================================================
-- 1. Add sales.amount_received and backfill
-- =========================================================
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS amount_received numeric(12,2) NOT NULL DEFAULT 0;

-- Backfill ALL sales from valid payments (bypass guard trigger during migration)
SET LOCAL app.bypass_payment_guard = 'on';
UPDATE public.sales s
SET amount_received = COALESCE(
  (SELECT SUM(amount) FROM public.payments p
   WHERE p.sale_id = s.id AND p.status = 'valid'), 0
);

-- Assertion: abort if any sale's amount_received != valid-payment total
DO $$
DECLARE
  v_mismatches integer;
BEGIN
  SELECT count(*) INTO v_mismatches
  FROM public.sales s
  LEFT JOIN (
    SELECT sale_id, SUM(amount) AS valid_total
    FROM public.payments WHERE status = 'valid'
    GROUP BY sale_id
  ) p ON p.sale_id = s.id
  WHERE COALESCE(p.valid_total, 0) <> s.amount_received;

  IF v_mismatches > 0 THEN
    RAISE EXCEPTION 'amount_received mismatch on % sales after backfill', v_mismatches;
  END IF;
END $$;

-- =========================================================
-- 2. Add sales attribution columns
-- =========================================================
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS sale_source text
    CHECK (sale_source IS NULL OR sale_source IN ('WhatsApp','Telegram','Website','Referral','Reseller','Other'));

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS external_reference text;

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS salesperson_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS salesperson_name text;

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS created_via_api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL;

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS created_via_integration_id uuid;

CREATE INDEX IF NOT EXISTS idx_sales_external_reference
  ON public.sales (external_reference)
  WHERE external_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_created_via_integration
  ON public.sales (created_via_integration_id)
  WHERE created_via_integration_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_integration_external_ref
  ON public.sales (created_via_integration_id, external_reference)
  WHERE created_via_integration_id IS NOT NULL
  AND external_reference IS NOT NULL;

-- =========================================================
-- 3. Add api_keys.integration_id
-- =========================================================
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS integration_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS idx_api_keys_integration_id
  ON public.api_keys (integration_id);

-- =========================================================
-- 4. Update create_api_key to generate integration_id explicitly
-- =========================================================
CREATE OR REPLACE FUNCTION public.create_api_key(
  p_integration_name text,
  p_scopes text[],
  p_expires_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_raw_bytes bytea;
  v_raw_key text;
  v_key_hash text;
  v_key_prefix text;
  v_key_id uuid;
  v_integration_id uuid;
  v_scope text;
  v_valid_scopes text[] := ARRAY[
    'catalog:read', 'customers:read', 'customers:create', 'customers:update',
    'sales:read', 'sales:create', 'payments:create', 'fulfilment:update',
    'renewals:read', 'renewals:update', 'reports:read'
  ];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can create API keys';
  END IF;

  IF p_integration_name IS NULL OR btrim(p_integration_name) = '' THEN
    RAISE EXCEPTION 'Integration name is required';
  END IF;

  IF p_scopes IS NOT NULL THEN
    FOREACH v_scope IN ARRAY p_scopes LOOP
      IF NOT (v_scope = ANY(v_valid_scopes)) THEN
        RAISE EXCEPTION 'Invalid scope: %', v_scope;
      END IF;
    END LOOP;
  END IF;

  v_raw_bytes := extensions.gen_random_bytes(32);
  v_raw_key := 'dxo_live_' || replace(replace(encode(v_raw_bytes, 'base64'), '+', '-'), '/', '_');
  v_raw_key := regexp_replace(v_raw_key, '=+$', '');
  v_key_hash := encode(extensions.digest(v_raw_key, 'sha256'), 'hex');
  v_key_prefix := substr(v_raw_key, 1, 12);
  v_integration_id := extensions.gen_random_uuid();

  INSERT INTO public.api_keys (
    integration_name, key_prefix, key_hash, scopes,
    is_active, created_by, expires_at, integration_id
  ) VALUES (
    p_integration_name, v_key_prefix, v_key_hash, COALESCE(p_scopes, ARRAY[]::text[]),
    true, auth.uid(), p_expires_at, v_integration_id
  ) RETURNING id INTO v_key_id;

  PERFORM public.log_activity(
    'api_key_created',
    'API key created for integration: ' || p_integration_name,
    'api_key',
    v_key_id,
    NULL,
    jsonb_build_object('integration_name', p_integration_name, 'scopes', COALESCE(p_scopes, ARRAY[]::text[]), 'key_prefix', v_key_prefix, 'integration_id', v_integration_id)
  );

  RETURN jsonb_build_object(
    'key_id', v_key_id,
    'api_key', v_raw_key,
    'key_prefix', v_key_prefix,
    'integration_name', p_integration_name,
    'integration_id', v_integration_id
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_api_key(text, text[], timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_api_key(text, text[], timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_api_key(text, text[], timestamptz) TO authenticated;

-- =========================================================
-- 5. Update rotate_api_key to copy integration_id
-- =========================================================
CREATE OR REPLACE FUNCTION public.rotate_api_key(
  p_key_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_old_key RECORD;
  v_raw_bytes bytea;
  v_raw_key text;
  v_key_hash text;
  v_key_prefix text;
  v_new_key_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can rotate API keys';
  END IF;

  SELECT * INTO v_old_key FROM public.api_keys WHERE id = p_key_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'API key not found';
  END IF;

  v_raw_bytes := extensions.gen_random_bytes(32);
  v_raw_key := 'dxo_live_' || replace(replace(encode(v_raw_bytes, 'base64'), '+', '-'), '/', '_');
  v_raw_key := regexp_replace(v_raw_key, '=+$', '');
  v_key_hash := encode(extensions.digest(v_raw_key, 'sha256'), 'hex');
  v_key_prefix := substr(v_raw_key, 1, 12);

  UPDATE public.api_keys
  SET is_active = false, revoked_at = now()
  WHERE id = p_key_id;

  INSERT INTO public.api_keys (
    integration_name, key_prefix, key_hash, scopes,
    is_active, created_by, expires_at, rotated_from, integration_id
  ) VALUES (
    v_old_key.integration_name, v_key_prefix, v_key_hash, v_old_key.scopes,
    true, auth.uid(), v_old_key.expires_at, p_key_id, v_old_key.integration_id
  ) RETURNING id INTO v_new_key_id;

  PERFORM public.log_activity(
    'api_key_rotated',
    'API key rotated for integration: ' || v_old_key.integration_name,
    'api_key',
    v_new_key_id,
    NULL,
    jsonb_build_object('old_key_id', p_key_id, 'new_key_prefix', v_key_prefix, 'integration_id', v_old_key.integration_id)
  );

  RETURN jsonb_build_object(
    'key_id', v_new_key_id,
    'api_key', v_raw_key,
    'key_prefix', v_key_prefix,
    'integration_name', v_old_key.integration_name,
    'integration_id', v_old_key.integration_id
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rotate_api_key(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rotate_api_key(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rotate_api_key(uuid) TO authenticated;

-- =========================================================
-- 6. Update validate_api_key to return integration_id
-- =========================================================
CREATE OR REPLACE FUNCTION public.validate_api_key(
  p_key_hash text
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT jsonb_build_object(
    'id', k.id,
    'integration_name', k.integration_name,
    'integration_id', k.integration_id,
    'scopes', k.scopes,
    'key_prefix', k.key_prefix
  )
  FROM public.api_keys k
  WHERE k.key_hash = p_key_hash
    AND k.is_active = true
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now());
$function$;

REVOKE EXECUTE ON FUNCTION public.validate_api_key(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_api_key(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.validate_api_key(text) FROM authenticated;

-- =========================================================
-- 7. Create internal schema for service-role-only helpers
-- =========================================================
CREATE SCHEMA IF NOT EXISTS internal;

REVOKE ALL ON SCHEMA internal FROM PUBLIC;
REVOKE ALL ON SCHEMA internal FROM anon;
REVOKE ALL ON SCHEMA internal FROM authenticated;
GRANT USAGE ON SCHEMA internal TO service_role;

-- =========================================================
-- 8. Internal core_log_activity (trusted actor)
-- =========================================================
CREATE OR REPLACE FUNCTION internal.core_log_activity(
  p_actor_id uuid,
  p_action text,
  p_description text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_before_data jsonb DEFAULT NULL,
  p_after_data jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_log_id uuid;
BEGIN
  INSERT INTO public.activity_logs (
    user_id, action, description, entity_type, entity_id, before_data, after_data
  ) VALUES (
    p_actor_id, p_action, p_description, p_entity_type, p_entity_id, p_before_data, p_after_data
  )
  RETURNING id INTO v_log_id;
  RETURN v_log_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION internal.core_log_activity(uuid, text, text, text, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION internal.core_log_activity(uuid, text, text, text, uuid, jsonb, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION internal.core_log_activity(uuid, text, text, text, uuid, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION internal.core_log_activity(uuid, text, text, text, uuid, jsonb, jsonb) TO service_role;

-- =========================================================
-- 9. Harden public.log_activity (authenticated wrapper)
-- =========================================================
CREATE OR REPLACE FUNCTION public.log_activity(
  p_action text,
  p_description text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_before_data jsonb DEFAULT NULL,
  p_after_data jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_active_user() THEN
    RAISE EXCEPTION 'Only active users can log activity';
  END IF;
  RETURN internal.core_log_activity(
    auth.uid(), p_action, p_description, p_entity_type, p_entity_id, p_before_data, p_after_data
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.log_activity(text, text, text, uuid, jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_activity(text, text, text, uuid, jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.log_activity(text, text, text, uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_activity(text, text, text, uuid, jsonb, jsonb) TO service_role;

-- =========================================================
-- 10. Patch create_sale to store amount_received
-- Minimal compatibility patch: stores amount_received = v_amount_received
-- in the sales INSERT. Full shared-core refactor belongs in Phase 2B.
-- =========================================================
CREATE OR REPLACE FUNCTION public.create_sale(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_customer_id uuid;
  v_plan_id uuid;
  v_plan RECORD;
  v_sale_id uuid;
  v_sale_number text;
  v_payment_id uuid;
  v_sub_id uuid;
  v_renewal_id uuid;
  v_amount_received numeric;
  v_final_selling numeric;
  v_cost_price numeric;
  v_payment_status text;
  v_fulfilment_status text;
  v_purchase_type text;
  v_duration_days integer;
  v_warranty_days integer;
  v_sub_start date;
  v_sub_end date;
  v_renewal_date date;
  v_warranty_end date;
  v_is_custom boolean;
  v_product_name text;
  v_plan_name text;
  v_list_price numeric;
  v_payment_fee numeric;
  v_payment_method text;
  v_txn_ref text;
  v_note text;
  v_sale_date date;
  v_new_customer_name text;
  v_new_customer_phone text;
  v_new_customer_email text;
  v_new_customer_type text;
  v_new_customer_source text;
  v_phone_normalized text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'Only active users can create sales';
  END IF;

  v_customer_id := (p_payload->>'customer_id')::uuid;
  v_is_custom := COALESCE((p_payload->>'is_custom')::boolean, false);
  v_plan_id := NULLIF(p_payload->>'product_plan_id', '')::uuid;
  v_product_name := p_payload->>'product_name';
  v_plan_name := p_payload->>'plan_name';
  v_final_selling := COALESCE((p_payload->>'final_selling_price')::numeric, 0);
  v_cost_price := COALESCE((p_payload->>'cost_price')::numeric, 0);
  v_list_price := NULLIF(p_payload->>'list_price', '')::numeric;
  v_payment_fee := COALESCE((p_payload->>'payment_fee')::numeric, 0);
  v_amount_received := COALESCE((p_payload->>'amount_received')::numeric, 0);
  v_payment_method := p_payload->>'payment_method';
  v_txn_ref := p_payload->>'transaction_reference';
  v_fulfilment_status := COALESCE(p_payload->>'fulfilment_status', 'payment_confirmation');
  v_note := p_payload->>'note';
  v_sale_date := COALESCE((p_payload->>'sale_date')::date, CURRENT_DATE);
  v_new_customer_name := p_payload->>'new_customer_name';
  v_new_customer_phone := p_payload->>'new_customer_phone';
  v_new_customer_email := p_payload->>'new_customer_email';
  v_new_customer_type := COALESCE(p_payload->>'new_customer_type', 'retail');
  v_new_customer_source := p_payload->>'new_customer_source';

  IF v_final_selling < 0 OR v_cost_price < 0 OR v_payment_fee < 0 OR v_amount_received < 0 THEN
    RAISE EXCEPTION 'Monetary values cannot be negative';
  END IF;
  IF v_amount_received > v_final_selling THEN
    RAISE EXCEPTION 'Amount received cannot exceed the selling price';
  END IF;

  IF v_customer_id IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM public.customers
    WHERE id = v_customer_id AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  ELSE
    IF v_new_customer_phone IS NULL OR btrim(v_new_customer_phone) = '' THEN
      RAISE EXCEPTION 'Phone number is required for a new customer';
    END IF;
    v_phone_normalized := public.normalize_phone(v_new_customer_phone);
    IF v_phone_normalized = '' THEN RAISE EXCEPTION 'Invalid phone number'; END IF;
    SELECT id INTO v_customer_id FROM public.customers WHERE phone_normalized = v_phone_normalized;
    IF NOT FOUND THEN
      INSERT INTO public.customers (
        name, phone_normalized, phone_display, email, customer_type, acquisition_source, created_by
      ) VALUES (
        v_new_customer_name, v_phone_normalized, v_new_customer_phone,
        v_new_customer_email, v_new_customer_type, v_new_customer_source, auth.uid()
      ) RETURNING id INTO v_customer_id;
    END IF;
  END IF;

  IF v_is_custom THEN
    v_purchase_type := COALESCE(p_payload->>'purchase_type', 'one_time');
    v_duration_days := NULLIF(p_payload->>'duration_days', '')::integer;
    v_warranty_days := NULLIF(p_payload->>'warranty_days', '')::integer;
    IF v_product_name IS NULL OR btrim(v_product_name) = '' THEN
      RAISE EXCEPTION 'Product name is required';
    END IF;
    IF v_plan_name IS NULL OR btrim(v_plan_name) = '' THEN v_plan_name := 'Custom'; END IF;
  ELSE
    IF v_plan_id IS NULL THEN RAISE EXCEPTION 'A product plan is required'; END IF;
    SELECT * INTO v_plan FROM public.product_plans WHERE id = v_plan_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product plan not found'; END IF;
    v_purchase_type := v_plan.purchase_type;
    v_duration_days := v_plan.duration_days;
    v_warranty_days := v_plan.warranty_days;
    SELECT name INTO v_product_name FROM public.products WHERE id = v_plan.product_id;
    v_plan_name := v_plan.plan_name;
    IF v_list_price IS NULL THEN v_list_price := v_plan.optional_list_price; END IF;
  END IF;

  IF v_amount_received >= v_final_selling AND v_final_selling > 0 THEN
    v_payment_status := 'paid';
  ELSIF v_amount_received > 0 THEN
    v_payment_status := 'partial';
  ELSE
    v_payment_status := 'pending';
  END IF;

  v_sub_start := NULL;
  v_sub_end := NULL;
  v_renewal_date := NULL;
  v_warranty_end := NULL;
  IF v_purchase_type = 'recurring' THEN
    v_sub_start := v_sale_date;
    IF v_duration_days IS NOT NULL THEN
      v_sub_end := v_sale_date + v_duration_days;
      v_renewal_date := v_sub_end;
    END IF;
  END IF;
  IF v_warranty_days IS NOT NULL THEN v_warranty_end := v_sale_date + v_warranty_days; END IF;

  SET LOCAL app.bypass_payment_guard = 'on';
  INSERT INTO public.sales (
    customer_id, product_plan_id, product_name_snapshot, plan_name_snapshot,
    purchase_type_snapshot, duration_days_snapshot, list_price_snapshot, cost_price_snapshot,
    final_selling_price, payment_fee, amount_received,
    sale_date, payment_status, fulfilment_status,
    payment_method, transaction_reference, subscription_start_date, renewal_date,
    warranty_end_date, note, created_by, updated_by
  ) VALUES (
    v_customer_id, v_plan_id, v_product_name, v_plan_name, v_purchase_type,
    v_duration_days, v_list_price, v_cost_price, v_final_selling, v_payment_fee,
    v_amount_received,
    v_sale_date, v_payment_status, v_fulfilment_status, v_payment_method, v_txn_ref,
    v_sub_start, v_renewal_date, v_warranty_end, v_note, auth.uid(), auth.uid()
  ) RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  IF v_amount_received > 0 THEN
    INSERT INTO public.payments (
      sale_id, amount, payment_method, transaction_reference, payment_date, status, created_by
    ) VALUES (
      v_sale_id, v_amount_received, v_payment_method, v_txn_ref, v_sale_date, 'valid', auth.uid()
    ) RETURNING id INTO v_payment_id;
  END IF;

  IF v_purchase_type = 'recurring' THEN
    INSERT INTO public.subscriptions (
      customer_id, original_sale_id, current_sale_id, product_plan_id,
      start_date, end_date, status, next_renewal_date, created_by
    ) VALUES (
      v_customer_id, v_sale_id, v_sale_id, v_plan_id,
      v_sub_start, v_sub_end, 'active', v_renewal_date, auth.uid()
    ) RETURNING id INTO v_sub_id;
    IF v_renewal_date IS NOT NULL THEN
      INSERT INTO public.renewals (subscription_id, customer_id, due_date, status)
      VALUES (v_sub_id, v_customer_id, v_renewal_date, 'pending')
      RETURNING id INTO v_renewal_id;
    END IF;
  END IF;

  PERFORM public.log_activity(
    'sale_create',
    'Created sale ' || v_sale_number || ' for ' || v_product_name || ' - ' || v_plan_name,
    'sale', v_sale_id, NULL,
    jsonb_build_object('sale_number', v_sale_number, 'customer_id', v_customer_id,
      'final_selling_price', v_final_selling, 'payment_status', v_payment_status,
      'amount_received', v_amount_received)
  );

  RETURN jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_number, 'customer_id', v_customer_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_sale(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_sale(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO service_role;

-- =========================================================
-- 11. Internal core_get_reports_summary (date-range, read-only)
-- Uses the same definitions as owner_dashboard_stats but for arbitrary dates.
-- =========================================================
CREATE OR REPLACE FUNCTION internal.core_get_reports_summary(
  p_from date,
  p_to date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_revenue numeric;
  v_cash numeric;
  v_cost numeric;
  v_fees numeric;
  v_refunds numeric;
  v_replacements numeric;
  v_gross numeric;
  v_total_sales integer;
  v_active_customers integer;
  v_pending_payments integer;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'from and to dates are required';
  END IF;
  IF p_to < p_from THEN
    RAISE EXCEPTION 'to date must be on or after from date';
  END IF;
  IF p_to - p_from > 365 THEN
    RAISE EXCEPTION 'Date range cannot exceed 365 days';
  END IF;

  SELECT COALESCE(SUM(final_selling_price), 0) INTO v_revenue
  FROM public.sales
  WHERE sale_date >= p_from AND sale_date <= p_to
    AND payment_status <> 'cancelled'
    AND archived_at IS NULL;

  SELECT COALESCE(SUM(p.amount), 0) INTO v_cash
  FROM public.payments p
  JOIN public.sales s ON s.id = p.sale_id
  WHERE p.payment_date >= p_from AND p.payment_date <= p_to
    AND p.status = 'valid'
    AND s.archived_at IS NULL;

  SELECT COALESCE(SUM(cost_price_snapshot), 0) INTO v_cost
  FROM public.sales
  WHERE sale_date >= p_from AND sale_date <= p_to
    AND payment_status <> 'cancelled'
    AND archived_at IS NULL;

  SELECT COALESCE(SUM(payment_fee), 0) INTO v_fees
  FROM public.sales
  WHERE sale_date >= p_from AND sale_date <= p_to
    AND payment_status <> 'cancelled'
    AND archived_at IS NULL;

  SELECT COALESCE(SUM(refund_amount), 0) INTO v_refunds
  FROM public.sales
  WHERE sale_date >= p_from AND sale_date <= p_to
    AND payment_status <> 'cancelled'
    AND archived_at IS NULL;

  SELECT COALESCE(SUM(replacement_cost), 0) INTO v_replacements
  FROM public.sales
  WHERE sale_date >= p_from AND sale_date <= p_to
    AND payment_status <> 'cancelled'
    AND archived_at IS NULL;

  v_gross := v_revenue - v_cost - v_fees - v_refunds - v_replacements;

  SELECT count(*) INTO v_total_sales
  FROM public.sales
  WHERE sale_date >= p_from AND sale_date <= p_to
    AND archived_at IS NULL;

  SELECT count(DISTINCT customer_id) INTO v_active_customers
  FROM public.sales
  WHERE sale_date >= p_from AND sale_date <= p_to
    AND archived_at IS NULL;

  SELECT count(*) INTO v_pending_payments
  FROM public.sales
  WHERE payment_status IN ('pending','partial')
    AND archived_at IS NULL;

  RETURN jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'revenue', v_revenue,
    'cash_received', v_cash,
    'product_cost', v_cost,
    'payment_fees', v_fees,
    'refunds', v_refunds,
    'replacement_costs', v_replacements,
    'gross_profit', v_gross,
    'total_sales', v_total_sales,
    'active_customers', v_active_customers,
    'pending_payments', v_pending_payments
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION internal.core_get_reports_summary(date, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION internal.core_get_reports_summary(date, date) FROM anon;
REVOKE EXECUTE ON FUNCTION internal.core_get_reports_summary(date, date) FROM authenticated;
GRANT EXECUTE ON FUNCTION internal.core_get_reports_summary(date, date) TO service_role;
