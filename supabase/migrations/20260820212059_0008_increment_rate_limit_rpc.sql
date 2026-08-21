/*
# Add increment_rate_limit RPC for atomic rate-limit counting

## Purpose
The Edge Function's rate-limit middleware needs an atomic increment operation
to count requests per minute window. This function does an INSERT ... ON CONFLICT
upsert that atomically increments the counter, avoiding race conditions between
concurrent Edge Function instances.

## New Function
- increment_rate_limit(p_bucket_key, p_window_start, p_limit) — service-role only
  Inserts a new rate-limit bucket or increments an existing one atomically.
  Returns the current count after increment.

## Security
- SECURITY DEFINER, SET search_path = ''
- REVOKE EXECUTE FROM PUBLIC, anon, authenticated
- No grant to any role — only the service role can call it (bypasses GRANT checks)
*/

CREATE OR REPLACE FUNCTION public.increment_rate_limit(
  p_bucket_key text,
  p_window_start timestamptz,
  p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.api_rate_limits (bucket_key, window_start, count, limit_value)
  VALUES (p_bucket_key, p_window_start, 1, p_limit)
  ON CONFLICT (bucket_key)
  DO UPDATE SET count = public.api_rate_limits.count + 1
  RETURNING count INTO v_count;

  RETURN jsonb_build_object('count', v_count);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.increment_rate_limit(text, timestamptz, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_rate_limit(text, timestamptz, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_rate_limit(text, timestamptz, integer) FROM authenticated;
