// API key authentication middleware.
// Extracts the Bearer token from the Authorization header, hashes it with SHA-256,
// validates against the database, and attaches key info to the request context.
// NEVER logs raw keys, key hashes, or Authorization headers.

import { createClient } from "npm:@supabase/supabase-js@2.112.0";

export interface ApiKeyInfo {
  id: string;
  integration_name: string;
  integration_id: string;
  scopes: string[];
  key_prefix: string;
}

// SHA-256 hash using Web Crypto API (available in Deno)
export async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  const token = parts[1].trim();
  if (!token) return null;
  return token;
}

export async function validateApiKey(
  supabase: ReturnType<typeof createClient>,
  token: string
): Promise<ApiKeyInfo | null> {
  const keyHash = await hashKey(token);
  const { data, error } = await supabase.rpc("validate_api_key", { p_key_hash: keyHash });

  if (error || !data) {
    return null;
  }

  return data as ApiKeyInfo;
}

export async function touchLastUsed(
  supabase: ReturnType<typeof createClient>,
  keyId: string
): Promise<void> {
  await supabase.rpc("touch_api_key_last_used", { p_key_id: keyId });
}
