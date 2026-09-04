-- Use deterministic search paths for public utility and trigger functions.
ALTER FUNCTION public.normalize_phone(text) SET search_path = '';
ALTER FUNCTION public.touch_updated_at() SET search_path = '';
ALTER FUNCTION public.assign_sale_number() SET search_path = '';

-- Trigger functions are invoked by PostgreSQL and should not be RPC endpoints.
REVOKE ALL ON FUNCTION public.guard_payments_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_payments_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_sales_payment_status() FROM PUBLIC, anon, authenticated;

-- Authentication helpers and business RPCs must not be callable anonymously.
REVOKE ALL ON FUNCTION public.is_active_user() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_owner() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.log_activity(text, text, text, uuid, jsonb, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sale_outstanding(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_plan_prices(uuid, numeric, numeric, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_activity(text, text, text, uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sale_outstanding(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_plan_prices(uuid, numeric, numeric, boolean) TO authenticated;
