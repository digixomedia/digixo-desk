/* Harden payment retry handling and restore the original create_sale plan snapshot logic. */

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
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'Only active users can add payments';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'An idempotency key is required';
  END IF;
  v_pay_date := COALESCE(p_payment_date, CURRENT_DATE);

  SELECT * INTO v_sale
  FROM public.sales
  WHERE id = p_sale_id AND archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;

  SELECT * INTO v_existing_payment
  FROM public.payments
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_payment.sale_id <> p_sale_id
       OR v_existing_payment.amount <> p_amount
       OR v_existing_payment.payment_method IS DISTINCT FROM p_payment_method
       OR v_existing_payment.transaction_reference IS DISTINCT FROM p_transaction_reference
       OR v_existing_payment.payment_date <> v_pay_date THEN
      RAISE EXCEPTION 'This idempotency key was already used for a different payment';
    END IF;
    SELECT payment_status INTO v_new_status FROM public.sales WHERE id = p_sale_id;
    RETURN jsonb_build_object(
      'payment', to_jsonb(v_existing_payment),
      'payment_status', v_new_status,
      'amount_received', v_sale.amount_received,
      'idempotent_replay', true
    );
  END IF;

  IF v_sale.payment_status IN ('cancelled', 'refunded', 'partially_refunded') THEN
    RAISE EXCEPTION 'Cannot add payment to a terminal sale';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_total_valid
  FROM public.payments
  WHERE sale_id = p_sale_id AND status = 'valid';
  IF v_total_valid + p_amount > v_sale.final_selling_price - COALESCE(v_sale.refund_amount, 0) THEN
    RAISE EXCEPTION 'Payment amount exceeds the remaining balance';
  END IF;

  SET LOCAL app.bypass_payment_guard = 'on';
  INSERT INTO public.payments (
    sale_id, amount, payment_method, transaction_reference,
    payment_date, status, note, created_by, idempotency_key
  ) VALUES (
    p_sale_id, p_amount, p_payment_method, p_transaction_reference,
    v_pay_date, 'valid', p_note, auth.uid(), p_idempotency_key
  ) ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_payment_id;

  IF v_payment_id IS NULL THEN
    SELECT * INTO v_existing_payment
    FROM public.payments
    WHERE idempotency_key = p_idempotency_key;
    IF v_existing_payment.sale_id <> p_sale_id
       OR v_existing_payment.amount <> p_amount
       OR v_existing_payment.payment_method IS DISTINCT FROM p_payment_method
       OR v_existing_payment.transaction_reference IS DISTINCT FROM p_transaction_reference
       OR v_existing_payment.payment_date <> v_pay_date THEN
      RAISE EXCEPTION 'This idempotency key was already used for a different payment';
    END IF;
    SELECT payment_status INTO v_new_status FROM public.sales WHERE id = p_sale_id;
    RETURN jsonb_build_object(
      'payment', to_jsonb(v_existing_payment),
      'payment_status', v_new_status,
      'amount_received', v_sale.amount_received,
      'idempotent_replay', true
    );
  END IF;

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
    'amount_received', v_total_valid,
    'idempotent_replay', false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_payments_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF current_setting('app.bypass_payment_guard', true) IS DISTINCT FROM 'on' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Direct payment creation is not allowed';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      NEW.sale_id IS DISTINCT FROM OLD.sale_id OR
      NEW.amount IS DISTINCT FROM OLD.amount OR
      NEW.payment_method IS DISTINCT FROM OLD.payment_method OR
      NEW.transaction_reference IS DISTINCT FROM OLD.transaction_reference OR
      NEW.payment_date IS DISTINCT FROM OLD.payment_date OR
      NEW.status IS DISTINCT FROM OLD.status OR
      NEW.note IS DISTINCT FROM OLD.note OR
      NEW.created_by IS DISTINCT FROM OLD.created_by OR
      NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    ) THEN
      RAISE EXCEPTION 'Direct financial payment edits are not allowed';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_payments_insert_trigger ON public.payments;
DROP TRIGGER IF EXISTS guard_payments_mutation_trigger ON public.payments;
CREATE TRIGGER guard_payments_mutation_trigger
  BEFORE INSERT OR UPDATE ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_payments_mutation();

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
    final_selling_price, payment_fee, sale_date, payment_status, fulfilment_status,
    payment_method, transaction_reference, subscription_start_date, renewal_date,
    warranty_end_date, note, created_by, updated_by
  ) VALUES (
    v_customer_id, v_plan_id, v_product_name, v_plan_name, v_purchase_type,
    v_duration_days, v_list_price, v_cost_price, v_final_selling, v_payment_fee,
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
      'final_selling_price', v_final_selling, 'payment_status', v_payment_status)
  );

  RETURN jsonb_build_object('sale_id', v_sale_id, 'sale_number', v_sale_number, 'customer_id', v_customer_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.add_payment(uuid, numeric, text, text, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_payment(uuid, numeric, text, text, date, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.create_sale(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_sale(jsonb) TO authenticated;
