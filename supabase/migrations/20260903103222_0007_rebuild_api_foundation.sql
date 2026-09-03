/*
# Rebuild API Foundation — Full Admin API for AI Agent Control

## Purpose
Replaces the entire old API layer with a clean, simple design where every
API key grants full admin access to all DigiXO Desk resources. Designed for
AI agents like Hermes to control the panel programmatically.

## Changes
1. Drop old API objects (tables, functions, columns)
2. Create new api_keys table (no scopes — full admin)
3. Create new api_request_logs table
4. RLS: owner-only on both tables
5. RPCs: create/rotate/revoke/get keys, validate key, log requests
*/

-- =========================================================
-- 1. Drop old API objects
-- =========================================================

-- Drop old public API RPCs first
DROP FUNCTION IF EXISTS public.api_create_sale(jsonb, uuid, text);
DROP FUNCTION IF EXISTS public.api_add_payment(uuid, numeric, uuid, text, text, text, date, text);
DROP FUNCTION IF EXISTS public.api_create_customer(text, text, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.api_update_customer(uuid, jsonb, uuid);
DROP FUNCTION IF EXISTS public.api_update_fulfilment(uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.api_update_renewal(uuid, uuid, text, date, text);
DROP FUNCTION IF EXISTS public.api_get_reports_summary(date, date);
DROP FUNCTION IF EXISTS public.create_api_key(text, text[], timestamptz);
DROP FUNCTION IF EXISTS public.rotate_api_key(uuid);
DROP FUNCTION IF EXISTS public.revoke_api_key(uuid);
DROP FUNCTION IF EXISTS public.get_api_key_analytics();
DROP FUNCTION IF EXISTS public.get_api_request_logs(integer, integer);
DROP FUNCTION IF EXISTS public.validate_api_key(text);
DROP FUNCTION IF EXISTS public.touch_api_key_last_used(uuid);
DROP FUNCTION IF EXISTS public.log_api_request(text, uuid, text, text, text, integer, text, text, text, integer, text);
DROP FUNCTION IF EXISTS public.cleanup_rate_limits();
DROP FUNCTION IF EXISTS public.increment_rate_limit(text, timestamptz, integer);

-- Drop internal schema entirely
DROP SCHEMA IF EXISTS internal CASCADE;

-- Drop FK constraints from sales that reference api_keys
ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_created_via_api_key_id_fkey;

-- Drop columns added by old API migrations from sales
ALTER TABLE public.sales DROP COLUMN IF EXISTS sale_source;
ALTER TABLE public.sales DROP COLUMN IF EXISTS external_reference;
ALTER TABLE public.sales DROP COLUMN IF EXISTS salesperson_id;
ALTER TABLE public.sales DROP COLUMN IF EXISTS salesperson_name;
ALTER TABLE public.sales DROP COLUMN IF EXISTS created_via_api_key_id;
ALTER TABLE public.sales DROP COLUMN IF EXISTS created_via_integration_id;

-- Drop idempotency_key from payments
ALTER TABLE public.payments DROP COLUMN IF EXISTS idempotency_key;

-- Now drop old API tables
DROP TABLE IF EXISTS public.api_rate_limits;
DROP TABLE IF EXISTS public.api_request_logs;
DROP TABLE IF EXISTS public.api_keys;

-- =========================================================
-- 2. New api_keys table
-- =========================================================
CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text UNIQUE NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz,
  rotated_from uuid REFERENCES public.api_keys(id) ON DELETE SET NULL
);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_select_api_keys" ON public.api_keys;
CREATE POLICY "owner_select_api_keys" ON public.api_keys
  FOR SELECT TO authenticated
  USING (public.is_owner());

DROP POLICY IF EXISTS "owner_insert_api_keys" ON public.api_keys;
CREATE POLICY "owner_insert_api_keys" ON public.api_keys
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "owner_update_api_keys" ON public.api_keys;
CREATE POLICY "owner_update_api_keys" ON public.api_keys
  FOR UPDATE TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "owner_delete_api_keys" ON public.api_keys;
CREATE POLICY "owner_delete_api_keys" ON public.api_keys
  FOR DELETE TO authenticated
  USING (public.is_owner());

-- =========================================================
-- 3. New api_request_logs table
-- =========================================================
CREATE TABLE IF NOT EXISTS public.api_request_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  key_name text,
  endpoint text NOT NULL,
  method text NOT NULL,
  status_code integer NOT NULL,
  ip_address text,
  duration_ms integer,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.api_request_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_select_api_request_logs" ON public.api_request_logs;
CREATE POLICY "owner_select_api_request_logs" ON public.api_request_logs
  FOR SELECT TO authenticated
  USING (public.is_owner());

-- =========================================================
-- 4. RPCs
-- =========================================================

-- create_api_key
CREATE OR REPLACE FUNCTION public.create_api_key(
  p_name text,
  p_expires_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_key_id uuid;
  v_raw_key text;
  v_key_hash text;
  v_key_prefix text;
  v_random_bytes text;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can create API keys';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'API key name is required';
  END IF;

  v_random_bytes := encode(extensions.gen_random_bytes(32), 'base64');
  v_random_bytes := replace(replace(v_random_bytes, '+', '-'), '/', '_');
  v_raw_key := 'dxo_live_' || btrim(v_random_bytes, '=');
  v_key_hash := encode(extensions.digest(v_raw_key, 'sha256'), 'hex');
  v_key_prefix := left(v_raw_key, 12);

  INSERT INTO public.api_keys (name, key_prefix, key_hash, created_by, expires_at)
  VALUES (p_name, v_key_prefix, v_key_hash, auth.uid(), p_expires_at)
  RETURNING id INTO v_key_id;

  RETURN jsonb_build_object(
    'key_id', v_key_id,
    'api_key', v_raw_key,
    'key_prefix', v_key_prefix,
    'name', p_name
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_api_key(text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_api_key(text, timestamptz) TO authenticated;

-- rotate_api_key
CREATE OR REPLACE FUNCTION public.rotate_api_key(p_key_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_old_key RECORD;
  v_raw_key text;
  v_key_hash text;
  v_key_prefix text;
  v_random_bytes text;
  v_new_id uuid;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can rotate API keys';
  END IF;

  SELECT * INTO v_old_key FROM public.api_keys WHERE id = p_key_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active API key not found';
  END IF;

  UPDATE public.api_keys SET is_active = false, revoked_at = now()
  WHERE id = p_key_id;

  v_random_bytes := encode(extensions.gen_random_bytes(32), 'base64');
  v_random_bytes := replace(replace(v_random_bytes, '+', '-'), '/', '_');
  v_raw_key := 'dxo_live_' || btrim(v_random_bytes, '=');
  v_key_hash := encode(extensions.digest(v_raw_key, 'sha256'), 'hex');
  v_key_prefix := left(v_raw_key, 12);

  INSERT INTO public.api_keys (name, key_prefix, key_hash, created_by, expires_at, rotated_from)
  VALUES (v_old_key.name, v_key_prefix, v_key_hash, auth.uid(), v_old_key.expires_at, p_key_id)
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'key_id', v_new_id,
    'api_key', v_raw_key,
    'key_prefix', v_key_prefix,
    'name', v_old_key.name
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rotate_api_key(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_api_key(uuid) TO authenticated;

-- revoke_api_key
CREATE OR REPLACE FUNCTION public.revoke_api_key(p_key_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can revoke API keys';
  END IF;
  UPDATE public.api_keys SET is_active = false, revoked_at = now()
  WHERE id = p_key_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active API key not found';
  END IF;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.revoke_api_key(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_api_key(uuid) TO authenticated;

-- get_api_keys
CREATE OR REPLACE FUNCTION public.get_api_keys()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_keys jsonb;
  v_stats jsonb;
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can view API keys';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', k.id,
      'name', k.name,
      'key_prefix', k.key_prefix,
      'is_active', k.is_active,
      'created_at', k.created_at,
      'last_used_at', k.last_used_at,
      'revoked_at', k.revoked_at,
      'expires_at', k.expires_at,
      'rotated_from', k.rotated_from,
      'created_by', k.created_by,
      'request_count', COALESCE(rq.cnt, 0),
      'last_request', rq.last_req
    )
    ORDER BY k.created_at DESC
  ), '[]'::jsonb) INTO v_keys
  FROM public.api_keys k
  LEFT JOIN LATERAL (
    SELECT count(*) AS cnt, max(created_at) AS last_req
    FROM public.api_request_logs
    WHERE api_key_id = k.id
  ) rq ON true;

  SELECT jsonb_build_object(
    'total_keys', count(*),
    'active_keys', count(*) FILTER (WHERE is_active AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())),
    'revoked_keys', count(*) FILTER (WHERE revoked_at IS NOT NULL),
    'total_requests', COALESCE((SELECT count(*) FROM public.api_request_logs), 0),
    'requests_today', COALESCE((SELECT count(*) FROM public.api_request_logs WHERE created_at >= CURRENT_DATE), 0)
  ) INTO v_stats
  FROM public.api_keys;

  RETURN jsonb_build_object('keys', v_keys, 'stats', v_stats);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_api_keys() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_api_keys() TO authenticated;

-- get_api_request_logs
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
BEGIN
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can view API request logs';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', l.id,
      'request_id', l.request_id,
      'key_name', l.key_name,
      'endpoint', l.endpoint,
      'method', l.method,
      'status_code', l.status_code,
      'ip_address', l.ip_address,
      'duration_ms', l.duration_ms,
      'error_message', l.error_message,
      'created_at', l.created_at
    )
    ORDER BY l.created_at DESC
  ), '[]'::jsonb) INTO v_logs
  FROM public.api_request_logs l
  LIMIT p_limit OFFSET p_offset;

  SELECT count(*) INTO v_total FROM public.api_request_logs;

  RETURN jsonb_build_object(
    'logs', v_logs,
    'total', v_total,
    'limit', p_limit,
    'offset', p_offset
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_api_request_logs(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_api_request_logs(integer, integer) TO authenticated;

-- validate_api_key (service-role only)
CREATE OR REPLACE FUNCTION public.validate_api_key(p_key_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_key RECORD;
BEGIN
  SELECT id, name, is_active, expires_at, revoked_at
  INTO v_key
  FROM public.api_keys
  WHERE key_hash = p_key_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT v_key.is_active OR v_key.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'revoked');
  END IF;

  IF v_key.expires_at IS NOT NULL AND v_key.expires_at <= now() THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'expired');
  END IF;

  RETURN jsonb_build_object(
    'valid', true,
    'key_id', v_key.id,
    'key_name', v_key.name
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.validate_api_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_api_key(text) TO service_role;

-- touch_api_key_last_used
CREATE OR REPLACE FUNCTION public.touch_api_key_last_used(p_key_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  UPDATE public.api_keys SET last_used_at = now() WHERE id = p_key_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.touch_api_key_last_used(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_api_key_last_used(uuid) TO service_role;

-- log_api_request
CREATE OR REPLACE FUNCTION public.log_api_request(
  p_request_id text,
  p_api_key_id uuid,
  p_key_name text,
  p_endpoint text,
  p_method text,
  p_status_code integer,
  p_ip_address text DEFAULT NULL,
  p_duration_ms integer DEFAULT NULL,
  p_error_message text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.api_request_logs (
    request_id, api_key_id, key_name, endpoint, method, status_code,
    ip_address, duration_ms, error_message
  ) VALUES (
    p_request_id, p_api_key_id, p_key_name, p_endpoint, p_method, p_status_code,
    p_ip_address, p_duration_ms, p_error_message
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.log_api_request(text, uuid, text, text, text, integer, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_api_request(text, uuid, text, text, text, integer, text, integer, text) TO service_role;

-- =========================================================
-- 5. Indexes
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON public.api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON public.api_keys (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_api_request_logs_key_id ON public.api_request_logs (api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_request_logs_created ON public.api_request_logs (created_at DESC);
