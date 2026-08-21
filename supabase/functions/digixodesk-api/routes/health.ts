// GET /v1/health — public health endpoint, no authentication required.

import { success, jsonResponse } from "../response.ts";
import type { AuditContext } from "../audit.ts";

export async function handleHealth(req: Request, auditCtx: AuditContext, corsHeaders: Record<string, string>): Promise<Response> {
  const { body, status } = success({
    status: "ok",
    timestamp: new Date().toISOString(),
  });

  return jsonResponse(body, status, {
    ...corsHeaders,
    "X-Request-ID": auditCtx.requestId,
  });
}
