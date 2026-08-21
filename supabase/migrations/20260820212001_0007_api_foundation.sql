/*
# DigiXO Desk API — Phase 1: Secure API Foundation

## Purpose
Creates the database layer for a versioned, server-side API built on a Supabase Edge Function.
This migration adds three new tables, seven SECURITY DEFINER functions, RLS policies, and
explicit column grants. No existing tables, policies, or data are modified.

## New Tables

### 1. api_keys
Stores metadata and a SHA-256 hash (never the raw key) for each DigiXO Desk integration key.
- id (uuid, PK)
- integration_name (text, not null) — human label, e.g. "Store Bot"
- key_prefix (text, not null) — first 12 chars of the plaintext key, safe to display
- key_hash (text, not null, unique) — SHA-256 hash of the full key
- scopes (text[], not null, default '{}') — from a fixed allowlist
- is_active (boolean, not null, default true)
- created_by (uuid, FK profiles, not null)
- created_at (timestamptz, default now())
- expires_at (timestamptz, nullable) — optional expiry
- last_used_at (timestamptz, nullable) — updated on each validated request
- revoked_at (timestamptz, nullable) — set when revoked
- rotated_from (uuid, nullable, FK api_keys) — links new key to old key on rotation

### 2. api_request_logs
Audit trail of every API request — successful or not.
- id (uuid, PK)
- request_id (text, not null) — UUID generated per request
- api_key_id (uuid, nullable, FK api_keys) — null if key was invalid/missing
- endpoint (text, not null)
- method (text, not null)
- action (text, not null)
- status_code (integer, not null)
- result (text, not null) — success, auth_error, rate_limited, error
- ip_address (text, nullable)
- user_agent (text, nullable)
- duration_ms (integer, nullable)
- error_message (text, nullable) — redacted, never contains raw keys or stack traces
- created_at (timestamptz, default now())

### 3. api_rate_limits
Durable fixed-window counter store for rate limiting (Edge Function instances share no memory).
- bucket_key (text, PK) — composite key, e.g. "key_id:minute_window"
- window_start (timestamptz, not null)
- count (integer, not null, default 0)
- limit_value (integer, not null)
- last_cleanup_at (timestamptz, nullable) — tracks when cleanup last ran

## New Functions (all SECURITY DEFINER, SET search_path = '', REVOKE from PUBLIC/anon)

### Owner-only (granted to authenticated, checks is_owner() internally):
1. create_api_key(p_integration_name, p_scopes, p_expires_at) — generates dxo_live_ + 32 random bytes, stores hash, returns plaintext once
2. rotate_api_key(p_key_id) — revokes old key, creates new with rotated_from link, returns new plaintext once
3. revoke_api_key(p_key_id) — sets is_active=false, revoked_at=now()
4. get_api_key_analytics() — returns aggregated usage summaries for the admin page
5. get_api_request_logs(p_limit, p_offset) — returns paginated raw request logs (no key hashes)

### Service-role only (granted to service_role, revoked from authenticated/anon):
6. validate_api_key(p_key_hash) — returns id/integration_name/scopes or null; rejects expired/revoked
7. log_api_request(p_request_id, p_api_key_id, p_endpoint, p_method, p_action, p_status_code, p_result, p_ip_address, p_user_agent, p_duration_ms, p_error_message) — inserts audit row
8. touch_api_key_last_used(p_key_id) — updates last_used_at
9. cleanup_rate_limits() — deletes rows older than 2 hours; called at most once per hour by the Edge Function

## Security
- RLS enabled on all three new tables.
- No anon access on any table.
- api_keys: owner-only SELECT/INSERT/UPDATE via is_owner() policies.
- api_request_logs: no direct frontend access; owner reads via get_api_request_logs RPC only.
- api_rate_limits: no direct frontend access at all (no policies for authenticated or anon).
- Explicit grants: REVOKE all from anon on all three tables.
- All functions: SET search_path = '', REVOKE EXECUTE FROM PUBLIC and anon, internal auth checks.
- pgcrypto functions (gen_random_bytes, digest) are in the extensions schema and fully qualified.
- pg_cron is not available; rate-limit cleanup uses a low-frequency fallback (at most once per hour).

## Important Notes
1. No existing tables, columns, policies, or data are modified.
2. Raw API keys are never stored in any table — only SHA-256 hashes.
3. Expired and revoked keys remain stored for audit history; validation rejects them.
4. Scope values are validated against a fixed allowlist in create_api_key.
*/

-- =========================================================
-- 1. api_keys table
-- =========================================================
CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  rotated_from uuid REFERENCES public.api_keys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON public.api_keys (key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON public.api_keys (is_active) WHERE is_active = true;

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Owner-only SELECT
DROP POLICY IF EXISTS "api_keys_select_owner" ON public.api_keys;
CREATE POLICY "api_keys_select_owner" ON public.api_keys
  FOR SELECT TO authenticated
  USING (public.is_owner());

-- Owner-only INSERT (the create_api_key RPC inserts on behalf of the owner)
DROP POLICY IF EXISTS "api_keys_insert_owner" ON public.api_keys;
CREATE POLICY "api_keys_insert_owner" ON public.api_keys
  FOR INSERT TO authenticated
  WITH CHECK (public.is_owner());

-- Owner-only UPDATE (for last_used_at, is_active, revoked_at updates via RPCs)
DROP POLICY IF EXISTS "api_keys_update_owner" ON public.api_keys;
CREATE POLICY "api_keys_update_owner" ON public.api_keys
  FOR UPDATE TO authenticated
  USING (public.is_owner()) WITH CHECK (public.is_owner());

-- No DELETE policy — keys are never deleted, only revoked.

-- Revoke all from anon
REVOKE ALL ON public.api_keys FROM anon;

-- =========================================================
-- 2. api_request_logs table
-- =========================================================
CREATE TABLE IF NOT EXISTS public.api_request_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  endpoint text NOT NULL,
  method text NOT NULL,
  action text NOT NULL,
  status_code integer NOT NULL,
  result text NOT NULL CHECK (result IN ('success', 'auth_error', 'rate_limited', 'error')),
  ip_address text,
  user_agent text,
  duration_ms integer,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_request_logs_key_id ON public.api_request_logs (api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_request_logs_created_at ON public.api_request_logs (created_at DESC);

ALTER TABLE public.api_request_logs ENABLE ROW LEVEL SECURITY;

-- No policies for authenticated or anon — only the service role (via log_api_request RPC) can write,
-- and the owner reads via get_api_request_logs RPC (SECURITY DEFINER, bypasses RLS).
-- Explicitly revoke all from anon and authenticated.
REVOKE ALL ON public.api_request_logs FROM anon;
REVOKE ALL ON public.api_request_logs FROM authenticated;

-- =========================================================
-- 3. api_rate_limits table
-- =========================================================
CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  limit_value integer NOT NULL,
  last_cleanup_at timestamptz
);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

-- No policies — no frontend access at all. Only the service role accesses this via RPCs.
REVOKE ALL ON public.api_rate_limits FROM anon;
REVOKE ALL ON public.api_rate_limits FROM authenticated;

-- =========================================================
-- 4. create_api_key function (owner-only)
-- =========================================================
CREATE OR REPLACE FUNCTION public.create_api_key(
  p_integration_name text,
  p_scopes text[],
  p_expires_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_raw_bytes bytea;
  v_raw_key text;
  v_key_hash text;
  v_key_prefix text;
  v_key_id uuid;
  v_scope text;
  v_valid_scopes text[] := ARRAY[
    'catalog:read', 'customers:read', 'customers:create', 'customers:update',
    'sales:read', 'sales:create', 'payments:create', 'fulfilment:update',
    'renewals:read', 'renewals:update', 'reports:read'
  ];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can create API keys';
  END IF;

  IF p_integration_name IS NULL OR btrim(p_integration_name) = '' THEN
    RAISE EXCEPTION 'Integration name is required';
  END IF;

  -- Validate scopes against allowlist
  IF p_scopes IS NOT NULL THEN
    FOREACH v_scope IN ARRAY p_scopes LOOP
      IF NOT (v_scope = ANY(v_valid_scopes)) THEN
        RAISE EXCEPTION 'Invalid scope: %', v_scope;
      END IF;
    END LOOP;
  END IF;

  -- Generate 32 cryptographically random bytes
  v_raw_bytes := extensions.gen_random_bytes(32);
  -- Encode as base64url: replace +/ with -_ and strip = padding
  v_raw_key := 'dxo_live_' || replace(replace(encode(v_raw_bytes, 'base64'), '+', '-'), '/', '_');
  v_raw_key := regexp_replace(v_raw_key, '=+$', '');

  -- Hash with SHA-256
  v_key_hash := encode(extensions.digest(v_raw_key, 'sha256'), 'hex');

  -- Prefix is first 12 chars (dxo_live_ + 3 chars of key)
  v_key_prefix := substr(v_raw_key, 1, 12);

  -- Insert the key record
  INSERT INTO public.api_keys (
    integration_name, key_prefix, key_hash, scopes,
    is_active, created_by, expires_at
  ) VALUES (
    p_integration_name, v_key_prefix, v_key_hash, COALESCE(p_scopes, ARRAY[]::text[]),
    true, auth.uid(), p_expires_at
  ) RETURNING id INTO v_key_id;

  -- Log activity
  PERFORM public.log_activity(
    'api_key_created',
    'API key created for integration: ' || p_integration_name,
    'api_key',
    v_key_id,
    NULL,
    jsonb_build_object('integration_name', p_integration_name, 'scopes', COALESCE(p_scopes, ARRAY[]::text[]), 'key_prefix', v_key_prefix)
  );

  -- Return the plaintext key exactly once
  RETURN jsonb_build_object(
    'key_id', v_key_id,
    'api_key', v_raw_key,
    'key_prefix', v_key_prefix,
    'integration_name', p_integration_name
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_api_key(text, text[], timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_api_key(text, text[], timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_api_key(text, text[], timestamptz) TO authenticated;

-- =========================================================
-- 5. rotate_api_key function (owner-only)
-- =========================================================
CREATE OR REPLACE FUNCTION public.rotate_api_key(
  p_key_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_old_key RECORD;
  v_raw_bytes bytea;
  v_raw_key text;
  v_key_hash text;
  v_key_prefix text;
  v_new_key_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can rotate API keys';
  END IF;

  SELECT * INTO v_old_key FROM public.api_keys WHERE id = p_key_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'API key not found';
  END IF;

  -- Generate new key
  v_raw_bytes := extensions.gen_random_bytes(32);
  v_raw_key := 'dxo_live_' || replace(replace(encode(v_raw_bytes, 'base64'), '+', '-'), '/', '_');
  v_raw_key := regexp_replace(v_raw_key, '=+$', '');
  v_key_hash := encode(extensions.digest(v_raw_key, 'sha256'), 'hex');
  v_key_prefix := substr(v_raw_key, 1, 12);

  -- Revoke old key
  UPDATE public.api_keys
  SET is_active = false, revoked_at = now()
  WHERE id = p_key_id;

  -- Create new key linked to old
  INSERT INTO public.api_keys (
    integration_name, key_prefix, key_hash, scopes,
    is_active, created_by, expires_at, rotated_from
  ) VALUES (
    v_old_key.integration_name, v_key_prefix, v_key_hash, v_old_key.scopes,
    true, auth.uid(), v_old_key.expires_at, p_key_id
  ) RETURNING id INTO v_new_key_id;

  PERFORM public.log_activity(
    'api_key_rotated',
    'API key rotated for integration: ' || v_old_key.integration_name,
    'api_key',
    v_new_key_id,
    NULL,
    jsonb_build_object('old_key_id', p_key_id, 'new_key_prefix', v_key_prefix)
  );

  RETURN jsonb_build_object(
    'key_id', v_new_key_id,
    'api_key', v_raw_key,
    'key_prefix', v_key_prefix,
    'integration_name', v_old_key.integration_name
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rotate_api_key(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rotate_api_key(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rotate_api_key(uuid) TO authenticated;

-- =========================================================
-- 6. revoke_api_key function (owner-only)
-- =========================================================
CREATE OR REPLACE FUNCTION public.revoke_api_key(
  p_key_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_key RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can revoke API keys';
  END IF;

  SELECT * INTO v_key FROM public.api_keys WHERE id = p_key_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'API key not found';
  END IF;

  UPDATE public.api_keys
  SET is_active = false, revoked_at = now()
  WHERE id = p_key_id;

  PERFORM public.log_activity(
    'api_key_revoked',
    'API key revoked for integration: ' || v_key.integration_name,
    'api_key',
    p_key_id
  );

  RETURN jsonb_build_object('key_id', p_key_id, 'revoked', true);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.revoke_api_key(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.revoke_api_key(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.revoke_api_key(uuid) TO authenticated;

-- =========================================================
-- 7. validate_api_key function (service-role only)
-- =========================================================
CREATE OR REPLACE FUNCTION public.validate_api_key(
  p_key_hash text
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT jsonb_build_object(
    'id', k.id,
    'integration_name', k.integration_name,
    'scopes', k.scopes,
    'key_prefix', k.key_prefix
  )
  FROM public.api_keys k
  WHERE k.key_hash = p_key_hash
    AND k.is_active = true
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now());
$function$;

REVOKE EXECUTE ON FUNCTION public.validate_api_key(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_api_key(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.validate_api_key(text) FROM authenticated;
-- No grant to authenticated — only the service role (which bypasses GRANT checks) can call this.

-- =========================================================
-- 8. log_api_request function (service-role only)
-- =========================================================
CREATE OR REPLACE FUNCTION public.log_api_request(
  p_request_id text,
  p_api_key_id uuid,
  p_endpoint text,
  p_method text,
  p_action text,
  p_status_code integer,
  p_result text,
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_duration_ms integer DEFAULT NULL,
  p_error_message text DEFAULT NULL
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  INSERT INTO public.api_request_logs (
    request_id, api_key_id, endpoint, method, action,
    status_code, result, ip_address, user_agent, duration_ms, error_message
  ) VALUES (
    p_request_id, p_api_key_id, p_endpoint, p_method, p_action,
    p_status_code, p_result, p_ip_address, p_user_agent, p_duration_ms, p_error_message
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.log_api_request(text, uuid, text, text, text, integer, text, text, text, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_api_request(text, uuid, text, text, text, integer, text, text, text, integer, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.log_api_request(text, uuid, text, text, text, integer, text, text, text, integer, text) FROM authenticated;

-- =========================================================
-- 9. touch_api_key_last_used function (service-role only)
-- =========================================================
CREATE OR REPLACE FUNCTION public.touch_api_key_last_used(
  p_key_id uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  UPDATE public.api_keys
  SET last_used_at = now()
  WHERE id = p_key_id;
$function$;

REVOKE EXECUTE ON FUNCTION public.touch_api_key_last_used(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.touch_api_key_last_used(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.touch_api_key_last_used(uuid) FROM authenticated;

-- =========================================================
-- 10. cleanup_rate_limits function (service-role only)
-- =========================================================
CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  DELETE FROM public.api_rate_limits
  WHERE window_start < now() - interval '2 hours'
  RETURNING 1;
$function$;

REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limits() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limits() FROM anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_rate_limits() FROM authenticated;

-- =========================================================
-- 11. get_api_key_analytics function (owner-only)
-- =========================================================
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
    'request_count', COALESCE(r.cnt, 0),
    'last_request', r.last_req,
    'error_count', COALESCE(r.err_cnt, 0)
  ) ORDER BY k.created_at DESC), '[]'::jsonb) INTO v_keys
  FROM public.api_keys k
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

-- =========================================================
-- 12. get_api_request_logs function (owner-only, paginated)
-- =========================================================
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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Only the owner can view API request logs';
  END IF;

  IF p_limit > 200 THEN
    p_limit := 200;
  END IF;
  IF p_limit < 1 THEN
    p_limit := 50;
  END IF;
  IF p_offset < 0 THEN
    p_offset := 0;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', l.id,
    'request_id', l.request_id,
    'api_key_id', l.api_key_id,
    'integration_name', k.integration_name,
    'endpoint', l.endpoint,
    'method', l.method,
    'action', l.action,
    'status_code', l.status_code,
    'result', l.result,
    'ip_address', l.ip_address,
    'duration_ms', l.duration_ms,
    'error_message', l.error_message,
    'created_at', l.created_at
  ) ORDER BY l.created_at DESC), '[]'::jsonb) INTO v_logs
  FROM public.api_request_logs l
  LEFT JOIN public.api_keys k ON k.id = l.api_key_id
  LIMIT p_limit OFFSET p_offset;

  SELECT count(*) INTO v_total FROM public.api_request_logs;

  RETURN jsonb_build_object('logs', v_logs, 'total', v_total, 'limit', p_limit, 'offset', p_offset);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_api_request_logs(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_api_request_logs(integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_api_request_logs(integer, integer) TO authenticated;
