/*
  Phase 1 accuracy and security fixes.

  Financial policy:
  - Booked sales are dated by sales.sale_date and exclude cancelled and demo sales.
  - Cash is dated by valid payments.payment_date, including receipts for older sales.
  - Cash refunds are dated by refund_events.occurred_on and reduce net collected/profit,
    but do not reduce the amount originally owed.
  - Balance adjustments reduce outstanding without pretending cash was refunded.
  - Product cost, payment fees and replacement cost belong to the booked sale.
  - Archived legitimate records remain in historical financial reporting.
  - Demo records are excluded consistently.
  - Legacy refund totals are preserved with an unknown event date and are never assigned
    an invented reporting date.
*/

-- -----------------------------------------------------------------------------
-- Refund event history
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.refund_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  refund_type text NOT NULL CHECK (refund_type IN ('cash_refund','balance_adjustment','legacy_unknown')),
  occurred_on date,
  reason text,
  idempotency_key text NOT NULL UNIQUE,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((refund_type = 'legacy_unknown' AND occurred_on IS NULL) OR
         (refund_type <> 'legacy_unknown' AND occurred_on IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS refund_events_sale_id_idx ON public.refund_events(sale_id);
CREATE INDEX IF NOT EXISTS refund_events_occurred_on_idx ON public.refund_events(occurred_on);
ALTER TABLE public.refund_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.refund_events TO authenticated;

DROP POLICY IF EXISTS "refund_events_select_active" ON public.refund_events;
CREATE POLICY "refund_events_select_active" ON public.refund_events
  FOR SELECT TO authenticated USING (public.is_active_user());

INSERT INTO public.refund_events (sale_id, amount, refund_type, occurred_on, reason, idempotency_key)
SELECT s.id, s.refund_amount, 'legacy_unknown', NULL,
       'Migrated legacy refund total; original event date is unavailable',
       'legacy:' || s.id::text
FROM public.sales s
WHERE s.refund_amount > 0
ON CONFLICT (idempotency_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.record_refund(
  p_sale_id uuid,
  p_amount numeric,
  p_reason text,
  p_refund_date date,
  p_idempotency_key text,
  p_refund_type text DEFAULT 'cash_refund'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sale public.sales%ROWTYPE;
  v_existing public.refund_events%ROWTYPE;
  v_paid numeric;
  v_cash_refunded numeric;
  v_adjusted numeric;
  v_total_refunds numeric;
  v_new_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN
    RAISE EXCEPTION 'Only active users can record refunds';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can record refunds';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Refund amount must be greater than zero'; END IF;
  IF p_refund_date IS NULL THEN RAISE EXCEPTION 'Refund date is required'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'An idempotency key is required'; END IF;
  IF p_refund_type NOT IN ('cash_refund','balance_adjustment') THEN RAISE EXCEPTION 'Invalid refund type'; END IF;

  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF v_sale.payment_status = 'cancelled' THEN RAISE EXCEPTION 'Cannot refund a cancelled sale'; END IF;

  SELECT * INTO v_existing FROM public.refund_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.sale_id <> p_sale_id OR v_existing.amount <> p_amount OR
       v_existing.occurred_on <> p_refund_date OR v_existing.refund_type <> p_refund_type THEN
      RAISE EXCEPTION 'This idempotency key was already used for a different refund';
    END IF;
    RETURN jsonb_build_object('refund_id', v_existing.id, 'idempotent_replay', true);
  END IF;

  SELECT COALESCE(sum(amount),0) INTO v_paid FROM public.payments WHERE sale_id=p_sale_id AND status='valid';
  SELECT COALESCE(sum(amount) FILTER (WHERE refund_type='cash_refund'),0),
         COALESCE(sum(amount) FILTER (WHERE refund_type='balance_adjustment'),0)
  INTO v_cash_refunded, v_adjusted
  FROM public.refund_events WHERE sale_id=p_sale_id;

  IF p_refund_type='cash_refund' AND v_cash_refunded + p_amount > v_paid THEN
    RAISE EXCEPTION 'Cash refund cannot exceed collected cash';
  END IF;
  IF p_refund_type='balance_adjustment' AND v_adjusted + p_amount > GREATEST(v_sale.final_selling_price - v_paid, 0) THEN
    RAISE EXCEPTION 'Balance adjustment exceeds the unpaid balance';
  END IF;

  INSERT INTO public.refund_events(sale_id, amount, refund_type, occurred_on, reason, idempotency_key, created_by)
  VALUES(p_sale_id, round(p_amount,2), p_refund_type, p_refund_date, NULLIF(btrim(p_reason),''), p_idempotency_key, auth.uid());

  SELECT COALESCE(sum(amount),0) INTO v_total_refunds FROM public.refund_events WHERE sale_id=p_sale_id;
  v_new_status := CASE WHEN v_total_refunds >= v_sale.final_selling_price
                       THEN 'refunded' ELSE 'partially_refunded' END;
  SET LOCAL app.bypass_payment_guard = 'on';
  UPDATE public.sales SET refund_amount=v_total_refunds, payment_status=v_new_status, updated_by=auth.uid(), updated_at=now()
  WHERE id=p_sale_id;
  RETURN jsonb_build_object('refund_amount', v_total_refunds, 'payment_status', v_new_status, 'idempotent_replay', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.record_refund(uuid,numeric,text,date,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_refund(uuid,numeric,text,date,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_refund(p_sale_id uuid,p_amount numeric,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=''
AS $$ SELECT public.record_refund(p_sale_id,p_amount,p_reason,(now() AT TIME ZONE 'Asia/Kolkata')::date,gen_random_uuid()::text,'cash_refund') $$;
REVOKE ALL ON FUNCTION public.record_refund(uuid,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_refund(uuid,numeric,text) TO authenticated;

-- -----------------------------------------------------------------------------
-- Safe search and financial reporting
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.search_sale_ids(text);
CREATE FUNCTION public.search_sale_ids(p_search text,p_phone_digits text DEFAULT NULL,p_include_customer boolean DEFAULT true)
RETURNS TABLE(id uuid)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT s.id
  FROM public.sales s
  JOIN public.customers c ON c.id=s.customer_id
  CROSS JOIN LATERAL (SELECT COALESCE(p_phone_digits,regexp_replace(COALESCE(p_search,''), '[^0-9]', '', 'g')) AS digits) q
  WHERE btrim(COALESCE(p_search,'')) <> ''
    AND (
      s.sale_number ILIKE '%' || p_search || '%' OR
      s.product_name_snapshot ILIKE '%' || p_search || '%' OR
      s.plan_name_snapshot ILIKE '%' || p_search || '%' OR
      (p_include_customer AND (c.name ILIKE '%' || p_search || '%' OR
      c.email ILIKE '%' || p_search || '%' OR
      (length(q.digits) >= 3 AND c.phone_normalized LIKE '%' || q.digits || '%')))
    );
$$;
REVOKE ALL ON FUNCTION public.search_sale_ids(text,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_sale_ids(text,text,boolean) TO authenticated;

DROP FUNCTION IF EXISTS public.search_customer_ids(text);
CREATE FUNCTION public.search_customer_ids(p_search text,p_phone_digits text DEFAULT NULL)
RETURNS TABLE(id uuid)
LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $$
  SELECT c.id FROM public.customers c
  CROSS JOIN LATERAL (SELECT COALESCE(p_phone_digits,regexp_replace(COALESCE(p_search,''),'[^0-9]','','g')) digits) q
  WHERE btrim(COALESCE(p_search,''))<>'' AND (
    c.name ILIKE '%'||p_search||'%' OR c.email ILIKE '%'||p_search||'%' OR
    (length(q.digits)>=3 AND c.phone_normalized LIKE '%'||q.digits||'%')
  );
$$;
REVOKE ALL ON FUNCTION public.search_customer_ids(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_customer_ids(text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.sales_financial_summary(
  p_search text,
  p_payment_status text,
  p_fulfilment_status text,
  p_from date,
  p_to_exclusive date
) RETURNS TABLE(total_order_value numeric, cash_collected numeric, outstanding numeric,
                refund_total numeric, net_collected numeric, sale_count bigint)
LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $$
  WITH matching_sales AS (
    SELECT s.*
    FROM public.sales s JOIN public.customers c ON c.id=s.customer_id
    CROSS JOIN LATERAL (SELECT regexp_replace(COALESCE(p_search,''), '[^0-9]', '', 'g') AS digits) q
    WHERE NOT s.is_demo
      AND (p_from IS NULL OR s.sale_date >= p_from)
      AND (p_to_exclusive IS NULL OR s.sale_date < p_to_exclusive)
      AND (p_payment_status IS NULL OR s.payment_status=p_payment_status)
      AND (p_fulfilment_status IS NULL OR s.fulfilment_status=p_fulfilment_status)
      AND (btrim(COALESCE(p_search,''))='' OR s.sale_number ILIKE '%'||p_search||'%'
        OR s.product_name_snapshot ILIKE '%'||p_search||'%' OR s.plan_name_snapshot ILIKE '%'||p_search||'%'
        OR c.name ILIKE '%'||p_search||'%' OR c.email ILIKE '%'||p_search||'%'
        OR (length(q.digits)>=3 AND c.phone_normalized LIKE '%'||q.digits||'%'))
  ), amounts AS (
    SELECT s.id, s.final_selling_price, s.payment_status='cancelled' cancelled,
      COALESCE((SELECT sum(p.amount) FROM public.payments p WHERE p.sale_id=s.id AND p.status='valid' AND NOT p.is_demo),0) paid,
      COALESCE((SELECT sum(r.amount) FROM public.refund_events r WHERE r.sale_id=s.id AND r.refund_type IN ('cash_refund','legacy_unknown')),0) cash_refunded,
      COALESCE((SELECT sum(r.amount) FROM public.refund_events r WHERE r.sale_id=s.id AND r.refund_type='balance_adjustment'),0) adjusted
    FROM matching_sales s
  )
  SELECT COALESCE(sum(CASE WHEN cancelled THEN 0 ELSE final_selling_price END),0), COALESCE(sum(paid),0),
    COALESCE(sum(CASE WHEN cancelled THEN 0 ELSE GREATEST(final_selling_price-paid-adjusted,0) END),0),
    COALESCE(sum(cash_refunded+adjusted),0), COALESCE(sum(paid-cash_refunded),0), count(*)
  FROM amounts;
$$;
REVOKE ALL ON FUNCTION public.sales_financial_summary(text,text,text,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_financial_summary(text,text,text,date,date) TO authenticated;

DROP FUNCTION IF EXISTS public.sale_financial_detail(uuid);
CREATE FUNCTION public.sale_financial_detail(p_sale_id uuid)
RETURNS TABLE(total_price numeric,total_paid numeric,refund_amount numeric,cash_refunded numeric,balance_adjusted numeric,outstanding numeric,
  net_collected numeric,cost_price numeric,payment_fee numeric,replacement_cost numeric,gross_profit numeric,margin_pct numeric)
LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $$
  WITH x AS (
    SELECT s.*,
      COALESCE((SELECT sum(p.amount) FROM public.payments p WHERE p.sale_id=s.id AND p.status='valid' AND NOT p.is_demo),0) paid,
      COALESCE((SELECT sum(r.amount) FROM public.refund_events r WHERE r.sale_id=s.id AND r.refund_type IN ('cash_refund','legacy_unknown')),0) cash_refunded,
      COALESCE((SELECT sum(r.amount) FROM public.refund_events r WHERE r.sale_id=s.id AND r.refund_type='balance_adjustment'),0) adjusted
    FROM public.sales s WHERE s.id=p_sale_id AND NOT s.is_demo
  ) SELECT final_selling_price,paid,cash_refunded+adjusted,cash_refunded,adjusted,
      CASE WHEN payment_status='cancelled' THEN 0 ELSE GREATEST(final_selling_price-paid-adjusted,0) END,
      paid-cash_refunded,cost_price_snapshot,payment_fee,replacement_cost,
      final_selling_price-cost_price_snapshot-payment_fee-replacement_cost-cash_refunded,
      CASE WHEN final_selling_price>0 THEN round(((final_selling_price-cost_price_snapshot-payment_fee-replacement_cost-cash_refunded)/final_selling_price)*100,1) ELSE 0 END
    FROM x;
$$;

CREATE OR REPLACE FUNCTION public.customer_financial_summary(p_customer_id uuid)
RETURNS TABLE(total_order_value numeric,cash_collected numeric,outstanding numeric,
  refund_total numeric,net_collected numeric,sale_count bigint)
LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $$
  WITH amounts AS (
    SELECT s.final_selling_price, s.payment_status='cancelled' cancelled,
      COALESCE((SELECT sum(p.amount) FROM public.payments p WHERE p.sale_id=s.id AND p.status='valid' AND NOT p.is_demo),0) paid,
      COALESCE((SELECT sum(r.amount) FROM public.refund_events r WHERE r.sale_id=s.id AND r.refund_type IN ('cash_refund','legacy_unknown')),0) cash_refunded,
      COALESCE((SELECT sum(r.amount) FROM public.refund_events r WHERE r.sale_id=s.id AND r.refund_type='balance_adjustment'),0) adjusted
    FROM public.sales s WHERE s.customer_id=p_customer_id AND NOT s.is_demo
  ) SELECT COALESCE(sum(CASE WHEN cancelled THEN 0 ELSE final_selling_price END),0),COALESCE(sum(paid),0),
      COALESCE(sum(CASE WHEN cancelled THEN 0 ELSE GREATEST(final_selling_price-paid-adjusted,0) END),0),
      COALESCE(sum(cash_refunded+adjusted),0),COALESCE(sum(paid-cash_refunded),0),count(*) FROM amounts;
$$;

CREATE OR REPLACE FUNCTION public.dashboard_financial_stats()
RETURNS TABLE(revenue_this_month numeric,cash_received_this_month numeric,expenses_this_month numeric,
  gross_profit_this_month numeric,net_profit_this_month numeric,pending_payments_count bigint,
  activations_pending_count bigint,upcoming_renewals_count bigint,overdue_renewals_count bigint,
  renewals_due_today_count bigint,prev_month_revenue numeric,prev_month_profit numeric)
LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $$
  WITH bounds AS (
    SELECT date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date m0,
           (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 month')::date m1,
           (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - interval '1 month')::date pm0,
           (now() AT TIME ZONE 'Asia/Kolkata')::date today
  ), ms AS (SELECT s.* FROM public.sales s,bounds b WHERE NOT s.is_demo AND s.payment_status<>'cancelled' AND s.sale_date>=b.m0 AND s.sale_date<b.m1),
  pm AS (SELECT s.* FROM public.sales s,bounds b WHERE NOT s.is_demo AND s.payment_status<>'cancelled' AND s.sale_date>=b.pm0 AND s.sale_date<b.m0),
  cash AS (SELECT COALESCE(sum(p.amount),0) v FROM public.payments p,bounds b WHERE p.status='valid' AND NOT p.is_demo AND p.payment_date>=b.m0 AND p.payment_date<b.m1),
  refunds AS (SELECT COALESCE(sum(r.amount),0) v FROM public.refund_events r JOIN public.sales s ON s.id=r.sale_id,bounds b WHERE r.refund_type='cash_refund' AND NOT s.is_demo AND r.occurred_on>=b.m0 AND r.occurred_on<b.m1),
  prev_refunds AS (SELECT COALESCE(sum(r.amount),0) v FROM public.refund_events r JOIN public.sales s ON s.id=r.sale_id,bounds b WHERE r.refund_type='cash_refund' AND NOT s.is_demo AND r.occurred_on>=b.pm0 AND r.occurred_on<b.m0),
  expenses AS (SELECT COALESCE(sum(e.amount),0) v FROM public.expenses e,bounds b WHERE NOT e.is_demo AND e.expense_date>=b.m0 AND e.expense_date<b.m1),
  rc AS (SELECT count(*) FILTER(WHERE r.due_date=b.today) today_count,count(*) FILTER(WHERE r.due_date<b.today) overdue,count(*) FILTER(WHERE r.due_date>b.today AND r.due_date<=b.today+30) upcoming FROM public.renewals r,bounds b WHERE NOT r.is_demo AND r.archived_at IS NULL AND r.status IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response') AND (r.snoozed_until IS NULL OR r.snoozed_until<=b.today))
  SELECT COALESCE((SELECT sum(final_selling_price) FROM ms),0),(SELECT v FROM cash),(SELECT v FROM expenses),
    COALESCE((SELECT sum(final_selling_price-cost_price_snapshot-payment_fee-replacement_cost) FROM ms),0)-(SELECT v FROM refunds),
    COALESCE((SELECT sum(final_selling_price-cost_price_snapshot-payment_fee-replacement_cost) FROM ms),0)-(SELECT v FROM refunds)-(SELECT v FROM expenses),
    (SELECT count(*) FROM ms WHERE payment_status IN ('pending','partial')),
    (SELECT count(*) FROM ms WHERE fulfilment_status='activation_pending'),
    (SELECT upcoming FROM rc),(SELECT overdue FROM rc),(SELECT today_count FROM rc),
    COALESCE((SELECT sum(final_selling_price) FROM pm),0),
    COALESCE((SELECT sum(final_selling_price-cost_price_snapshot-payment_fee-replacement_cost) FROM pm),0)-(SELECT v FROM prev_refunds);
$$;

CREATE OR REPLACE FUNCTION public.financial_report_summary(p_from date, p_to_exclusive date)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
AS $$
  WITH booked AS (SELECT * FROM public.sales WHERE NOT is_demo AND payment_status<>'cancelled' AND (p_from IS NULL OR sale_date>=p_from) AND (p_to_exclusive IS NULL OR sale_date<p_to_exclusive)),
  cash AS (SELECT COALESCE(sum(amount),0) v FROM public.payments WHERE status='valid' AND NOT is_demo AND (p_from IS NULL OR payment_date>=p_from) AND (p_to_exclusive IS NULL OR payment_date<p_to_exclusive)),
  refunds AS (SELECT COALESCE(sum(r.amount),0) v FROM public.refund_events r JOIN public.sales s ON s.id=r.sale_id WHERE r.refund_type='cash_refund' AND NOT s.is_demo AND (p_from IS NULL OR r.occurred_on>=p_from) AND (p_to_exclusive IS NULL OR r.occurred_on<p_to_exclusive)),
  expenses AS (SELECT COALESCE(sum(amount),0) v FROM public.expenses WHERE NOT is_demo AND (p_from IS NULL OR expense_date>=p_from) AND (p_to_exclusive IS NULL OR expense_date<p_to_exclusive)),
  outstanding AS (SELECT count(*) FILTER(WHERE balance>0) c,COALESCE(sum(balance),0) v FROM (SELECT GREATEST(s.final_selling_price-COALESCE((SELECT sum(p.amount) FROM public.payments p WHERE p.sale_id=s.id AND p.status='valid' AND NOT p.is_demo),0)-COALESCE((SELECT sum(r.amount) FROM public.refund_events r WHERE r.sale_id=s.id AND r.refund_type='balance_adjustment'),0),0) balance FROM booked s) q),
  products AS (SELECT product_name_snapshot||' · '||plan_name_snapshot name,count(*) count,sum(final_selling_price) revenue FROM booked GROUP BY 1 ORDER BY revenue DESC LIMIT 5),
  legacy AS (SELECT COALESCE(sum(amount),0) v FROM public.refund_events r JOIN public.sales s ON s.id=r.sale_id WHERE r.refund_type='legacy_unknown' AND NOT s.is_demo)
  SELECT jsonb_build_object('totalSales',(SELECT count(*) FROM booked),'revenue',COALESCE((SELECT sum(final_selling_price) FROM booked),0),'productCost',COALESCE((SELECT sum(cost_price_snapshot) FROM booked),0),'paymentFees',COALESCE((SELECT sum(payment_fee) FROM booked),0),'replacementCosts',COALESCE((SELECT sum(replacement_cost) FROM booked),0),'paymentsReceived',(SELECT v FROM cash),'refunds',(SELECT v FROM refunds),'outstandingAmount',(SELECT v FROM outstanding),'outstandingCount',(SELECT c FROM outstanding),'grossProfit',COALESCE((SELECT sum(final_selling_price-cost_price_snapshot-payment_fee-replacement_cost) FROM booked),0)-(SELECT v FROM refunds),'expenses',(SELECT v FROM expenses),'netProfit',COALESCE((SELECT sum(final_selling_price-cost_price_snapshot-payment_fee-replacement_cost) FROM booked),0)-(SELECT v FROM refunds)-(SELECT v FROM expenses),'undatedLegacyRefunds',(SELECT v FROM legacy),'topProducts',COALESCE((SELECT jsonb_agg(to_jsonb(products)) FROM products),'[]'::jsonb));
$$;

REVOKE ALL ON FUNCTION public.sale_financial_detail(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.customer_financial_summary(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.dashboard_financial_stats() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.financial_report_summary(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.sale_financial_detail(uuid),public.customer_financial_summary(uuid),public.dashboard_financial_stats(),public.financial_report_summary(date,date) TO authenticated;

-- -----------------------------------------------------------------------------
-- Atomic, idempotent renewal completion
-- -----------------------------------------------------------------------------
ALTER TABLE public.renewals ADD COLUMN IF NOT EXISTS completion_idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS renewals_completion_idempotency_key_uniq ON public.renewals(completion_idempotency_key) WHERE completion_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS renewals_subscription_due_unique ON public.renewals(subscription_id,due_date) WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.complete_renewal(p_renewal_id uuid,p_payload jsonb,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE v_renewal public.renewals%ROWTYPE; v_sub public.subscriptions%ROWTYPE; v_plan public.product_plans%ROWTYPE; v_product text;
  v_sale_id uuid; v_sale_number text; v_start date; v_end date; v_sale_date date; v_selling numeric; v_cost numeric; v_fee numeric; v_received numeric;
  v_payment_status text; v_fulfilment text; v_payment_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_user() THEN RAISE EXCEPTION 'Only active users can complete renewals'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key)='' THEN RAISE EXCEPTION 'An idempotency key is required'; END IF;
  SELECT * INTO v_renewal FROM public.renewals WHERE id=p_renewal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Renewal not found'; END IF;
  IF v_renewal.linked_new_sale_id IS NOT NULL THEN
    SELECT sale_number INTO v_sale_number FROM public.sales WHERE id=v_renewal.linked_new_sale_id;
    RETURN jsonb_build_object('sale_id',v_renewal.linked_new_sale_id,'sale_number',v_sale_number,'customer_id',v_renewal.customer_id,'idempotent_replay',true);
  END IF;
  SELECT * INTO v_sub FROM public.subscriptions WHERE id=v_renewal.subscription_id FOR UPDATE;
  IF NOT FOUND OR v_sub.customer_id<>v_renewal.customer_id THEN RAISE EXCEPTION 'Renewal subscription is invalid'; END IF;
  SELECT * INTO v_plan FROM public.product_plans WHERE id=v_sub.product_plan_id;
  IF NOT FOUND OR v_plan.purchase_type<>'recurring' OR v_plan.duration_days IS NULL OR v_plan.duration_days<=0 THEN RAISE EXCEPTION 'Renewal plan is invalid'; END IF;
  SELECT name INTO v_product FROM public.products WHERE id=v_plan.product_id;
  v_sale_date:=COALESCE((p_payload->>'sale_date')::date,(now() AT TIME ZONE 'Asia/Kolkata')::date);
  v_start:=COALESCE((p_payload->>'subscription_start_date')::date,v_sub.end_date,v_sale_date);
  v_end:=COALESCE((p_payload->>'renewal_date')::date,v_start+v_plan.duration_days);
  IF v_end<=v_start THEN RAISE EXCEPTION 'Renewal date must be after the start date'; END IF;
  v_selling:=round(COALESCE((p_payload->>'final_selling_price')::numeric,v_plan.default_selling_price),2);
  v_cost:=round(COALESCE((p_payload->>'cost_price')::numeric,v_plan.default_cost_price),2);
  v_fee:=round(COALESCE((p_payload->>'payment_fee')::numeric,0),2);
  v_received:=round(COALESCE((p_payload->>'amount_received')::numeric,0),2);
  IF v_selling<=0 OR v_cost<0 OR v_fee<0 OR v_received<0 OR v_received>v_selling THEN RAISE EXCEPTION 'Invalid renewal amounts'; END IF;
  v_payment_status:=CASE WHEN v_received>=v_selling THEN 'paid' WHEN v_received>0 THEN 'partial' ELSE 'pending' END;
  v_fulfilment:=COALESCE(p_payload->>'fulfilment_status','payment_confirmation');
  IF v_fulfilment NOT IN ('payment_confirmation','activation_pending','processing','activated','replacement_required','completed') THEN RAISE EXCEPTION 'Invalid renewal fulfilment status'; END IF;
  SET LOCAL app.bypass_payment_guard='on';
  INSERT INTO public.sales(customer_id,product_plan_id,product_name_snapshot,plan_name_snapshot,purchase_type_snapshot,duration_days_snapshot,list_price_snapshot,cost_price_snapshot,final_selling_price,payment_fee,sale_date,payment_status,fulfilment_status,payment_method,transaction_reference,subscription_start_date,renewal_date,note,created_by,updated_by,amount_received,is_demo)
  VALUES(v_renewal.customer_id,v_plan.id,v_product,v_plan.plan_name,'recurring',v_plan.duration_days,v_plan.optional_list_price,v_cost,v_selling,v_fee,v_sale_date,v_payment_status,v_fulfilment,NULLIF(p_payload->>'payment_method',''),NULLIF(p_payload->>'transaction_reference',''),v_start,v_end,NULLIF(p_payload->>'note',''),auth.uid(),auth.uid(),v_received,v_renewal.is_demo)
  RETURNING id,sale_number INTO v_sale_id,v_sale_number;
  IF v_received>0 THEN INSERT INTO public.payments(sale_id,amount,payment_method,transaction_reference,payment_date,status,note,created_by,idempotency_key,is_demo) VALUES(v_sale_id,v_received,NULLIF(p_payload->>'payment_method',''),NULLIF(p_payload->>'transaction_reference',''),v_sale_date,'valid','Renewal payment',auth.uid(),'renewal:'||p_idempotency_key,v_renewal.is_demo) RETURNING id INTO v_payment_id; END IF;
  UPDATE public.subscriptions SET current_sale_id=v_sale_id,start_date=v_start,end_date=v_end,next_renewal_date=v_end,status=CASE WHEN v_sub.end_date>=v_sale_date OR (v_payment_status='paid' AND v_fulfilment IN ('activated','completed')) THEN 'active' ELSE 'due' END,updated_at=now() WHERE id=v_sub.id;
  UPDATE public.renewals SET status='renewed',renewed_at=now(),linked_new_sale_id=v_sale_id,completion_idempotency_key=p_idempotency_key,snoozed_until=NULL WHERE id=v_renewal.id;
  INSERT INTO public.renewals(subscription_id,customer_id,due_date,status,is_demo) VALUES(v_sub.id,v_sub.customer_id,v_end,'pending',v_renewal.is_demo) ON CONFLICT DO NOTHING;
  PERFORM public.log_activity('renewal_complete','Completed renewal with sale '||v_sale_number,'renewal',v_renewal.id,NULL,jsonb_build_object('sale_id',v_sale_id,'subscription_id',v_sub.id));
  RETURN jsonb_build_object('sale_id',v_sale_id,'sale_number',v_sale_number,'customer_id',v_renewal.customer_id,'subscription_id',v_sub.id,'next_renewal_date',v_end,'payment_status',v_payment_status,'idempotent_replay',false);
END;$function$;
REVOKE ALL ON FUNCTION public.complete_renewal(uuid,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.complete_renewal(uuid,jsonb,text) TO authenticated;

-- -----------------------------------------------------------------------------
-- API-key permission hardening. Missing or malformed permissions mean no access.
-- -----------------------------------------------------------------------------
ALTER TABLE public.api_keys ALTER COLUMN permissions SET DEFAULT '[]'::jsonb;
DROP FUNCTION IF EXISTS public.create_api_key(text,timestamptz);
DROP FUNCTION IF EXISTS public.create_api_key(text,timestamptz,text[]);

CREATE FUNCTION public.create_api_key(p_name text,p_expires_at timestamptz,p_permissions text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE v_id uuid; v_raw text; v_hash text; v_prefix text; v_allowed constant text[]:=ARRAY['*','dashboard:read','sales:read','sales:write','payments:read','payments:write','customers:read','customers:write','products:read','products:write','categories:read','categories:write','renewals:read','renewals:write','subscriptions:read','reports:read'];
BEGIN
  IF NOT public.is_owner() THEN RAISE EXCEPTION 'Only the owner can create API keys'; END IF;
  IF p_name IS NULL OR btrim(p_name)='' THEN RAISE EXCEPTION 'API key name is required'; END IF;
  IF p_permissions IS NULL OR cardinality(p_permissions)=0 OR EXISTS(SELECT 1 FROM unnest(p_permissions) p WHERE NOT p=ANY(v_allowed)) OR ('*'=ANY(p_permissions) AND cardinality(p_permissions)<>1) THEN RAISE EXCEPTION 'Invalid API key permissions'; END IF;
  v_raw:='dxo_live_'||rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'='); v_hash:=encode(extensions.digest(v_raw,'sha256'),'hex'); v_prefix:=left(v_raw,12);
  INSERT INTO public.api_keys(name,key_prefix,key_hash,created_by,expires_at,permissions) VALUES(btrim(p_name),v_prefix,v_hash,auth.uid(),p_expires_at,to_jsonb(p_permissions)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('key_id',v_id,'api_key',v_raw,'key_prefix',v_prefix,'name',btrim(p_name),'permissions',to_jsonb(p_permissions));
END;$function$;
REVOKE ALL ON FUNCTION public.create_api_key(text,timestamptz,text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_api_key(text,timestamptz,text[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.validate_api_key(p_key_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$ DECLARE v public.api_keys%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.api_keys WHERE key_hash=p_key_hash;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT v.is_active OR v.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('valid',false,'reason','revoked'); END IF;
  IF v.expires_at IS NOT NULL AND v.expires_at<=now() THEN RETURN jsonb_build_object('valid',false,'reason','expired'); END IF;
  IF jsonb_typeof(v.permissions)<>'array' OR jsonb_array_length(v.permissions)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v.permissions) p WHERE jsonb_typeof(p)<>'string') THEN RETURN jsonb_build_object('valid',false,'reason','invalid_permissions'); END IF;
  RETURN jsonb_build_object('valid',true,'key_id',v.id,'key_name',v.name,'permissions',v.permissions);
END;$function$;
REVOKE ALL ON FUNCTION public.validate_api_key(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_api_key(text) TO service_role;
