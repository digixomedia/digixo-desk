-- Dashboard chart data: monthly revenue/profit for last N months
-- Returns array of {month, revenue, profit, cost, count}

CREATE OR REPLACE FUNCTION dashboard_monthly_trends(p_months int DEFAULT 6)
RETURNS TABLE (
  month text,
  revenue numeric,
  cost numeric,
  profit numeric,
  sale_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT
      date_trunc('month', now()) AS this_month_start,
      date_trunc('month', now() - (make_interval(months => GREATEST(p_months - 1, 0)))) AS start_month
  )
  SELECT
    to_char(d.day, 'Mon YY') AS month,
    COALESCE(SUM(s.final_selling_price), 0) AS revenue,
    COALESCE(SUM(s.cost_price_snapshot), 0) AS cost,
    COALESCE(SUM(s.final_selling_price - s.cost_price_snapshot - s.payment_fee), 0) AS profit,
    COUNT(s.id) AS sale_count
  FROM generate_series(
    (SELECT start_month FROM bounds),
    (SELECT this_month_start FROM bounds),
    interval '1 month'
  ) AS d(day)
  LEFT JOIN sales s
    ON date_trunc('month', s.sale_date::timestamptz) = d.day
    AND s.archived_at IS NULL
    AND s.payment_status NOT IN ('cancelled')
  GROUP BY d.day
  ORDER BY d.day;
$$;

-- Revenue by category for current month
CREATE OR REPLACE FUNCTION dashboard_revenue_by_category()
RETURNS TABLE (
  category_name text,
  revenue numeric,
  count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(cat.name, 'Uncategorised') AS category_name,
    COALESCE(SUM(s.final_selling_price), 0) AS revenue,
    COUNT(s.id) AS count
  FROM sales s
  LEFT JOIN product_plans pp ON s.product_plan_id = pp.id
  LEFT JOIN products p ON pp.product_id = p.id
  LEFT JOIN categories cat ON p.category_id = cat.id
  WHERE s.archived_at IS NULL
    AND s.payment_status NOT IN ('cancelled')
    AND s.sale_date >= date_trunc('month', now())
  GROUP BY cat.name
  ORDER BY revenue DESC
  LIMIT 8;
$$;

-- Daily sales for last 7 days
CREATE OR REPLACE FUNCTION dashboard_weekly_sales()
RETURNS TABLE (
  day_label text,
  revenue numeric,
  sale_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT date_trunc('day', now() - interval '6 days') AS start_day
  )
  SELECT
    to_char(d.day, 'Dy') AS day_label,
    COALESCE(SUM(s.final_selling_price), 0) AS revenue,
    COUNT(s.id) AS sale_count
  FROM generate_series(
    (SELECT start_day FROM bounds),
    date_trunc('day', now()),
    interval '1 day'
  ) AS d(day)
  LEFT JOIN sales s
    ON date_trunc('day', s.sale_date::timestamptz) = d.day
    AND s.archived_at IS NULL
    AND s.payment_status NOT IN ('cancelled')
  GROUP BY d.day
  ORDER BY d.day;
$$;

-- Previous month stats for trend comparison
CREATE OR REPLACE FUNCTION dashboard_prev_month_stats()
RETURNS TABLE (
  revenue numeric,
  profit numeric,
  sale_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(s.final_selling_price), 0) AS revenue,
    COALESCE(SUM(s.final_selling_price - s.cost_price_snapshot - s.payment_fee), 0) AS profit,
    COUNT(s.id) AS sale_count
  FROM sales s
  WHERE s.archived_at IS NULL
    AND s.payment_status NOT IN ('cancelled')
    AND s.sale_date >= date_trunc('month', now() - interval '1 month')
    AND s.sale_date < date_trunc('month', now());
$$;
