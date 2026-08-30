// Scope-checking middleware.
// Checks the required scope against the already-validated ApiKeyInfo.scopes.
// No database round trip — purely in-memory check.

import type { ApiKeyInfo } from "./auth.ts";
import { errorResponse, jsonResponse } from "./response.ts";
import type { AuditContext } from "./audit.ts";

export function requireScope(
  apiKeyInfo: ApiKeyInfo | null,
  scope: string,
  auditCtx: AuditContext,
  corsHeaders: Record<string, string>
): Response | null {
  if (!apiKeyInfo) {
    const { body, status } = errorResponse("UNAUTHORIZED", "Invalid or missing API key", auditCtx.requestId, 401);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  if (!apiKeyInfo.scopes.includes(scope)) {
    const { body, status } = errorResponse("FORBIDDEN", `Missing required scope: ${scope}`, auditCtx.requestId, 403);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  return null;
}
