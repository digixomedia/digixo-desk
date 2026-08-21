/*
# DigiXO Desk API — Phase 2B: Shared Transaction Core and Write Endpoints
(Fixed parameter ordering: all non-defaulted params before defaulted ones)
*/

-- =========================================================
-- 1. Idempotency records table
-- =========================================================
CREATE TABLE IF NOT EXISTS internal.api_idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_body jsonb,
  response_status integer,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE internal.api_idempotency_records ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_api_idempotency_integration_key
  ON internal.api_idempotency_records (integration_id, endpoint, idempotency_key);
REVOKE ALL ON internal.api_idempotency_records FROM PUBLIC;
REVOKE ALL ON internal.api_idempotency_records FROM anon;
REVOKE ALL ON internal.api_idempotency_records FROM authenticated;

-- =========================================================
-- 2. internal.core_create_sale
-- =========================================================
CREATE OR REPLACE FUNCTION internal.core_create_sale(
  p_payload jsonb,
  p_actor_id uuid,
  p_created_via_api_key_id uuid DEFAULT NULL,
  p_created_via_integration_id uuid DEFAULT NULL,
  p_sale_source text DEFAULT NULL,
  p_external_reference text DEFAULT NULL,
  p_salesperson_id uuid DEFAULT NULL,
  p_salesperson_name text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_idempotency_endpoint text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_customer_id uuid; v_plan_id uuid; v_plan RECORD;
  v_sale_id uuid; v_sale_number text; v_payment_id uuid;
  v_sub_id uuid; v_renewal_id uuid;
  v_amount_received numeric; v_final_selling numeric; v_cost_price numeric;
  v_payment_status text; v_fulfilment_status text; v_purchase_type text;
  v_duration_days integer; v_warranty_days integer;
  v_sub_start date; v_sub_end date; v_renewal_date date; v_warranty_end date;
  v_is_custom boolean; v_product_name text; v_plan_name text;
  v_list_price numeric; v_payment_fee numeric;
  v_payment_method text; v_txn_ref text; v_note text; v_sale_date date;
  v_new_customer_name text; v_new_customer_phone text; v_new_customer_email text;
  v_new_customer_type text; v_new_customer_source text; v_phone_normalized text;
  v_idem_id uuid; v_idem_row RECORD; v_request_hash text; v_result jsonb;
BEGIN
  IF p_idempotency_key IS NOT NULL AND p_idempotency_endpoint IS NOT NULL THEN
    v_request_hash := encode(digest(convert_to(jsonb_build_object('endpoint',p_idempotency_endpoint,'payload',p_payload)::text,'UTF8'),'sha256'),'hex');
    INSERT INTO internal.api_idempotency_records (integration_id,api_key_id,endpoint,idempotency_key,request_hash,state)
    VALUES (p_created_via_integration_id,p_created_via_api_key_id,p_idempotency_endpoint,p_idempotency_key,v_request_hash,'pending')
    ON CONFLICT (integration_id,endpoint,idempotency_key) DO NOTHING RETURNING id INTO v_idem_id;
    IF v_idem_id IS NULL THEN
      SELECT response_body,request_hash,response_status,state INTO v_idem_row
      FROM internal.api_idempotency_records
      WHERE integration_id=p_created_via_integration_id AND endpoint=p_idempotency_endpoint AND idempotency_key=p_idempotency_key FOR UPDATE;
      IF v_idem_row.state='completed' THEN
        IF v_idem_row.request_hash=v_request_hash THEN
          RETURN jsonb_build_object('sale_id',(v_idem_row.response_body->>'sale_id')::uuid,'sale_number',v_idem_row.response_body->>'sale_number','customer_id',(v_idem_row.response_body->>'customer_id')::uuid,'idempotent_replay',true);
        ELSE RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Idempotency key already used with a different payload';
        END IF;
      END IF;
    END IF;
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

  IF p_sale_source IS NOT NULL AND p_sale_source NOT IN ('WhatsApp','Telegram','Website','Referral','Reseller','Other') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: Invalid sale_source';
  END IF;
  IF v_final_selling < 0 OR v_cost_price < 0 OR v_payment_fee < 0 OR v_amount_received < 0 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: Monetary values cannot be negative';
  END IF;
  IF v_amount_received > v_final_selling THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: Amount received cannot exceed the selling price';
  END IF;

  IF v_customer_id IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM public.customers WHERE id=v_customer_id AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: Customer not found'; END IF;
  ELSE
    IF v_new_customer_phone IS NULL OR btrim(v_new_customer_phone) = '' THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: Phone number is required for a new customer';
    END IF;
    v_phone_normalized := public.normalize_phone(v_new_customer_phone);
    IF v_phone_normalized = '' THEN RAISE EXCEPTION 'VALIDATION_ERROR: Invalid phone number'; END IF;
    SELECT id INTO v_customer_id FROM public.customers WHERE phone_normalized = v_phone_normalized;
    IF NOT FOUND THEN
      INSERT INTO public.customers (name,phone_normalized,phone_display,email,customer_type,acquisition_source,created_by)
      VALUES (v_new_customer_name,v_phone_normalized,v_new_customer_phone,v_new_customer_email,v_new_customer_type,v_new_customer_source,p_actor_id)
      RETURNING id INTO v_customer_id;
    END IF;
  END IF;

  IF v_is_custom THEN
    v_purchase_type := COALESCE(p_payload->>'purchase_type', 'one_time');
    v_duration_days := NULLIF(p_payload->>'duration_days', '')::integer;
    v_warranty_days := NULLIF(p_payload->>'warranty_days', '')::integer;
    IF v_product_name IS NULL OR btrim(v_product_name) = '' THEN RAISE EXCEPTION 'VALIDATION_ERROR: Product name is required'; END IF;
    IF v_plan_name IS NULL OR btrim(v_plan_name) = '' THEN v_plan_name := 'Custom'; END IF;
  ELSE
    IF v_plan_id IS NULL THEN RAISE EXCEPTION 'VALIDATION_ERROR: A product plan is required'; END IF;
    SELECT * INTO v_plan FROM public.product_plans WHERE id = v_plan_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: Product plan not found'; END IF;
    v_purchase_type := v_plan.purchase_type;
    v_duration_days := v_plan.duration_days;
    v_warranty_days := v_plan.warranty_days;
    v_cost_price := v_plan.default_cost_price;
    SELECT name INTO v_product_name FROM public.products WHERE id = v_plan.product_id;
    v_plan_name := v_plan.plan_name;
    IF v_list_price IS NULL THEN v_list_price := v_plan.optional_list_price; END IF;
  END IF;

  IF v_amount_received >= v_final_selling AND v_final_selling > 0 THEN v_payment_status := 'paid';
  ELSIF v_amount_received > 0 THEN v_payment_status := 'partial';
  ELSE v_payment_status := 'pending'; END IF;

  v_sub_start := NULL; v_sub_end := NULL; v_renewal_date := NULL; v_warranty_end := NULL;
  IF v_purchase_type = 'recurring' THEN
    v_sub_start := v_sale_date;
    IF v_duration_days IS NOT NULL THEN v_sub_end := v_sale_date + v_duration_days; v_renewal_date := v_sub_end; END IF;
  END IF;
  IF v_warranty_days IS NOT NULL THEN v_warranty_end := v_sale_date + v_warranty_days; END IF;

  SET LOCAL app.bypass_payment_guard = 'on';
  INSERT INTO public.sales (
    customer_id,product_plan_id,product_name_snapshot,plan_name_snapshot,
    purchase_type_snapshot,duration_days_snapshot,list_price_snapshot,cost_price_snapshot,
    final_selling_price,payment_fee,amount_received,
    sale_date,payment_status,fulfilment_status,
    payment_method,transaction_reference,subscription_start_date,renewal_date,
    warranty_end_date,note,created_by,updated_by,
    sale_source,external_reference,salesperson_id,salesperson_name,
    created_via_api_key_id,created_via_integration_id
  ) VALUES (
    v_customer_id,v_plan_id,v_product_name,v_plan_name,v_purchase_type,
    v_duration_days,v_list_price,v_cost_price,v_final_selling,v_payment_fee,v_amount_received,
    v_sale_date,v_payment_status,v_fulfilment_status,v_payment_method,v_txn_ref,
    v_sub_start,v_renewal_date,v_warranty_end,v_note,p_actor_id,p_actor_id,
    p_sale_source,p_external_reference,p_salesperson_id,p_salesperson_name,
    p_created_via_api_key_id,p_created_via_integration_id
  ) RETURNING id,sale_number INTO v_sale_id,v_sale_number;

  IF v_amount_received > 0 THEN
    INSERT INTO public.payments (sale_id,amount,payment_method,transaction_reference,payment_date,status,created_by)
    VALUES (v_sale_id,v_amount_received,v_payment_method,v_txn_ref,v_sale_date,'valid',p_actor_id) RETURNING id INTO v_payment_id;
  END IF;

  IF v_purchase_type = 'recurring' THEN
    INSERT INTO public.subscriptions (customer_id,original_sale_id,current_sale_id,product_plan_id,start_date,end_date,status,next_renewal_date,created_by)
    VALUES (v_customer_id,v_sale_id,v_sale_id,v_plan_id,v_sub_start,v_sub_end,'active',v_renewal_date,p_actor_id) RETURNING id INTO v_sub_id;
    IF v_renewal_date IS NOT NULL THEN
      INSERT INTO public.renewals (subscription_id,customer_id,due_date,status)
      VALUES (v_sub_id,v_customer_id,v_renewal_date,'pending') RETURNING id INTO v_renewal_id;
    END IF;
  END IF;

  PERFORM internal.core_log_activity(p_actor_id,'sale_create',
    'Created sale '||v_sale_number||' for '||v_product_name||' - '||v_plan_name,
    'sale',v_sale_id,NULL,
    jsonb_build_object('sale_number',v_sale_number,'customer_id',v_customer_id,'final_selling_price',v_final_selling,'payment_status',v_payment_status,'amount_received',v_amount_received));

  v_result := jsonb_build_object('sale_id',v_sale_id,'sale_number',v_sale_number,'customer_id',v_customer_id);
  IF v_idem_id IS NOT NULL THEN
    UPDATE internal.api_idempotency_records SET state='completed',response_body=v_result,response_status=201,completed_at=now() WHERE id=v_idem_id;
  END IF;
  RETURN v_result;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_EXTERNAL_REFERENCE: An order with this external reference already exists for this integration';
  WHEN OTHERS THEN
    IF SQLERRM LIKE '%:%' AND (SQLERRM LIKE 'NOT_FOUND:%' OR SQLERRM LIKE 'VALIDATION_ERROR:%' OR SQLERRM LIKE 'IDEMPOTENCY_CONFLICT:%' OR SQLERRM LIKE 'DUPLICATE_EXTERNAL_REFERENCE:%' OR SQLERRM LIKE 'BUSINESS_RULE_ERROR:%') THEN RAISE;
    ELSE RAISE EXCEPTION 'BUSINESS_RULE_ERROR: %', SQLERRM; END IF;
END;
$function$;
REVOKE EXECUTE ON FUNCTION internal.core_create_sale(jsonb, uuid, uuid, uuid, text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION internal.core_create_sale(jsonb, uuid, uuid, uuid, text, text, uuid, text, text, text) TO service_role;

-- =========================================================
-- 3. internal.core_add_payment
-- =========================================================
CREATE OR REPLACE FUNCTION internal.core_add_payment(
  p_sale_id uuid,
  p_amount numeric,
  p_actor_id uuid,
  p_payment_method text DEFAULT NULL,
  p_transaction_reference text DEFAULT NULL,
  p_payment_date date DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_created_via_api_key_id uuid DEFAULT NULL,
  p_created_via_integration_id uuid DEFAULT NULL,
  p_api_idempotency_key text DEFAULT NULL,
  p_api_idempotency_endpoint text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sale RECORD; v_existing_payment RECORD;
  v_total_valid numeric; v_new_status text; v_payment_id uuid; v_pay_date date;
  v_namespaced_key text; v_idem_id uuid; v_idem_row RECORD; v_request_hash text; v_result jsonb;
BEGIN
  IF p_api_idempotency_key IS NOT NULL AND p_api_idempotency_endpoint IS NOT NULL THEN
    v_request_hash := encode(digest(convert_to(jsonb_build_object('endpoint',p_api_idempotency_endpoint,'sale_id',p_sale_id,'amount',p_amount,'payment_method',p_payment_method,'transaction_reference',p_transaction_reference,'payment_date',p_payment_date,'note',p_note)::text,'UTF8'),'sha256'),'hex');
    INSERT INTO internal.api_idempotency_records (integration_id,api_key_id,endpoint,idempotency_key,request_hash,state)
    VALUES (p_created_via_integration_id,p_created_via_api_key_id,p_api_idempotency_endpoint,p_api_idempotency_key,v_request_hash,'pending')
    ON CONFLICT (integration_id,endpoint,idempotency_key) DO NOTHING RETURNING id INTO v_idem_id;
    IF v_idem_id IS NULL THEN
      SELECT response_body,request_hash,response_status,state INTO v_idem_row
      FROM internal.api_idempotency_records
      WHERE integration_id=p_created_via_integration_id AND endpoint=p_api_idempotency_endpoint AND idempotency_key=p_api_idempotency_key FOR UPDATE;
      IF v_idem_row.state='completed' THEN
        IF v_idem_row.request_hash=v_request_hash THEN
          RETURN jsonb_set(v_idem_row.response_body,'{idempotent_replay}','true'::jsonb);
        ELSE RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Idempotency key already used with a different payload';
        END IF;
      END IF;
    END IF;
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'VALIDATION_ERROR: Payment amount must be greater than zero'; END IF;
  v_pay_date := COALESCE(p_payment_date, CURRENT_DATE);

  IF p_created_via_integration_id IS NOT NULL AND p_api_idempotency_key IS NOT NULL THEN
    v_namespaced_key := p_created_via_integration_id::text || ':' || p_api_idempotency_endpoint || ':' || p_api_idempotency_key;
  ELSE v_namespaced_key := p_idempotency_key; END IF;

  IF v_namespaced_key IS NOT NULL THEN
    SELECT * INTO v_existing_payment FROM public.payments WHERE idempotency_key = v_namespaced_key;
    IF FOUND THEN
      IF v_existing_payment.sale_id <> p_sale_id OR v_existing_payment.amount <> p_amount
         OR v_existing_payment.payment_method IS DISTINCT FROM p_payment_method
         OR v_existing_payment.transaction_reference IS DISTINCT FROM p_transaction_reference
         OR v_existing_payment.payment_date <> v_pay_date THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: This idempotency key was already used for a different payment';
      END IF;
      SELECT payment_status INTO v_new_status FROM public.sales WHERE id = p_sale_id;
      SELECT amount_received INTO v_total_valid FROM public.sales WHERE id = p_sale_id;
      v_result := jsonb_build_object('payment',to_jsonb(v_existing_payment),'payment_status',v_new_status,'amount_received',v_total_valid,'idempotent_replay',true);
      IF v_idem_id IS NOT NULL THEN
        UPDATE internal.api_idempotency_records SET state='completed',response_body=v_result,response_status=201,completed_at=now() WHERE id=v_idem_id;
      END IF;
      RETURN v_result;
    END IF;
  END IF;

  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: Sale not found'; END IF;
  IF v_sale.payment_status IN ('cancelled','refunded','partially_refunded') THEN
    RAISE EXCEPTION 'BUSINESS_RULE_ERROR: Cannot add payment to a terminal sale';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_total_valid FROM public.payments WHERE sale_id = p_sale_id AND status = 'valid';
  IF v_total_valid + p_amount > v_sale.final_selling_price - COALESCE(v_sale.refund_amount, 0) THEN
    RAISE EXCEPTION 'BUSINESS_RULE_ERROR: Payment amount exceeds the remaining balance';
  END IF;

  SET LOCAL app.bypass_payment_guard = 'on';
  INSERT INTO public.payments (sale_id,amount,payment_method,transaction_reference,payment_date,status,note,created_by,idempotency_key)
  VALUES (p_sale_id,p_amount,p_payment_method,p_transaction_reference,v_pay_date,'valid',p_note,p_actor_id,v_namespaced_key)
  ON CONFLICT (idempotency_key) DO NOTHING RETURNING id INTO v_payment_id;

  IF v_payment_id IS NULL THEN
    SELECT * INTO v_existing_payment FROM public.payments WHERE idempotency_key = v_namespaced_key;
    SELECT payment_status INTO v_new_status FROM public.sales WHERE id = p_sale_id;
    SELECT amount_received INTO v_total_valid FROM public.sales WHERE id = p_sale_id;
    v_result := jsonb_build_object('payment',to_jsonb(v_existing_payment),'payment_status',v_new_status,'amount_received',v_total_valid,'idempotent_replay',true);
    IF v_idem_id IS NOT NULL THEN
      UPDATE internal.api_idempotency_records SET state='completed',response_body=v_result,response_status=201,completed_at=now() WHERE id=v_idem_id;
    END IF;
    RETURN v_result;
  END IF;

  v_total_valid := v_total_valid + p_amount;
  IF v_total_valid >= v_sale.final_selling_price THEN v_new_status := 'paid';
  ELSIF v_total_valid > 0 THEN v_new_status := 'partial';
  ELSE v_new_status := 'pending'; END IF;

  UPDATE public.sales SET payment_status=v_new_status,amount_received=v_total_valid,updated_by=p_actor_id,updated_at=now() WHERE id=p_sale_id;

  PERFORM internal.core_log_activity(p_actor_id,'payment_added',
    'Payment of '||p_amount||' added to sale '||v_sale.sale_number,
    'payment',v_payment_id,NULL,
    jsonb_build_object('sale_id',p_sale_id,'amount',p_amount,'payment_status',v_new_status));

  v_result := jsonb_build_object('payment_id',v_payment_id,'payment_status',v_new_status,'amount_received',v_total_valid,'idempotent_replay',false);
  IF v_idem_id IS NOT NULL THEN
    UPDATE internal.api_idempotency_records SET state='completed',response_body=v_result,response_status=201,completed_at=now() WHERE id=v_idem_id;
  END IF;
  RETURN v_result;
EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM LIKE '%:%' AND (SQLERRM LIKE 'NOT_FOUND:%' OR SQLERRM LIKE 'VALIDATION_ERROR:%' OR SQLERRM LIKE 'IDEMPOTENCY_CONFLICT:%' OR SQLERRM LIKE 'DUPLICATE_EXTERNAL_REFERENCE:%' OR SQLERRM LIKE 'BUSINESS_RULE_ERROR:%') THEN RAISE;
    ELSE RAISE EXCEPTION 'BUSINESS_RULE_ERROR: %', SQLERRM; END IF;
END;
$function$;
REVOKE EXECUTE ON FUNCTION internal.core_add_payment(uuid, numeric, uuid, text, text, date, text, text, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION internal.core_add_payment(uuid, numeric, uuid, text, text, date, text, text, uuid, uuid, text, text) TO service_role;

-- =========================================================
-- 4. internal.core_create_customer
-- =========================================================
CREATE OR REPLACE FUNCTION internal.core_create_customer(
  p_name text,
  p_phone text,
  p_actor_id uuid,
  p_email text DEFAULT NULL,
  p_customer_type text DEFAULT 'retail',
  p_acquisition_source text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_customer_id uuid; v_phone_normalized text;
BEGIN
  IF p_phone IS NULL OR btrim(p_phone) = '' THEN RAISE EXCEPTION 'VALIDATION_ERROR: Phone number is required'; END IF;
  v_phone_normalized := public.normalize_phone(p_phone);
  IF v_phone_normalized = '' THEN RAISE EXCEPTION 'VALIDATION_ERROR: Invalid phone number'; END IF;
  SELECT id INTO v_customer_id FROM public.customers WHERE phone_normalized = v_phone_normalized;
  IF FOUND THEN RETURN jsonb_build_object('customer_id',v_customer_id,'created',false); END IF;
  INSERT INTO public.customers (name,phone_normalized,phone_display,email,customer_type,acquisition_source,created_by)
  VALUES (p_name,v_phone_normalized,p_phone,p_email,p_customer_type,p_acquisition_source,p_actor_id) RETURNING id INTO v_customer_id;
  PERFORM internal.core_log_activity(p_actor_id,'customer_created','Created customer '||COALESCE(p_name,v_phone_normalized),'customer',v_customer_id,NULL,jsonb_build_object('phone',v_phone_normalized,'customer_type',p_customer_type));
  RETURN jsonb_build_object('customer_id',v_customer_id,'created',true);
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%:%' AND (SQLERRM LIKE 'NOT_FOUND:%' OR SQLERRM LIKE 'VALIDATION_ERROR:%' OR SQLERRM LIKE 'BUSINESS_RULE_ERROR:%') THEN RAISE;
  ELSE RAISE EXCEPTION 'BUSINESS_RULE_ERROR: %', SQLERRM; END IF;
END;
$function$;
REVOKE EXECUTE ON FUNCTION internal.core_create_customer(text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION internal.core_create_customer(text, text, uuid, text, text, text) TO service_role;

-- =========================================================
-- 5. internal.core_update_customer
-- =========================================================
CREATE OR REPLACE FUNCTION internal.core_update_customer(
  p_customer_id uuid, p_fields jsonb, p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_customer RECORD; v_update_fields jsonb := '{}'::jsonb; v_field text;
BEGIN
  SELECT * INTO v_customer FROM public.customers WHERE id=p_customer_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: Customer not found'; END IF;
  FOR v_field IN SELECT key FROM jsonb_object_keys(p_fields) LOOP
    IF v_field IN ('name','email','customer_type','tags','internal_note','marketing_allowed','do_not_message') THEN
      v_update_fields := v_update_fields || jsonb_build_object(v_field, p_fields->v_field);
    END IF;
  END LOOP;
  IF v_update_fields = '{}'::jsonb THEN RAISE EXCEPTION 'VALIDATION_ERROR: No updatable fields provided'; END IF;
  IF v_update_fields ? 'customer_type' AND NOT (v_update_fields->>'customer_type' IN ('retail','reseller','business')) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: Invalid customer_type';
  END IF;
  UPDATE public.customers SET
    name=COALESCE(v_update_fields->>'name',name),
    email=CASE WHEN v_update_fields ? 'email' THEN v_update_fields->>'email' ELSE email END,
    customer_type=COALESCE(v_update_fields->>'customer_type',customer_type),
    tags=CASE WHEN v_update_fields ? 'tags' THEN (v_update_fields->'tags') ELSE tags END,
    internal_note=CASE WHEN v_update_fields ? 'internal_note' THEN v_update_fields->>'internal_note' ELSE internal_note END,
    marketing_allowed=COALESCE((v_update_fields->>'marketing_allowed')::boolean,marketing_allowed),
    do_not_message=COALESCE((v_update_fields->>'do_not_message')::boolean,do_not_message),
    updated_at=now()
  WHERE id=p_customer_id
  RETURNING id,name,phone_display,email,customer_type,tags,internal_note,marketing_allowed,do_not_message,created_at INTO v_customer;
  PERFORM internal.core_log_activity(p_actor_id,'customer_updated','Updated customer '||COALESCE(v_customer.name,p_customer_id::text),'customer',p_customer_id,NULL,v_update_fields);
  RETURN jsonb_build_object('customer',to_jsonb(v_customer));
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%:%' AND (SQLERRM LIKE 'NOT_FOUND:%' OR SQLERRM LIKE 'VALIDATION_ERROR:%' OR SQLERRM LIKE 'BUSINESS_RULE_ERROR:%') THEN RAISE;
  ELSE RAISE EXCEPTION 'BUSINESS_RULE_ERROR: %', SQLERRM; END IF;
END;
$function$;
REVOKE EXECUTE ON FUNCTION internal.core_update_customer(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION internal.core_update_customer(uuid, jsonb, uuid) TO service_role;

-- =========================================================
-- 6. internal.core_update_fulfilment
-- =========================================================
CREATE OR REPLACE FUNCTION internal.core_update_fulfilment(
  p_sale_id uuid, p_fulfilment_status text, p_actor_id uuid, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_sale RECORD;
BEGIN
  IF p_fulfilment_status NOT IN ('payment_confirmation','activation_pending','processing','activated','replacement_required','completed') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: Invalid fulfilment status. Allowed: payment_confirmation, activation_pending, processing, activated, replacement_required, completed';
  END IF;
  SELECT id,sale_number,fulfilment_status INTO v_sale FROM public.sales WHERE id=p_sale_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: Sale not found'; END IF;
  UPDATE public.sales SET fulfilment_status=p_fulfilment_status,
    note=CASE WHEN p_note IS NOT NULL THEN p_note ELSE note END,
    updated_by=p_actor_id,updated_at=now()
  WHERE id=p_sale_id RETURNING id,sale_number,fulfilment_status INTO v_sale;
  PERFORM internal.core_log_activity(p_actor_id,'fulfilment_updated','Fulfilment status updated to '||p_fulfilment_status||' for sale '||v_sale.sale_number,'sale',p_sale_id,NULL,jsonb_build_object('fulfilment_status',p_fulfilment_status));
  RETURN jsonb_build_object('sale',jsonb_build_object('id',v_sale.id,'sale_number',v_sale.sale_number,'fulfilment_status',v_sale.fulfilment_status));
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%:%' AND (SQLERRM LIKE 'NOT_FOUND:%' OR SQLERRM LIKE 'VALIDATION_ERROR:%' OR SQLERRM LIKE 'BUSINESS_RULE_ERROR:%') THEN RAISE;
  ELSE RAISE EXCEPTION 'BUSINESS_RULE_ERROR: %', SQLERRM; END IF;
END;
$function$;
REVOKE EXECUTE ON FUNCTION internal.core_update_fulfilment(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION internal.core_update_fulfilment(uuid, text, uuid, text) TO service_role;

-- =========================================================
-- 7. internal.core_update_renewal
-- =========================================================
CREATE OR REPLACE FUNCTION internal.core_update_renewal(
  p_renewal_id uuid, p_actor_id uuid, p_status text DEFAULT NULL, p_snoozed_until date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_renewal RECORD;
BEGIN
  IF p_status IS NULL AND p_snoozed_until IS NULL AND p_note IS NULL THEN RAISE EXCEPTION 'VALIDATION_ERROR: No updatable fields provided'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: Invalid renewal status. Allowed: pending, reminded, interested, awaiting_payment, snoozed, no_response';
  END IF;
  IF p_status = 'snoozed' AND p_snoozed_until IS NULL THEN RAISE EXCEPTION 'VALIDATION_ERROR: snoozed_until is required when status is snoozed'; END IF;
  SELECT * INTO v_renewal FROM public.renewals WHERE id=p_renewal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: Renewal not found'; END IF;
  UPDATE public.renewals SET status=COALESCE(p_status,status),
    snoozed_until=CASE WHEN p_status='snoozed' THEN p_snoozed_until WHEN p_status IS NOT NULL AND p_status<>'snoozed' THEN NULL ELSE COALESCE(p_snoozed_until,snoozed_until) END,
    note=COALESCE(p_note,note),updated_at=now()
  WHERE id=p_renewal_id RETURNING id,customer_id,subscription_id,due_date,status,snoozed_until,note INTO v_renewal;
  PERFORM internal.core_log_activity(p_actor_id,'renewal_updated','Renewal status updated to '||COALESCE(p_status,v_renewal.status)||' for renewal '||p_renewal_id,'renewal',p_renewal_id,NULL,jsonb_build_object('status',p_status,'snoozed_until',p_snoozed_until));
  RETURN jsonb_build_object('renewal',to_jsonb(v_renewal));
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%:%' AND (SQLERRM LIKE 'NOT_FOUND:%' OR SQLERRM LIKE 'VALIDATION_ERROR:%' OR SQLERRM LIKE 'BUSINESS_RULE_ERROR:%') THEN RAISE;
  ELSE RAISE EXCEPTION 'BUSINESS_RULE_ERROR: %', SQLERRM; END IF;
END;
$function$;
REVOKE EXECUTE ON FUNCTION internal.core_update_renewal(uuid, uuid, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION internal.core_update_renewal(uuid, uuid, text, date, text) TO service_role;

-- =========================================================
-- 8. Refactor public.create_sale
-- =========================================================
CREATE OR REPLACE FUNCTION public.create_sale(p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN RAISE EXCEPTION 'BUSINESS_RULE_ERROR: Only active users can create sales'; END IF;
  RETURN internal.core_create_sale(p_payload, auth.uid());
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.create_sale(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated, service_role;

-- =========================================================
-- 9. Refactor public.add_payment
-- =========================================================
CREATE OR REPLACE FUNCTION public.add_payment(
  p_sale_id uuid, p_amount numeric, p_payment_method text DEFAULT NULL,
  p_transaction_reference text DEFAULT NULL, p_payment_date date DEFAULT NULL,
  p_note text DEFAULT NULL, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN RAISE EXCEPTION 'BUSINESS_RULE_ERROR: Only active users can add payments'; END IF;
  RETURN internal.core_add_payment(p_sale_id, p_amount, auth.uid(), p_payment_method, p_transaction_reference, p_payment_date, p_note, p_idempotency_key);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.add_payment(uuid, numeric, text, text, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_payment(uuid, numeric, text, text, date, text, text) TO authenticated, service_role;

-- =========================================================
-- 10. internal.validate_api_key_for_rpc
-- =========================================================
CREATE OR REPLACE FUNCTION internal.validate_api_key_for_rpc(
  p_api_key_id uuid, p_required_scope text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_key RECORD; v_profile RECORD;
BEGIN
  SELECT * INTO v_key FROM public.api_keys
  WHERE id=p_api_key_id AND is_active=true AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: API key not found or inactive'; END IF;
  IF NOT (v_key.scopes @> ARRAY[p_required_scope]) THEN RAISE EXCEPTION 'VALIDATION_ERROR: Missing required scope: %', p_required_scope; END IF;
  SELECT id INTO v_profile FROM public.profiles WHERE id=v_key.created_by AND is_active=true AND role='owner';
  IF NOT FOUND THEN RAISE EXCEPTION 'BUSINESS_RULE_ERROR: API key owner is not an active owner'; END IF;
  RETURN jsonb_build_object('actor_id',v_key.created_by,'integration_id',v_key.integration_id,'api_key_id',v_key.id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION internal.validate_api_key_for_rpc(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION internal.validate_api_key_for_rpc(uuid, text) TO service_role;

-- =========================================================
-- 11. API write RPCs
-- =========================================================

CREATE OR REPLACE FUNCTION public.api_create_sale(p_payload jsonb, p_api_key_id uuid, p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_key_info jsonb; v_actor_id uuid; v_integration_id uuid; v_api_key_id uuid;
BEGIN
  v_key_info := internal.validate_api_key_for_rpc(p_api_key_id, 'sales:create');
  v_actor_id := (v_key_info->>'actor_id')::uuid; v_integration_id := (v_key_info->>'integration_id')::uuid; v_api_key_id := (v_key_info->>'api_key_id')::uuid;
  RETURN internal.core_create_sale(p_payload, v_actor_id, v_api_key_id, v_integration_id,
    p_payload->>'sale_source', p_payload->>'external_reference',
    NULLIF(p_payload->>'salesperson_id', '')::uuid, p_payload->>'salesperson_name',
    p_idempotency_key, 'POST /v1/sales');
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.api_create_sale(jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_create_sale(jsonb, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.api_add_payment(
  p_sale_id uuid, p_amount numeric, p_api_key_id uuid, p_idempotency_key text,
  p_payment_method text DEFAULT NULL, p_transaction_reference text DEFAULT NULL,
  p_payment_date date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_key_info jsonb; v_actor_id uuid; v_integration_id uuid; v_api_key_id uuid;
BEGIN
  v_key_info := internal.validate_api_key_for_rpc(p_api_key_id, 'payments:create');
  v_actor_id := (v_key_info->>'actor_id')::uuid; v_integration_id := (v_key_info->>'integration_id')::uuid; v_api_key_id := (v_key_info->>'api_key_id')::uuid;
  RETURN internal.core_add_payment(p_sale_id, p_amount, v_actor_id,
    p_payment_method, p_transaction_reference, p_payment_date, p_note,
    NULL, v_api_key_id, v_integration_id, p_idempotency_key, 'POST /v1/sales/:id/payments');
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.api_add_payment(uuid, numeric, uuid, text, text, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_add_payment(uuid, numeric, uuid, text, text, text, date, text) TO service_role;

CREATE OR REPLACE FUNCTION public.api_create_customer(
  p_name text, p_phone text, p_api_key_id uuid,
  p_email text DEFAULT NULL, p_customer_type text DEFAULT 'retail', p_acquisition_source text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_key_info jsonb; v_actor_id uuid;
BEGIN
  v_key_info := internal.validate_api_key_for_rpc(p_api_key_id, 'customers:create');
  v_actor_id := (v_key_info->>'actor_id')::uuid;
  RETURN internal.core_create_customer(p_name, p_phone, v_actor_id, p_email, p_customer_type, p_acquisition_source);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.api_create_customer(text, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_create_customer(text, text, uuid, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.api_update_customer(p_customer_id uuid, p_fields jsonb, p_api_key_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_key_info jsonb; v_actor_id uuid;
BEGIN
  v_key_info := internal.validate_api_key_for_rpc(p_api_key_id, 'customers:update');
  v_actor_id := (v_key_info->>'actor_id')::uuid;
  RETURN internal.core_update_customer(p_customer_id, p_fields, v_actor_id);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.api_update_customer(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_update_customer(uuid, jsonb, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.api_update_fulfilment(
  p_sale_id uuid, p_fulfilment_status text, p_api_key_id uuid, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_key_info jsonb; v_actor_id uuid;
BEGIN
  v_key_info := internal.validate_api_key_for_rpc(p_api_key_id, 'fulfilment:update');
  v_actor_id := (v_key_info->>'actor_id')::uuid;
  RETURN internal.core_update_fulfilment(p_sale_id, p_fulfilment_status, v_actor_id, p_note);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.api_update_fulfilment(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_update_fulfilment(uuid, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.api_update_renewal(
  p_renewal_id uuid, p_api_key_id uuid, p_status text DEFAULT NULL, p_snoozed_until date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_key_info jsonb; v_actor_id uuid;
BEGIN
  v_key_info := internal.validate_api_key_for_rpc(p_api_key_id, 'renewals:update');
  v_actor_id := (v_key_info->>'actor_id')::uuid;
  RETURN internal.core_update_renewal(p_renewal_id, v_actor_id, p_status, p_snoozed_until, p_note);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.api_update_renewal(uuid, uuid, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_update_renewal(uuid, uuid, text, date, text) TO service_role;
