/*
# DigiXO Desk API — Phase 1 Hardening

## Purpose
Fixes three correctness and security details in the API foundation without changing
existing application data or removing any columns:
1. Make request-log pagination apply before aggregation.
2. Make rate-limit cleanup return a scalar count when multiple rows are removed.
3. Include the owner's display name in API-key analytics.
4. Explicitly deny direct anon/authenticated table access; owner RPCs remain the only
   browser-facing access path, and the service role remains the only server-side path.

## Security
- All three API tables retain RLS.
- `api_keys`, `api_request_logs`, and `api_rate_limits` have explicit `REVOKE ALL`
  for `anon` and `authenticated`.
- Existing owner and service-role RPC grants remain unchanged.
*/

REVOKE ALL ON public.api_keys FROM anon, authenticated;
REVOKE ALL ON public.api_request_logs FROM anon, authenticated;
REVOKE ALL ON public.api_rate_limits FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.api_rate_limits
  WHERE window_start < now() - interval '2 hours';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limits() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limits() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limits() FROM authenticated;

CREATE OR REPLACE FUNCTION public.get_api_key_analytics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_keys jsonb;
  v_stats jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can view API analytics';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', k.id,
    'integration_name', k.integration_name,
    'key_prefix', k.key_prefix,
    'scopes', k.scopes,
    'is_active', k.is_active,
    'created_at', k.created_at,
    'expires_at', k.expires_at,
    'last_used_at', k.last_used_at,
    'revoked_at', k.revoked_at,
    'rotated_from', k.rotated_from,
    'created_by', k.created_by,
    'created_by_name', p.full_name,
    'request_count', COALESCE(r.cnt, 0),
    'last_request', r.last_req,
    'error_count', COALESCE(r.err_cnt, 0)
  ) ORDER BY k.created_at DESC), '[]'::jsonb) INTO v_keys
  FROM public.api_keys k
  JOIN public.profiles p ON p.id = k.created_by
  LEFT JOIN (
    SELECT
      api_key_id,
      count(*) as cnt,
      max(created_at) as last_req,
      count(*) FILTER (WHERE result IN ('auth_error', 'error', 'rate_limited')) as err_cnt
    FROM public.api_request_logs
    GROUP BY api_key_id
  ) r ON r.api_key_id = k.id;

  SELECT jsonb_build_object(
    'total_keys', count(*),
    'active_keys', count(*) FILTER (WHERE is_active = true AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())),
    'expired_keys', count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now()),
    'revoked_keys', count(*) FILTER (WHERE revoked_at IS NOT NULL),
    'total_requests', (SELECT count(*) FROM public.api_request_logs),
    'requests_today', (SELECT count(*) FROM public.api_request_logs WHERE created_at >= CURRENT_DATE)
  ) INTO v_stats
  FROM public.api_keys;

  RETURN jsonb_build_object('keys', v_keys, 'stats', v_stats);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_api_key_analytics() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_api_key_analytics() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_api_key_analytics() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_api_request_logs(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_logs jsonb;
  v_total integer;
  v_safe_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_safe_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can view API request logs';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', x.id,
    'request_id', x.request_id,
    'api_key_id', x.api_key_id,
    'integration_name', x.integration_name,
    'endpoint', x.endpoint,
    'method', x.method,
    'action', x.action,
    'status_code', x.status_code,
    'result', x.result,
    'ip_address', x.ip_address,
    'duration_ms', x.duration_ms,
    'error_message', x.error_message,
    'created_at', x.created_at
  ) ORDER BY x.created_at DESC), '[]'::jsonb)
  INTO v_logs
  FROM (
    SELECT l.id, l.request_id, l.api_key_id, k.integration_name,
      l.endpoint, l.method, l.action, l.status_code, l.result,
      l.ip_address, l.duration_ms, l.error_message, l.created_at
    FROM public.api_request_logs l
    LEFT JOIN public.api_keys k ON k.id = l.api_key_id
    ORDER BY l.created_at DESC
    LIMIT v_safe_limit OFFSET v_safe_offset
  ) x;

  SELECT count(*) INTO v_total FROM public.api_request_logs;

  RETURN jsonb_build_object('logs', v_logs, 'total', v_total, 'limit', v_safe_limit, 'offset', v_safe_offset);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_api_request_logs(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_api_request_logs(integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_api_request_logs(integer, integer) TO authenticated;
