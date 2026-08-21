// GET /v1/reports/summary — date-range business summary.
// Scope: reports:read
// Uses internal.core_get_reports_summary RPC (same definitions as owner_dashboard_stats).

import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { success, errorResponse, jsonResponse } from "../response.ts";
import type { AuditContext } from "../audit.ts";
import type { ApiKeyInfo } from "../auth.ts";
import { reportsQuerySchema, formatValidationError } from "../validation.ts";

export async function handleReportsSummary(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams.entries());

  const parsed = reportsQuerySchema.safeParse(params);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid query parameters", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { from, to } = parsed.data;

  const { data, error } = await supabase.rpc("api_get_reports_summary", {
    p_from: from,
    p_to: to,
  });

  if (error || !data) {
    const { body, status } = errorResponse("INTERNAL_ERROR", "Failed to generate report", auditCtx.requestId, 500);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { body, status } = success(data);
  return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}
