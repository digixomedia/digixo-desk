// GET /v1/customers — search customers by phone, name, or email with pagination.
// GET /v1/customers/:id — customer details.
// Scope: customers:read

import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { success, errorResponse, jsonResponse } from "../response.ts";
import type { AuditContext } from "../audit.ts";
import type { ApiKeyInfo } from "../auth.ts";
import { customerSearchSchema, customerCreateSchema, customerUpdateSchema, formatValidationError, mapRpcError, MAX_PAGE_LIMIT } from "../validation.ts";

const CUSTOMER_LIST_COLUMNS = "id, name, phone_display, email, customer_type, created_at";
const CUSTOMER_DETAIL_COLUMNS =
  "id, name, phone_display, email, customer_type, acquisition_source, tags, marketing_allowed, do_not_message, created_at";

export async function handleCustomerSearch(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams.entries());

  const parsed = customerSearchSchema.safeParse(params);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid query parameters", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { q, page, limit } = parsed.data;
  const offset = (page - 1) * limit;
  const cappedLimit = Math.min(limit, MAX_PAGE_LIMIT);

  let query = supabase
    .from("customers")
    .select(CUSTOMER_LIST_COLUMNS, { count: "exact" })
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + cappedLimit - 1);

  if (q) {
    const safeQuery = q.replace(/[,.()]/g, " ");
    query = query.or(`name.ilike.%${safeQuery}%,email.ilike.%${safeQuery}%,phone_display.ilike.%${safeQuery}%`);
  }

  const { data: customers, error, count } = await query;

  if (error) {
    const { body, status } = errorResponse("INTERNAL_ERROR", "Failed to retrieve customers", auditCtx.requestId, 500);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const total = count || 0;
  const hasMore = offset + cappedLimit < total;

  const { body, status } = success(
    { customers: customers || [] },
    { pagination: { page, limit: cappedLimit, total, has_more: hasMore } }
  );
  return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}

export async function handleCustomerDetail(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>,
  customerId: string
): Promise<Response> {
  const { data: customer, error } = await supabase
    .from("customers")
    .select(CUSTOMER_DETAIL_COLUMNS)
    .eq("id", customerId)
    .is("archived_at", null)
    .maybeSingle();

  if (error) {
    const { body, status } = errorResponse("INTERNAL_ERROR", "Failed to retrieve customer", auditCtx.requestId, 500);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  if (!customer) {
    const { body, status } = errorResponse("NOT_FOUND", "Customer not found", auditCtx.requestId, 404);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { body, status } = success({ customer });
  return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}

export async function handleCustomerCreate(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid JSON body", auditCtx.requestId, 422);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const parsed = customerCreateSchema.safeParse(body);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid request body", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { name, phone, email, customer_type, acquisition_source } = parsed.data;

  const { data, error } = await supabase.rpc("api_create_customer", {
    p_name: name,
    p_phone: phone,
    p_email: email || null,
    p_customer_type: customer_type || "retail",
    p_acquisition_source: acquisition_source || null,
    p_api_key_id: apiKeyInfo.id,
  });

  if (error) {
    const mapped = mapRpcError(error.message);
    const { body, status } = errorResponse(mapped.code, mapped.message, auditCtx.requestId, mapped.status);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { body: successBody, status } = success(data);
  return jsonResponse(successBody, 201, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}

export async function handleCustomerUpdate(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>,
  customerId: string
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid JSON body", auditCtx.requestId, 422);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const parsed = customerUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid request body", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { data, error } = await supabase.rpc("api_update_customer", {
    p_customer_id: customerId,
    p_fields: body as Record<string, unknown>,
    p_api_key_id: apiKeyInfo.id,
  });

  if (error) {
    const mapped = mapRpcError(error.message);
    const { body, status } = errorResponse(mapped.code, mapped.message, auditCtx.requestId, mapped.status);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { body: successBody, status } = success(data);
  return jsonResponse(successBody, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}
