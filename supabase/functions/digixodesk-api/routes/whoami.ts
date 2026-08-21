// GET /v1/whoami — protected test endpoint.
// Requires a valid DigiXO Desk API key. Returns the integration name and scopes.

import { success, errorResponse, jsonResponse } from "../response.ts";
import type { AuditContext } from "../audit.ts";
import type { ApiKeyInfo } from "../auth.ts";

export async function handleWhoami(
  req: Request,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo | null,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (!apiKeyInfo) {
    const { body, status } = errorResponse("UNAUTHORIZED", "Invalid or missing API key", auditCtx.requestId, 401);
    return jsonResponse(body, status, {
      ...corsHeaders,
      "X-Request-ID": auditCtx.requestId,
    });
  }

  const { body, status } = success({
    integration_name: apiKeyInfo.integration_name,
    scopes: apiKeyInfo.scopes,
    key_prefix: apiKeyInfo.key_prefix,
  });

  return jsonResponse(body, status, {
    ...corsHeaders,
    "X-Request-ID": auditCtx.requestId,
  });
}
