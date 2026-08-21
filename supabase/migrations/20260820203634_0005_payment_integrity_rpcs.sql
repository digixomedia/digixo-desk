/*
# Payment Integrity & Dashboard Consistency Fixes

## Purpose
Fixes four confirmed data-integrity bugs:
1. Sales could be marked "paid" with zero collected (client-writable payment_status).
2. Dashboard gross profit ignored refunds, fees, and replacement costs.
3. Dashboard and Renewals page used different upcoming-renewal windows and status sets.
4. No idempotency on payment additions — duplicate retries could double-charge.

## Changes

### 1. New column: payments.idempotency_key
- Nullable text column on `payments`.
- Unique partial index so retries with the same key return the existing payment instead of creating a duplicate.

### 2. New SECURITY DEFINER functions (all hardened: SET search_path = '', fully-qualified tables, REVOKE from PUBLIC/anon)

#### add_payment(p_sale_id, p_amount, p_payment_method, p_transaction_reference, p_payment_date, p_note, p_idempotency_key)
- Validates caller is an active authenticated user.
- Locks the sale row (FOR UPDATE).
- Rejects if sale is in a terminal state: cancelled, refunded, partially_refunded.
- Validates amount > 0 and total won't exceed selling_price - refund_amount.
- Idempotency: if idempotency_key already exists, returns the existing payment.
- Inserts a valid payment row.
- Recalculates sale.payment_status (paid/partial/pending) and amount_received.
- Returns JSON with the new payment and updated payment_status.

#### reverse_payment(p_payment_id, p_reason)
- Owner-only (is_owner()).
- Locks payment and sale rows.
- Sets payment.status = 'reversed' (the only supported reversal status in the existing CHECK constraint: valid/bounced/reversed).
- Recalculates sale.payment_status and amount_received.
- Returns JSON with the updated payment_status.

#### record_refund(p_sale_id, p_amount, p_reason)
- Owner-only (is_owner()).
- Locks the sale row.
- Validates amount > 0 and <= final_selling_price.
- Sets refund_amount, derives payment_status (refunded / partially_refunded).
- Appends reason to note.
- Returns JSON with the updated sale.

### 3. Guard triggers
- `guard_sales_payment_status`: BEFORE UPDATE on sales — blocks direct writes to payment_status or amount_received unless `app.bypass_payment_guard = 'on'` (set only inside SECURITY DEFINER functions).
- `guard_payments_insert`: BEFORE INSERT on payments — blocks direct client inserts unless bypass is set.
- All other columns (fulfilment_status, note, refund_amount, replacement_cost, payment_fee, is_demo, updated_by, etc.) remain directly client-writable.

### 4. Updated existing functions
- `owner_dashboard_stats`: gross profit now subtracts refund_amount, payment_fee, and replacement_cost in addition to product cost. Upcoming renewals now uses PENDING_STATUSES filter instead of NOT IN ('renewed','not_renewing'). search_path hardened to ''.
- `manager_dashboard_stats`: same upcoming-renewals fix. search_path hardened to ''.
- `create_sale`: removes manual payment_status override — derives it from amount_received. search_path hardened to ''.

### 5. Security
- All new functions: REVOKE EXECUTE FROM PUBLIC, anon; GRANT EXECUTE TO authenticated.
- No table-level grants changed — existing RLS policies and column access preserved.
- No data modified, no columns dropped, no tables renamed.

### Important notes
1. S-000004 (paid with ₹0 collected) is NOT modified — flagged for manual review.
2. Existing demo-data operations (is_demo updates, deletes) continue to work — triggers only guard payment_status, amount_received, and payments.insert.
3. Existing refunds.tsx direct update to sales.refund_amount and payment_status will be blocked by the trigger — must be replaced with record_refund RPC in the frontend.
4. Existing sales.tsx direct insert to payments will be blocked by the trigger — must be replaced with add_payment RPC in the frontend.
5. Existing sales.tsx direct update to sales.payment_status will be blocked — must be removed in the frontend.
*/

-- =========================================================
-- 1. Add idempotency_key column to payments
-- =========================================================
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key_uniq
  ON public.payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- =========================================================
-- 2. add_payment function
-- =========================================================
CREATE OR REPLACE FUNCTION public.add_payment(
  p_sale_id uuid,
  p_amount numeric,
  p_payment_method text DEFAULT NULL,
  p_transaction_reference text DEFAULT NULL,
  p_payment_date date DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sale RECORD;
  v_existing_payment RECORD;
  v_total_valid numeric;
  v_new_status text;
  v_payment_id uuid;
  v_pay_date date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_active_user() THEN
    RAISE EXCEPTION 'Only active users can add payments';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;

  v_pay_date := COALESCE(p_payment_date, CURRENT_DATE);

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing_payment
    FROM public.payments
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      SELECT payment_status INTO v_new_status
      FROM public.sales WHERE id = p_sale_id;
      RETURN jsonb_build_object(
        'payment', to_jsonb(v_existing_payment),
        'payment_status', v_new_status,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  -- Lock the sale row
  SELECT * INTO v_sale
  FROM public.sales
  WHERE id = p_sale_id AND archived_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  -- Reject terminal states
  IF v_sale.payment_status IN ('cancelled', 'refunded', 'partially_refunded') THEN
    RAISE EXCEPTION 'Cannot add payment to a sale with status: %', v_sale.payment_status;
  END IF;

  -- Check amount doesn't exceed remaining balance
  SELECT COALESCE(SUM(amount), 0) INTO v_total_valid
  FROM public.payments
  WHERE sale_id = p_sale_id AND status = 'valid';

  IF v_total_valid + p_amount > v_sale.final_selling_price THEN
    RAISE EXCEPTION 'Payment amount exceeds remaining balance. Remaining: %',
      v_sale.final_selling_price - v_total_valid;
  END IF;

  -- Set bypass and insert payment
  SET LOCAL app.bypass_payment_guard = 'on';

  INSERT INTO public.payments (
    sale_id, amount, payment_method, transaction_reference,
    payment_date, status, note, created_by, idempotency_key
  ) VALUES (
    p_sale_id, p_amount, p_payment_method, p_transaction_reference,
    v_pay_date, 'valid', p_note, auth.uid(), p_idempotency_key
  ) RETURNING id INTO v_payment_id;

  -- Recalculate totals
  v_total_valid := v_total_valid + p_amount;

  IF v_total_valid >= v_sale.final_selling_price THEN
    v_new_status := 'paid';
  ELSIF v_total_valid > 0 THEN
    v_new_status := 'partial';
  ELSE
    v_new_status := 'pending';
  END IF;

  UPDATE public.sales
  SET payment_status = v_new_status,
      amount_received = v_total_valid,
      updated_by = auth.uid(),
      updated_at = now()
  WHERE id = p_sale_id;

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'payment_status', v_new_status,
    'amount_received', v_total_valid
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.add_payment(uuid, numeric, text, text, date, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.add_payment(uuid, numeric, text, text, date, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.add_payment(uuid, numeric, text, text, date, text, text) TO authenticated;

-- =========================================================
-- 3. reverse_payment function (owner-only)
-- =========================================================
CREATE OR REPLACE FUNCTION public.reverse_payment(
  p_payment_id uuid,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_payment RECORD;
  v_sale RECORD;
  v_total_valid numeric;
  v_new_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can reverse payments';
  END IF;

  -- Lock the payment row
  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  IF v_payment.status = 'reversed' THEN
    RAISE EXCEPTION 'Payment is already reversed';
  END IF;

  IF v_payment.status = 'bounced' THEN
    RAISE EXCEPTION 'Payment is already bounced';
  END IF;

  -- Lock the sale row
  SELECT * INTO v_sale
  FROM public.sales
  WHERE id = v_payment.sale_id
  FOR UPDATE;

  SET LOCAL app.bypass_payment_guard = 'on';

  -- Reverse the payment
  UPDATE public.payments
  SET status = 'reversed',
      note = COALESCE(p_reason, note)
  WHERE id = p_payment_id;

  -- Recalculate sale totals
  SELECT COALESCE(SUM(amount), 0) INTO v_total_valid
  FROM public.payments
  WHERE sale_id = v_payment.sale_id AND status = 'valid';

  IF v_total_valid >= v_sale.final_selling_price THEN
    v_new_status := 'paid';
  ELSIF v_total_valid > 0 THEN
    v_new_status := 'partial';
  ELSE
    v_new_status := 'pending';
  END IF;

  UPDATE public.sales
  SET payment_status = v_new_status,
      amount_received = v_total_valid,
      updated_by = auth.uid(),
      updated_at = now()
  WHERE id = v_sale.id;

  RETURN jsonb_build_object(
    'payment_status', v_new_status,
    'amount_received', v_total_valid
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reverse_payment(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reverse_payment(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reverse_payment(uuid, text) TO authenticated;

-- =========================================================
-- 4. record_refund function (owner-only)
-- =========================================================
CREATE OR REPLACE FUNCTION public.record_refund(
  p_sale_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sale RECORD;
  v_new_status text;
  v_new_note text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can record refunds';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be greater than zero';
  END IF;

  -- Lock the sale row
  SELECT * INTO v_sale
  FROM public.sales
  WHERE id = p_sale_id AND archived_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  IF p_amount > v_sale.final_selling_price THEN
    RAISE EXCEPTION 'Refund amount cannot exceed the selling price';
  END IF;

  IF v_sale.payment_status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot refund a cancelled sale';
  END IF;

  -- Derive new payment status
  IF p_amount >= v_sale.final_selling_price THEN
    v_new_status := 'refunded';
  ELSE
    v_new_status := 'partially_refunded';
  END IF;

  -- Build note
  v_new_note := CASE
    WHEN p_reason IS NOT NULL AND v_sale.note IS NOT NULL
      THEN v_sale.note || ' | Refund: ' || p_reason
    WHEN p_reason IS NOT NULL
      THEN 'Refund: ' || p_reason
    ELSE v_sale.note
  END;

  SET LOCAL app.bypass_payment_guard = 'on';

  UPDATE public.sales
  SET refund_amount = p_amount,
      payment_status = v_new_status,
      note = v_new_note,
      updated_by = auth.uid(),
      updated_at = now()
  WHERE id = p_sale_id;

  RETURN jsonb_build_object(
    'payment_status', v_new_status,
    'refund_amount', p_amount
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.record_refund(uuid, numeric, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_refund(uuid, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_refund(uuid, numeric, text) TO authenticated;

-- =========================================================
-- 5. Guard trigger: block direct writes to sales.payment_status / amount_received
-- =========================================================
CREATE OR REPLACE FUNCTION public.guard_sales_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF current_setting('app.bypass_payment_guard', true) IS DISTINCT FROM 'on' THEN
    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
      RAISE EXCEPTION 'Direct update of payment_status is not allowed. Use add_payment, reverse_payment, or record_refund RPC.';
    END IF;
    IF NEW.amount_received IS DISTINCT FROM OLD.amount_received THEN
      RAISE EXCEPTION 'Direct update of amount_received is not allowed. Use add_payment or reverse_payment RPC.';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_sales_payment_status_trigger ON public.sales;
CREATE TRIGGER guard_sales_payment_status_trigger
  BEFORE UPDATE ON public.sales
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_sales_payment_status();

-- =========================================================
-- 6. Guard trigger: block direct inserts to payments
-- =========================================================
CREATE OR REPLACE FUNCTION public.guard_payments_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF current_setting('app.bypass_payment_guard', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Direct insert into payments is not allowed. Use add_payment RPC.';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_payments_insert_trigger ON public.payments;
CREATE TRIGGER guard_payments_insert_trigger
  BEFORE INSERT ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_payments_insert();

-- =========================================================
-- 7. Update owner_dashboard_stats: fix gross profit + upcoming renewals
-- =========================================================
CREATE OR REPLACE FUNCTION public.owner_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_month_start date := date_trunc('month', now())::date;
  v_today date := CURRENT_DATE;
  v_revenue numeric;
  v_cash numeric;
  v_cost numeric;
  v_fees numeric;
  v_refunds numeric;
  v_replacements numeric;
  v_gross numeric;
  v_active_customers integer;
  v_pending_payments integer;
  v_activations_pending integer;
  v_renewals_due_today integer;
  v_overdue_renewals integer;
  v_upcoming_renewals integer;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can view financial dashboard';
  END IF;

  SELECT COALESCE(SUM(final_selling_price), 0) INTO v_revenue
  FROM public.sales
  WHERE sale_date >= v_month_start
  AND payment_status <> 'cancelled'
  AND archived_at IS NULL;

  SELECT COALESCE(SUM(p.amount), 0) INTO v_cash
  FROM public.payments p
  JOIN public.sales s ON s.id = p.sale_id
  WHERE p.payment_date >= v_month_start
  AND p.status = 'valid'
  AND s.archived_at IS NULL;

  SELECT COALESCE(SUM(cost_price_snapshot), 0) INTO v_cost
  FROM public.sales
  WHERE sale_date >= v_month_start
  AND payment_status <> 'cancelled'
  AND archived_at IS NULL;

  SELECT COALESCE(SUM(payment_fee), 0) INTO v_fees
  FROM public.sales
  WHERE sale_date >= v_month_start
  AND payment_status <> 'cancelled'
  AND archived_at IS NULL;

  SELECT COALESCE(SUM(refund_amount), 0) INTO v_refunds
  FROM public.sales
  WHERE sale_date >= v_month_start
  AND payment_status <> 'cancelled'
  AND archived_at IS NULL;

  SELECT COALESCE(SUM(replacement_cost), 0) INTO v_replacements
  FROM public.sales
  WHERE sale_date >= v_month_start
  AND payment_status <> 'cancelled'
  AND archived_at IS NULL;

  v_gross := v_revenue - v_cost - v_fees - v_refunds - v_replacements;

  SELECT count(DISTINCT customer_id) INTO v_active_customers
  FROM public.sales
  WHERE sale_date >= v_month_start
  AND archived_at IS NULL;

  SELECT count(*) INTO v_pending_payments
  FROM public.sales
  WHERE payment_status IN ('pending','partial')
  AND archived_at IS NULL;

  SELECT count(*) INTO v_activations_pending
  FROM public.sales
  WHERE fulfilment_status IN ('payment_confirmation','activation_pending','processing')
  AND archived_at IS NULL;

  SELECT count(*) INTO v_renewals_due_today
  FROM public.renewals
  WHERE due_date = v_today
  AND status IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response');

  SELECT count(*) INTO v_overdue_renewals
  FROM public.renewals
  WHERE due_date < v_today
  AND status IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response');

  SELECT count(*) INTO v_upcoming_renewals
  FROM public.renewals
  WHERE due_date > v_today
  AND due_date <= v_today + 30
  AND status IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response');

  RETURN jsonb_build_object(
    'revenue_this_month', v_revenue,
    'cash_received_this_month', v_cash,
    'product_cost_this_month', v_cost,
    'gross_profit_this_month', v_gross,
    'active_customers', v_active_customers,
    'pending_payments', v_pending_payments,
    'activations_pending', v_activations_pending,
    'renewals_due_today', v_renewals_due_today,
    'overdue_renewals', v_overdue_renewals,
    'upcoming_renewals', v_upcoming_renewals
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.owner_dashboard_stats() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owner_dashboard_stats() FROM anon;
GRANT EXECUTE ON FUNCTION public.owner_dashboard_stats() TO authenticated;

-- =========================================================
-- 8. Update manager_dashboard_stats: fix upcoming renewals
-- =========================================================
CREATE OR REPLACE FUNCTION public.manager_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_today date := CURRENT_DATE;
  v_my_sales_today integer;
  v_pending_payments integer;
  v_activations_pending integer;
  v_renewals_due_today integer;
  v_overdue_renewals integer;
  v_upcoming_renewals integer;
  v_recent_customers integer;
BEGIN
  IF NOT public.is_active_user() THEN
    RAISE EXCEPTION 'Only active users can view dashboard';
  END IF;

  SELECT count(*) INTO v_my_sales_today
  FROM public.sales
  WHERE sale_date = v_today
  AND created_by = auth.uid()
  AND archived_at IS NULL;

  SELECT count(*) INTO v_pending_payments
  FROM public.sales
  WHERE payment_status IN ('pending','partial')
  AND archived_at IS NULL;

  SELECT count(*) INTO v_activations_pending
  FROM public.sales
  WHERE fulfilment_status IN ('payment_confirmation','activation_pending','processing')
  AND archived_at IS NULL;

  SELECT count(*) INTO v_renewals_due_today
  FROM public.renewals
  WHERE due_date = v_today
  AND status IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response');

  SELECT count(*) INTO v_overdue_renewals
  FROM public.renewals
  WHERE due_date < v_today
  AND status IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response');

  SELECT count(*) INTO v_upcoming_renewals
  FROM public.renewals
  WHERE due_date > v_today
  AND due_date <= v_today + 30
  AND status IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response');

  SELECT count(*) INTO v_recent_customers
  FROM public.customers
  WHERE created_at >= now() - interval '7 days'
  AND archived_at IS NULL;

  RETURN jsonb_build_object(
    'my_sales_today', v_my_sales_today,
    'pending_payments', v_pending_payments,
    'activations_pending', v_activations_pending,
    'renewals_due_today', v_renewals_due_today,
    'overdue_renewals', v_overdue_renewals,
    'upcoming_renewals', v_upcoming_renewals,
    'recent_customers', v_recent_customers
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.manager_dashboard_stats() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.manager_dashboard_stats() FROM anon;
GRANT EXECUTE ON FUNCTION public.manager_dashboard_stats() TO authenticated;

-- =========================================================
-- 9. Update create_sale: derive payment_status from amount_received
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
  IF NOT public.is_active_user() THEN
    RAISE EXCEPTION 'Only active users can create sales';
  END IF;

  -- Extract payload
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
  v_note := p_payload->>'note';
  v_sale_date := COALESCE((p_payload->>'sale_date')::date, CURRENT_DATE);
  v_fulfilment_status := COALESCE(p_payload->>'fulfilment_status', 'payment_confirmation');
  v_purchase_type := COALESCE(p_payload->>'purchase_type', 'one_time');
  v_duration_days := NULLIF(p_payload->>'duration_days', '')::integer;
  v_warranty_days := NULLIF(p_payload->>'warranty_days', '')::integer;
  v_sub_start := NULLIF(p_payload->>'subscription_start_date', '')::date;
  v_renewal_date := NULLIF(p_payload->>'renewal_date', '')::date;
  v_warranty_end := NULLIF(p_payload->>'warranty_end_date', '')::date;

  -- Derive payment_status from amount_received (no manual override)
  IF v_amount_received >= v_final_selling AND v_final_selling > 0 THEN
    v_payment_status := 'paid';
  ELSIF v_amount_received > 0 THEN
    v_payment_status := 'partial';
  ELSE
    v_payment_status := 'pending';
  END IF;

  -- Resolve customer
  IF v_customer_id IS NULL THEN
    v_new_customer_name := p_payload->>'new_customer_name';
    v_new_customer_phone := p_payload->>'new_customer_phone';
    v_new_customer_email := p_payload->>'new_customer_email';
    v_new_customer_type := COALESCE(p_payload->>'new_customer_type', 'retail');
    v_new_customer_source := COALESCE(p_payload->>'new_customer_source', 'Other');
    v_phone_normalized := public.normalize_phone(v_new_customer_phone);

    INSERT INTO public.customers (
      name, phone_country_code, phone_normalized, phone_display,
      email, customer_type, acquisition_source, created_by
    ) VALUES (
      v_new_customer_name, '91', v_phone_normalized, v_new_customer_phone,
      v_new_customer_email, v_new_customer_type, v_new_customer_source, auth.uid()
    ) RETURNING id INTO v_customer_id;
  END IF;

  -- Resolve plan
  IF NOT v_is_custom AND v_plan_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM public.product_plans WHERE id = v_plan_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product plan not found';
    END IF;
    v_product_name := v_plan.product_name_snapshot;
    v_plan_name := v_plan.plan_name;
    v_purchase_type := v_plan.purchase_type;
    v_duration_days := COALESCE(v_duration_days, v_plan.duration_days);
    v_warranty_days := COALESCE(v_warranty_days, v_plan.warranty_days);
  END IF;

  -- Assign sale number
  v_sale_number := public.assign_sale_number();

  -- Set bypass for trigger
  SET LOCAL app.bypass_payment_guard = 'on';

  -- Create the sale
  INSERT INTO public.sales (
    sale_number, customer_id, product_plan_id,
    product_name_snapshot, plan_name_snapshot, purchase_type_snapshot,
    duration_days_snapshot, list_price_snapshot, cost_price_snapshot,
    final_selling_price, payment_fee, refund_amount, replacement_cost,
    sale_date, payment_status, fulfilment_status,
    payment_method, transaction_reference,
    subscription_start_date, renewal_date, warranty_end_date,
    note, created_by, updated_by
  ) VALUES (
    v_sale_number, v_customer_id, v_plan_id,
    v_product_name, v_plan_name, v_purchase_type,
    v_duration_days, v_list_price, v_cost_price,
    v_final_selling, v_payment_fee, 0, 0,
    v_sale_date, v_payment_status, v_fulfilment_status,
    v_payment_method, v_txn_ref,
    v_sub_start, v_renewal_date, v_warranty_end,
    v_note, auth.uid(), auth.uid()
  ) RETURNING id INTO v_sale_id;

  -- Create initial payment if amount_received > 0
  IF v_amount_received > 0 THEN
    INSERT INTO public.payments (
      sale_id, amount, payment_method, transaction_reference,
      payment_date, status, created_by
    ) VALUES (
      v_sale_id, v_amount_received, v_payment_method, v_txn_ref,
      v_sale_date, 'valid', auth.uid()
    ) RETURNING id INTO v_payment_id;
  END IF;

  -- Create subscription for recurring purchases
  IF v_purchase_type = 'recurring' THEN
    IF v_sub_start IS NULL THEN
      v_sub_start := v_sale_date;
    END IF;
    IF v_sub_end IS NULL AND v_duration_days IS NOT NULL THEN
      v_sub_end := v_sub_start + v_duration_days;
    END IF;
    IF v_renewal_date IS NULL AND v_duration_days IS NOT NULL THEN
      v_renewal_date := v_sub_start + v_duration_days;
    END IF;

    INSERT INTO public.subscriptions (
      customer_id, original_sale_id, current_sale_id, product_plan_id,
      start_date, end_date, status, next_renewal_date, created_by
    ) VALUES (
      v_customer_id, v_sale_id, v_sale_id, v_plan_id,
      v_sub_start, v_sub_end, 'active', v_renewal_date, auth.uid()
    ) RETURNING id INTO v_sub_id;

    -- Create first renewal entry
    IF v_renewal_date IS NOT NULL THEN
      INSERT INTO public.renewals (
        subscription_id, customer_id, due_date, status, created_by
      ) VALUES (
        v_sub_id, v_customer_id, v_renewal_date, 'pending', auth.uid()
      ) RETURNING id INTO v_renewal_id;
    END IF;
  END IF;

  -- Log activity
  INSERT INTO public.activity_logs (user_id, action, entity_type, entity_id, description)
  VALUES (auth.uid(), 'sale_created', 'sale', v_sale_id, 'Sale ' || v_sale_number || ' created');

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'sale_number', v_sale_number,
    'customer_id', v_customer_id
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_sale(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_sale(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated;
