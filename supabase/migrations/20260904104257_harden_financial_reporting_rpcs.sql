-- Financial reporting RPCs only read tables that already enforce role-aware RLS.
-- Run them with the caller's privileges so they cannot bypass those policies.
ALTER FUNCTION public.dashboard_monthly_trends(integer) SECURITY INVOKER;
ALTER FUNCTION public.dashboard_revenue_by_category() SECURITY INVOKER;
ALTER FUNCTION public.dashboard_weekly_sales() SECURITY INVOKER;
ALTER FUNCTION public.dashboard_prev_month_stats() SECURITY INVOKER;
ALTER FUNCTION public.sales_financial_summary(text, text, text) SECURITY INVOKER;
ALTER FUNCTION public.sale_financial_detail(uuid) SECURITY INVOKER;
ALTER FUNCTION public.customer_financial_summary(uuid) SECURITY INVOKER;
ALTER FUNCTION public.dashboard_financial_stats() SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.dashboard_monthly_trends(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dashboard_revenue_by_category() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dashboard_weekly_sales() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dashboard_prev_month_stats() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sales_financial_summary(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sale_financial_detail(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.customer_financial_summary(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dashboard_financial_stats() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.dashboard_monthly_trends(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_revenue_by_category() TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_weekly_sales() TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_prev_month_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sales_financial_summary(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sale_financial_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_financial_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_financial_stats() TO authenticated;
