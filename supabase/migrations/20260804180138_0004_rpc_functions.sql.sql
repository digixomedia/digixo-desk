/*
# DigiXO Desk — RPC Functions

## Purpose
Server-side functions for transactional multi-table operations and
owner/manager dashboard aggregations.

## Functions
1. `update_plan_prices(p_plan_id, p_new_cost, p_new_selling, p_update_defaults)`
   - Updates a product_plan's default prices (owner-only).
   - Records a row in product_price_history.
   - Does NOT touch any existing sales.

2. `create_sale(p_payload jsonb)`
   - Atomic creation of sale + optional payment + optional subscription +
     optional first renewal. All succeed together or fail together.
   - Accepts existing customer_id OR new customer fields (phone normalised).
   - Snapshots product/plan name, prices, duration from the plan at sale time.
   - Logs activity. Returns sale id + sale_number.

3. `owner_dashboard_stats()` — Owner-only financial + operational metrics.
4. `manager_dashboard_stats()` — Operational-only metrics (no expense data).
5. `sale_outstanding(p_sale_id)` — Outstanding = final_selling_price - valid payments.

## Security
- All functions SECURITY DEFINER; each checks is_owner() or is_active_user().
*/

-- =========================================================
-- update_plan_prices
-- =========================================================

CREATE OR REPLACE FUNCTION public.update_plan_prices(
  p_plan_id uuid,
  p_new_cost numeric,
  p_new_selling numeric,
  p_update_defaults boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan RECORD;
  v_history_id uuid;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can update product default prices';
  END IF;

  SELECT * INTO v_plan FROM public.product_plans WHERE id = p_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan not found';
  END IF;

  IF p_new_cost IS NULL OR p_new_cost < 0 THEN
    RAISE EXCEPTION 'Cost price must be zero or positive';
  END IF;
  IF p_new_selling IS NULL OR p_new_selling < 0 THEN
    RAISE EXCEPTION 'Selling price must be zero or positive';
  END IF;

  INSERT INTO public.product_price_history (
    product_plan_id, previous_cost_price, new_cost_price,
    previous_selling_price, new_selling_price, effective_at, changed_by
  )
  VALUES (
    p_plan_id, v_plan.default_cost_price, p_new_cost,
    v_plan.default_selling_price, p_new_selling, now(), auth.uid()
  )
  RETURNING id INTO v_history_id;

  IF p_update_defaults THEN
    UPDATE public.product_plans
    SET default_cost_price = p_new_cost,
        default_selling_price = p_new_selling,
        updated_at = now()
    WHERE id = p_plan_id;
  END IF;

  PERFORM public.log_activity(
    'price_change',
    'Updated default prices for plan ' || v_plan.plan_name,
    'product_plan',
    p_plan_id,
    jsonb_build_object(
      'cost_price', v_plan.default_cost_price,
      'selling_price', v_plan.default_selling_price
    ),
    jsonb_build_object(
      'cost_price', p_new_cost,
      'selling_price', p_new_selling
    )
  );

  RETURN v_history_id;
END;
$$;

-- =========================================================
-- create_sale
-- =========================================================

CREATE OR REPLACE FUNCTION public.create_sale(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_payment_status := COALESCE(p_payload->>'payment_status', 'pending');
  v_fulfilment_status := COALESCE(p_payload->>'fulfilment_status', 'payment_confirmation');
  v_note := p_payload->>'note';
  v_sale_date := COALESCE((p_payload->>'sale_date')::date, CURRENT_DATE);

  -- New customer fields
  v_new_customer_name := p_payload->>'new_customer_name';
  v_new_customer_phone := p_payload->>'new_customer_phone';
  v_new_customer_email := p_payload->>'new_customer_email';
  v_new_customer_type := COALESCE(p_payload->>'new_customer_type', 'retail');
  v_new_customer_source := p_payload->>'new_customer_source';

  -- Validate monetary fields
  IF v_final_selling < 0 OR v_cost_price < 0 OR v_payment_fee < 0 OR v_amount_received < 0 THEN
    RAISE EXCEPTION 'Monetary values cannot be negative';
  END IF;

  -- Resolve or create customer
  IF v_customer_id IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM public.customers WHERE id = v_customer_id AND archived_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer not found';
    END IF;
  ELSE
    IF v_new_customer_phone IS NULL OR btrim(v_new_customer_phone) = '' THEN
      RAISE EXCEPTION 'Phone number is required for a new customer';
    END IF;
    v_phone_normalized := public.normalize_phone(v_new_customer_phone);
    IF v_phone_normalized = '' THEN
      RAISE EXCEPTION 'Invalid phone number';
    END IF;

    SELECT id INTO v_customer_id FROM public.customers WHERE phone_normalized = v_phone_normalized;
    IF NOT FOUND THEN
      INSERT INTO public.customers (
        name, phone_normalized, phone_display, email, customer_type, acquisition_source, created_by
      )
      VALUES (
        v_new_customer_name, v_phone_normalized, v_new_customer_phone,
        v_new_customer_email, v_new_customer_type, v_new_customer_source, auth.uid()
      )
      RETURNING id INTO v_customer_id;
    END IF;
  END IF;

  -- Resolve plan snapshot
  IF v_is_custom THEN
    v_purchase_type := COALESCE(p_payload->>'purchase_type', 'one_time');
    v_duration_days := NULLIF(p_payload->>'duration_days', '')::integer;
    v_warranty_days := NULLIF(p_payload->>'warranty_days', '')::integer;
    IF v_product_name IS NULL OR btrim(v_product_name) = '' THEN
      RAISE EXCEPTION 'Product name is required';
    END IF;
    IF v_plan_name IS NULL OR btrim(v_plan_name) = '' THEN
      v_plan_name := 'Custom';
    END IF;
  ELSE
    IF v_plan_id IS NULL THEN
      RAISE EXCEPTION 'A product plan is required (or enable custom product)';
    END IF;
    SELECT * INTO v_plan FROM public.product_plans WHERE id = v_plan_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product plan not found';
    END IF;
    v_purchase_type := v_plan.purchase_type;
    v_duration_days := v_plan.duration_days;
    v_warranty_days := v_plan.warranty_days;
    v_product_name := (SELECT name FROM public.products WHERE id = v_plan.product_id);
    v_plan_name := v_plan.plan_name;
    IF v_list_price IS NULL THEN
      v_list_price := v_plan.optional_list_price;
    END IF;
  END IF;

  -- Determine payment status from amount received
  IF v_amount_received > 0 THEN
    IF v_amount_received >= v_final_selling THEN
      v_payment_status := 'paid';
    ELSE
      v_payment_status := 'partial';
    END IF;
  END IF;

  -- Calculate dates
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
  IF v_warranty_days IS NOT NULL THEN
    v_warranty_end := v_sale_date + v_warranty_days;
  END IF;

  -- Create the sale
  INSERT INTO public.sales (
    customer_id, product_plan_id,
    product_name_snapshot, plan_name_snapshot, purchase_type_snapshot,
    duration_days_snapshot, list_price_snapshot, cost_price_snapshot,
    final_selling_price, payment_fee,
    sale_date, payment_status, fulfilment_status,
    payment_method, transaction_reference,
    subscription_start_date, renewal_date, warranty_end_date,
    note, created_by, updated_by
  )
  VALUES (
    v_customer_id, v_plan_id,
    v_product_name, v_plan_name, v_purchase_type,
    v_duration_days, v_list_price, v_cost_price,
    v_final_selling, v_payment_fee,
    v_sale_date, v_payment_status, v_fulfilment_status,
    v_payment_method, v_txn_ref,
    v_sub_start, v_renewal_date, v_warranty_end,
    v_note, auth.uid(), auth.uid()
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- Create payment if amount received
  IF v_amount_received > 0 THEN
    INSERT INTO public.payments (
      sale_id, amount, payment_method, transaction_reference,
      payment_date, status, created_by
    )
    VALUES (
      v_sale_id, v_amount_received, v_payment_method, v_txn_ref,
      v_sale_date, 'valid', auth.uid()
    )
    RETURNING id INTO v_payment_id;
  END IF;

  -- Create subscription + first renewal for recurring
  IF v_purchase_type = 'recurring' THEN
    INSERT INTO public.subscriptions (
      customer_id, original_sale_id, current_sale_id, product_plan_id,
      start_date, end_date, status, next_renewal_date, created_by
    )
    VALUES (
      v_customer_id, v_sale_id, v_sale_id, v_plan_id,
      v_sub_start, v_sub_end, 'active', v_renewal_date, auth.uid()
    )
    RETURNING id INTO v_sub_id;

    IF v_renewal_date IS NOT NULL THEN
      INSERT INTO public.renewals (
        subscription_id, customer_id, due_date, status
      )
      VALUES (
        v_sub_id, v_customer_id, v_renewal_date, 'pending'
      )
      RETURNING id INTO v_renewal_id;
    END IF;
  END IF;

  -- Log activity
  PERFORM public.log_activity(
    'sale_create',
    'Created sale ' || v_sale_number || ' for ' || v_product_name || ' - ' || v_plan_name,
    'sale',
    v_sale_id,
    NULL,
    jsonb_build_object(
      'sale_number', v_sale_number,
      'customer_id', v_customer_id,
      'final_selling_price', v_final_selling,
      'payment_status', v_payment_status
    )
  );

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'sale_number', v_sale_number,
    'customer_id', v_customer_id
  );
END;
$$;

-- =========================================================
-- owner_dashboard_stats
-- =========================================================

CREATE OR REPLACE FUNCTION public.owner_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month_start date := date_trunc('month', now())::date;
  v_today date := CURRENT_DATE;
  v_revenue numeric;
  v_cash numeric;
  v_cost numeric;
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

  v_gross := v_revenue - v_cost;

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
      AND status NOT IN ('renewed','not_renewing');

  SELECT count(*) INTO v_overdue_renewals
    FROM public.renewals
    WHERE due_date < v_today
      AND status NOT IN ('renewed','not_renewing');

  SELECT count(*) INTO v_upcoming_renewals
    FROM public.renewals
    WHERE due_date > v_today
      AND due_date <= v_today + 30
      AND status NOT IN ('renewed','not_renewing');

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
$$;

-- =========================================================
-- manager_dashboard_stats
-- =========================================================

CREATE OR REPLACE FUNCTION public.manager_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      AND status NOT IN ('renewed','not_renewing');

  SELECT count(*) INTO v_overdue_renewals
    FROM public.renewals
    WHERE due_date < v_today
      AND status NOT IN ('renewed','not_renewing');

  SELECT count(*) INTO v_upcoming_renewals
    FROM public.renewals
    WHERE due_date > v_today
      AND due_date <= v_today + 30
      AND status NOT IN ('renewed','not_renewing');

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
$$;

-- =========================================================
-- sale_outstanding
-- =========================================================

CREATE OR REPLACE FUNCTION public.sale_outstanding(p_sale_id uuid)
RETURNS numeric
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT final_selling_price FROM public.sales WHERE id = p_sale_id), 0
  ) - COALESCE(
    (SELECT SUM(amount) FROM public.payments
     WHERE sale_id = p_sale_id AND status = 'valid'), 0
  );
$$;
