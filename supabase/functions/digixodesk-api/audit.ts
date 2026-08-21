// Audit logging middleware.
// Logs every API request with redacted error information.
// NEVER logs raw keys, key hashes, Authorization headers, SQL errors, or stack traces.

import { createClient } from "npm:@supabase/supabase-js@2.112.0";

export interface AuditContext {
  requestId: string;
  apiKeyId: string | null;
  endpoint: string;
  method: string;
  action: string;
  startTime: number;
  ipAddress: string | null;
  userAgent: string | null;
}

export function createAuditContext(req: Request, path: string, action: string): AuditContext {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();

  // Best-effort IP extraction
  const ipAddress =
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    req.headers.get("X-Real-IP") ||
    null;

  // Truncate user agent
  const userAgent = req.headers.get("User-Agent")?.slice(0, 200) || null;

  return {
    requestId,
    apiKeyId: null,
    endpoint: path,
    method: req.method,
    action,
    startTime,
    ipAddress,
    userAgent,
  };
}

// Redact error messages — never expose SQL errors, key material, or stack traces
export function redactError(err: unknown): string {
  if (!err) return "Unknown error";

  const message = err instanceof Error ? err.message : String(err);

  // Never expose anything that looks like a key, hash, or SQL fragment
  if (/dxo_live_|key_hash|authorization|bearer|select |insert |update |delete |drop |stack|at\s+\w+\.\w+:\d+/i.test(message)) {
    return "Internal error";
  }

  // Truncate long messages
  if (message.length > 200) {
    return message.slice(0, 200);
  }

  return message;
}

export async function logAudit(
  supabase: ReturnType<typeof createClient>,
  ctx: AuditContext,
  statusCode: number,
  result: string,
  errorMessage: string | null
): Promise<void> {
  const durationMs = Date.now() - ctx.startTime;

  try {
    await supabase.rpc("log_api_request", {
      p_request_id: ctx.requestId,
      p_api_key_id: ctx.apiKeyId,
      p_endpoint: ctx.endpoint,
      p_method: ctx.method,
      p_action: ctx.action,
      p_status_code: statusCode,
      p_result: result,
      p_ip_address: ctx.ipAddress,
      p_user_agent: ctx.userAgent,
      p_duration_ms: durationMs,
      p_error_message: errorMessage,
    });
  } catch {
    // If audit logging fails, do not expose the error to the caller.
    // The request itself should still succeed or fail based on its own logic.
  }
}
