// GET /v1/renewals — search/filter upcoming, overdue and status-based renewals.
// Scope: renewals:read

import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { success, errorResponse, jsonResponse } from "../response.ts";
import type { AuditContext } from "../audit.ts";
import type { ApiKeyInfo } from "../auth.ts";
import { renewalSearchSchema, renewalUpdateSchema, formatValidationError, mapRpcError, MAX_PAGE_LIMIT } from "../validation.ts";

const RENEWAL_LIST_COLUMNS =
  "id, customer_id, subscription_id, due_date, status, snoozed_until, note, created_at";

const PENDING_STATUSES = ["pending", "reminded", "interested", "awaiting_payment", "snoozed", "no_response"];

export async function handleRenewalSearch(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams.entries());

  const parsed = renewalSearchSchema.safeParse(params);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid query parameters", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { status, overdue, upcoming, page, limit } = parsed.data;
  const offset = (page - 1) * limit;
  const cappedLimit = Math.min(limit, MAX_PAGE_LIMIT);

  let query = supabase
    .from("renewals")
    .select(RENEWAL_LIST_COLUMNS, { count: "exact" })
    .order("due_date", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + cappedLimit - 1);

  if (status) {
    query = query.eq("status", status);
  } else if (overdue === "true") {
    query = query.lt("due_date", new Date().toISOString().split("T")[0]).in("status", PENDING_STATUSES);
  } else if (upcoming === "true") {
    const today = new Date().toISOString().split("T")[0];
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    query = query.gt("due_date", today).lte("due_date", future).in("status", PENDING_STATUSES);
  }

  const { data: renewals, error, count } = await query;

  if (error) {
    const { body, status } = errorResponse("INTERNAL_ERROR", "Failed to retrieve renewals", auditCtx.requestId, 500);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const total = count || 0;
  const hasMore = offset + cappedLimit < total;

  const { body, status: httpStatus } = success(
    { renewals: renewals || [] },
    { pagination: { page, limit: cappedLimit, total, has_more: hasMore } }
  );
  return jsonResponse(body, httpStatus, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}

export async function handleRenewalUpdate(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>,
  renewalId: string
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid JSON body", auditCtx.requestId, 422);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const parsed = renewalUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid request body", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { status: renewalStatus, snoozed_until, note } = parsed.data;

  const { data, error } = await supabase.rpc("api_update_renewal", {
    p_renewal_id: renewalId,
    p_api_key_id: apiKeyInfo.id,
    p_status: renewalStatus || null,
    p_snoozed_until: snoozed_until || null,
    p_note: note || null,
  });

  if (error) {
    const mapped = mapRpcError(error.message);
    const { body, status } = errorResponse(mapped.code, mapped.message, auditCtx.requestId, mapped.status);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { body: successBody, status } = success(data);
  return jsonResponse(successBody, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}
