/*
# Add service-role dashboard stats RPC

The existing owner_dashboard_stats checks is_owner() which requires auth context.
The API Edge Function uses the service role which has no auth.uid().
This adds api_dashboard_stats that skips the auth check (the Edge Function
already validated the API key before calling this).
*/

CREATE OR REPLACE FUNCTION public.api_dashboard_stats()
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

REVOKE EXECUTE ON FUNCTION public.api_dashboard_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_dashboard_stats() TO service_role;
