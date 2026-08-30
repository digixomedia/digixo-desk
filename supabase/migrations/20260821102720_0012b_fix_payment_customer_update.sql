/*
# Phase 2B Fix 2: Payment ON CONFLICT, jsonb_object_keys, and scope name

1. core_add_payment: Only use ON CONFLICT when v_namespaced_key is NOT NULL.
   When it's NULL, just insert without conflict handling.
2. core_update_customer: Use pg_catalog.jsonb_object_keys instead of bare jsonb_object_keys.
3. Fix sale detail route scope from "sale:read" to "sales:read" (done in Edge Function).
*/

-- Fix core_add_payment
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
    v_request_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object('endpoint',p_api_idempotency_endpoint,'sale_id',p_sale_id,'amount',p_amount,'payment_method',p_payment_method,'transaction_reference',p_transaction_reference,'payment_date',p_payment_date,'note',p_note)::text,'UTF8'),'sha256'),'hex');
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
  -- Only use ON CONFLICT when we have a namespaced key (partial unique index)
  IF v_namespaced_key IS NOT NULL THEN
    INSERT INTO public.payments (sale_id,amount,payment_method,transaction_reference,payment_date,status,note,created_by,idempotency_key)
    VALUES (p_sale_id,p_amount,p_payment_method,p_transaction_reference,v_pay_date,'valid',p_note,p_actor_id,v_namespaced_key)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_payment_id;
  ELSE
    INSERT INTO public.payments (sale_id,amount,payment_method,transaction_reference,payment_date,status,note,created_by)
    VALUES (p_sale_id,p_amount,p_payment_method,p_transaction_reference,v_pay_date,'valid',p_note,p_actor_id)
    RETURNING id INTO v_payment_id;
  END IF;

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

-- Fix core_update_customer: use pg_catalog.jsonb_object_keys
CREATE OR REPLACE FUNCTION internal.core_update_customer(
  p_customer_id uuid, p_fields jsonb, p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_customer RECORD; v_update_fields jsonb := '{}'::jsonb; v_field text;
BEGIN
  SELECT * INTO v_customer FROM public.customers WHERE id=p_customer_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: Customer not found'; END IF;
  FOR v_field IN SELECT pg_catalog.jsonb_object_keys(p_fields) LOOP
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
