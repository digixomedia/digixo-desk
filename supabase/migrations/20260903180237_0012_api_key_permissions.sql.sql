/*
# API Key Permissions System

## Overview
Adds a `permissions` column to the `api_keys` table so that keys can have
limited scopes (e.g. read-only for Telegram bots) or full admin access (`["*"]`).

## Changes
1. ALTER TABLE api_keys ADD COLUMN permissions jsonb DEFAULT '["*"]'
2. Update create_api_key to accept p_permissions text[]
3. Update validate_api_key to return permissions in the JSON response
4. Update get_api_keys to return permissions for each key
5. Update rotate_api_key to copy permissions from the old key

## Security
- No data loss — additive column with safe default.
- SECURITY DEFINER functions updated in place.
*/

-- 1. Add permissions column
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '["*"]'::jsonb;

-- 2. Update create_api_key to accept permissions
CREATE OR REPLACE FUNCTION public.create_api_key(
  p_name text,
  p_expires_at timestamptz DEFAULT NULL,
  p_permissions text[] DEFAULT ARRAY['*']::text[]
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

  INSERT INTO public.api_keys (name, key_prefix, key_hash, created_by, expires_at, permissions)
  VALUES (p_name, v_key_prefix, v_key_hash, auth.uid(), p_expires_at, to_jsonb(p_permissions))
  RETURNING id INTO v_key_id;

  RETURN jsonb_build_object(
    'key_id', v_key_id,
    'api_key', v_raw_key,
    'key_prefix', v_key_prefix,
    'name', p_name,
    'permissions', to_jsonb(p_permissions)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.create_api_key(text, timestamptz, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_api_key(text, timestamptz, text[]) TO authenticated;

-- 3. Update validate_api_key to return permissions
CREATE OR REPLACE FUNCTION public.validate_api_key(p_key_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_key RECORD;
BEGIN
  SELECT id, name, is_active, expires_at, revoked_at, permissions
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
    'key_name', v_key.name,
    'permissions', v_key.permissions
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.validate_api_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_api_key(text) TO service_role;

-- 4. Update get_api_keys to return permissions
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
      'permissions', k.permissions,
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

-- 5. Update rotate_api_key to copy permissions
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

  INSERT INTO public.api_keys (name, key_prefix, key_hash, created_by, expires_at, rotated_from, permissions)
  VALUES (v_old_key.name, v_key_prefix, v_key_hash, auth.uid(), v_old_key.expires_at, p_key_id, v_old_key.permissions)
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'key_id', v_new_id,
    'api_key', v_raw_key,
    'key_prefix', v_key_prefix,
    'name', v_old_key.name,
    'permissions', v_old_key.permissions
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rotate_api_key(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_api_key(uuid) TO authenticated;
