/*
# Financial Accuracy RPCs

## Overview
Adds server-side functions that compute accurate financial summaries from valid payments and refunds.
These replace the client-side calculations that were overstating outstanding amounts by ignoring
payments already collected.

## New Functions

1. `sales_financial_summary(p_search text, p_payment_status text, p_fulfilment_status text)`
   — Returns total_order_value, cash_collected, outstanding, refund_total, net_collected, sale_count
   across all matching sales. Excludes cancelled sales. Outstanding = selling_price - valid_payments - refund_amount.

2. `sale_financial_detail(p_sale_id uuid)`
   — Returns a single sale's accurate financial breakdown:
   total_price, total_paid (valid payments), refund_amount, outstanding, net_collected, profit.

3. `customer_financial_summary(p_customer_id uuid)`
   — Returns total_order_value, cash_collected, outstanding, refund_total, net_collected
   for a single customer across all their non-cancelled sales.

4. `dashboard_financial_stats()`
   — Returns revenue_this_month, cash_received_this_month, expenses_this_month,
   net_profit_this_month, gross_profit_this_month, pending_payments_count,
   activations_pending_count, upcoming_renewals_count, overdue_renewals_count,
   renewals_due_today_count, prev_month_revenue, prev_month_profit.

## Security
- All functions SECURITY DEFINER, search_path = public.
- No data loss — read-only functions.
*/

-- =========================================================
-- sales_financial_summary
-- =========================================================
CREATE OR REPLACE FUNCTION public.sales_financial_summary(
  p_search text DEFAULT NULL,
  p_payment_status text DEFAULT NULL,
  p_fulfilment_status text DEFAULT NULL
)
RETURNS TABLE (
  total_order_value numeric,
  cash_collected numeric,
  outstanding numeric,
  refund_total numeric,
  net_collected numeric,
  sale_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH matching_sales AS (
    SELECT s.id, s.final_selling_price, s.refund_amount, s.payment_status
    FROM sales s
    WHERE s.archived_at IS NULL
      AND s.payment_status NOT IN ('cancelled')
      AND (p_payment_status IS NULL OR p_payment_status = 'all' OR s.payment_status = p_payment_status)
      AND (p_fulfilment_status IS NULL OR p_fulfilment_status = 'all' OR s.fulfilment_status = p_fulfilment_status)
      AND (
        p_search IS NULL OR p_search = '' OR
        s.sale_number ILIKE '%' || p_search || '%' OR
        s.product_name_snapshot ILIKE '%' || p_search || '%' OR
        EXISTS (
          SELECT 1 FROM customers c
          WHERE c.id = s.customer_id
            AND (c.name ILIKE '%' || p_search || '%' OR c.phone_normalized ILIKE '%' || p_search || '%')
        )
      )
  ),
  valid_payments AS (
    SELECT p.sale_id, SUM(p.amount) AS paid
    FROM payments p
    WHERE p.status = 'valid'
      AND p.sale_id IN (SELECT id FROM matching_sales)
    GROUP BY p.sale_id
  )
  SELECT
    COALESCE(SUM(ms.final_selling_price), 0) AS total_order_value,
    COALESCE(SUM(COALESCE(vp.paid, 0)), 0) AS cash_collected,
    COALESCE(SUM(GREATEST(ms.final_selling_price - COALESCE(vp.paid, 0) - ms.refund_amount, 0)), 0) AS outstanding,
    COALESCE(SUM(ms.refund_amount), 0) AS refund_total,
    COALESCE(SUM(COALESCE(vp.paid, 0) - ms.refund_amount), 0) AS net_collected,
    COUNT(*) AS sale_count
  FROM matching_sales ms
  LEFT JOIN valid_payments vp ON vp.sale_id = ms.id;
$$;

-- =========================================================
-- sale_financial_detail
-- =========================================================
CREATE OR REPLACE FUNCTION public.sale_financial_detail(p_sale_id uuid)
RETURNS TABLE (
  total_price numeric,
  total_paid numeric,
  refund_amount numeric,
  outstanding numeric,
  net_collected numeric,
  cost_price numeric,
  payment_fee numeric,
  gross_profit numeric,
  margin_pct numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.final_selling_price AS total_price,
    COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = p_sale_id AND status = 'valid'), 0) AS total_paid,
    s.refund_amount AS refund_amount,
    GREATEST(s.final_selling_price - COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = p_sale_id AND status = 'valid'), 0) - s.refund_amount, 0) AS outstanding,
    COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = p_sale_id AND status = 'valid'), 0) - s.refund_amount AS net_collected,
    s.cost_price_snapshot AS cost_price,
    s.payment_fee AS payment_fee,
    s.final_selling_price - s.cost_price_snapshot - s.payment_fee - s.replacement_cost AS gross_profit,
    CASE WHEN s.final_selling_price > 0
      THEN ROUND(((s.final_selling_price - s.cost_price_snapshot - s.payment_fee - s.replacement_cost) / s.final_selling_price) * 100, 1)
      ELSE 0
    END AS margin_pct
  FROM sales s
  WHERE s.id = p_sale_id;
$$;

-- =========================================================
-- customer_financial_summary
-- =========================================================
CREATE OR REPLACE FUNCTION public.customer_financial_summary(p_customer_id uuid)
RETURNS TABLE (
  total_order_value numeric,
  cash_collected numeric,
  outstanding numeric,
  refund_total numeric,
  net_collected numeric,
  sale_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH customer_sales AS (
    SELECT id, final_selling_price, refund_amount
    FROM sales
    WHERE customer_id = p_customer_id
      AND archived_at IS NULL
      AND payment_status NOT IN ('cancelled')
  ),
  valid_payments AS (
    SELECT sale_id, SUM(amount) AS paid
    FROM payments
    WHERE status = 'valid'
      AND sale_id IN (SELECT id FROM customer_sales)
    GROUP BY sale_id
  )
  SELECT
    COALESCE(SUM(cs.final_selling_price), 0) AS total_order_value,
    COALESCE(SUM(COALESCE(vp.paid, 0)), 0) AS cash_collected,
    COALESCE(SUM(GREATEST(cs.final_selling_price - COALESCE(vp.paid, 0) - cs.refund_amount, 0)), 0) AS outstanding,
    COALESCE(SUM(cs.refund_amount), 0) AS refund_total,
    COALESCE(SUM(COALESCE(vp.paid, 0) - cs.refund_amount), 0) AS net_collected,
    COUNT(*) AS sale_count
  FROM customer_sales cs
  LEFT JOIN valid_payments vp ON vp.sale_id = cs.id;
$$;

-- =========================================================
-- dashboard_financial_stats
-- =========================================================
CREATE OR REPLACE FUNCTION public.dashboard_financial_stats()
RETURNS TABLE (
  revenue_this_month numeric,
  cash_received_this_month numeric,
  expenses_this_month numeric,
  gross_profit_this_month numeric,
  net_profit_this_month numeric,
  pending_payments_count bigint,
  activations_pending_count bigint,
  upcoming_renewals_count bigint,
  overdue_renewals_count bigint,
  renewals_due_today_count bigint,
  prev_month_revenue numeric,
  prev_month_profit numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH month_sales AS (
    SELECT final_selling_price, cost_price_snapshot, payment_fee, replacement_cost, refund_amount, payment_status, fulfilment_status
    FROM sales
    WHERE archived_at IS NULL
      AND sale_date >= date_trunc('month', now())::date
      AND payment_status NOT IN ('cancelled')
  ),
  month_payments AS (
    SELECT COALESCE(SUM(p.amount), 0) AS total
    FROM payments p
    JOIN sales s ON s.id = p.sale_id
    WHERE p.status = 'valid'
      AND p.payment_date >= date_trunc('month', now())::date
  ),
  month_expenses AS (
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM expenses
    WHERE expense_date >= date_trunc('month', now())::date
  ),
  prev_month_sales AS (
    SELECT
      COALESCE(SUM(final_selling_price), 0) AS revenue,
      COALESCE(SUM(final_selling_price - cost_price_snapshot - payment_fee - replacement_cost), 0) AS profit
    FROM sales
    WHERE archived_at IS NULL
      AND payment_status NOT IN ('cancelled')
      AND sale_date >= date_trunc('month', now() - interval '1 month')::date
      AND sale_date < date_trunc('month', now())::date
  ),
  renewal_counts AS (
    SELECT
      COUNT(*) FILTER (WHERE status IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response') AND due_date < CURRENT_DATE) AS overdue,
      COUNT(*) FILTER (WHERE status IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response') AND due_date = CURRENT_DATE) AS due_today,
      COUNT(*) FILTER (WHERE status IN ('pending','reminded','interested','awaiting_payment','snoozed','no_response') AND due_date > CURRENT_DATE AND due_date <= CURRENT_DATE + 30) AS upcoming
    FROM renewals
  )
  SELECT
    COALESCE(SUM(ms.final_selling_price), 0) AS revenue_this_month,
    (SELECT total FROM month_payments) AS cash_received_this_month,
    (SELECT total FROM month_expenses) AS expenses_this_month,
    COALESCE(SUM(ms.final_selling_price - ms.cost_price_snapshot - ms.payment_fee - ms.replacement_cost), 0) AS gross_profit_this_month,
    COALESCE(SUM(ms.final_selling_price - ms.cost_price_snapshot - ms.payment_fee - ms.replacement_cost), 0) - (SELECT total FROM month_expenses) AS net_profit_this_month,
    COUNT(*) FILTER (WHERE ms.payment_status IN ('pending','partial')) AS pending_payments_count,
    COUNT(*) FILTER (WHERE ms.fulfilment_status = 'activation_pending') AS activations_pending_count,
    (SELECT upcoming FROM renewal_counts) AS upcoming_renewals_count,
    (SELECT overdue FROM renewal_counts) AS overdue_renewals_count,
    (SELECT due_today FROM renewal_counts) AS renewals_due_today_count,
    (SELECT revenue FROM prev_month_sales) AS prev_month_revenue,
    (SELECT profit FROM prev_month_sales) AS prev_month_profit
  FROM month_sales ms;
$$;
