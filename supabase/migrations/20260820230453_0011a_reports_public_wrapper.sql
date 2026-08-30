/*
# Phase 2A Fix: Public wrapper for internal.core_get_reports_summary

The Edge Function's supabase.rpc() calls functions via PostgREST, which only
exposes functions in the public schema. This creates a thin public wrapper
that delegates to the internal function. The wrapper is service-role only.
*/

CREATE OR REPLACE FUNCTION public.api_get_reports_summary(
  p_from date,
  p_to date
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT internal.core_get_reports_summary(p_from, p_to);
$function$;

REVOKE EXECUTE ON FUNCTION public.api_get_reports_summary(date, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_get_reports_summary(date, date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.api_get_reports_summary(date, date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.api_get_reports_summary(date, date) TO service_role;
