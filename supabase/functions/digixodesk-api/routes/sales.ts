// GET /v1/sales — search/filter sales with bounded pagination.
// GET /v1/sales/:id — complete sale with customer, payment and subscription/renewal summary.
// Scope: sales:read

import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { success, errorResponse, jsonResponse } from "../response.ts";
import type { AuditContext } from "../audit.ts";
import type { ApiKeyInfo } from "../auth.ts";
import { saleSearchSchema, saleCreateSchema, paymentCreateSchema, fulfilmentUpdateSchema, formatValidationError, mapRpcError, MAX_PAGE_LIMIT } from "../validation.ts";
import { extractIdempotencyKey } from "../idempotency.ts";

const SALE_LIST_COLUMNS =
  "id, sale_number, customer_id, product_name_snapshot, plan_name_snapshot, final_selling_price, payment_status, fulfilment_status, sale_date";

export async function handleSaleSearch(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams.entries());

  const parsed = saleSearchSchema.safeParse(params);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid query parameters", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { q, status, fulfilment_status, page, limit } = parsed.data;
  const offset = (page - 1) * limit;
  const cappedLimit = Math.min(limit, MAX_PAGE_LIMIT);

  let query = supabase
    .from("sales")
    .select(SALE_LIST_COLUMNS, { count: "exact" })
    .is("archived_at", null)
    .order("sale_date", { ascending: false })
    .order("sale_number", { ascending: false })
    .range(offset, offset + cappedLimit - 1);

  if (q) {
    const safeQuery = q.replace(/[,.()]/g, " ");
    query = query.or(`sale_number.ilike.%${safeQuery}%,product_name_snapshot.ilike.%${safeQuery}%`);
  }
  if (status) {
    query = query.eq("payment_status", status);
  }
  if (fulfilment_status) {
    query = query.eq("fulfilment_status", fulfilment_status);
  }

  const { data: sales, error, count } = await query;

  if (error) {
    const { body, status } = errorResponse("INTERNAL_ERROR", "Failed to retrieve sales", auditCtx.requestId, 500);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const total = count || 0;
  const hasMore = offset + cappedLimit < total;

  const { body, status: httpStatus } = success(
    { sales: sales || [] },
    { pagination: { page, limit: cappedLimit, total, has_more: hasMore } }
  );
  return jsonResponse(body, httpStatus, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}

export async function handleSaleDetail(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>,
  saleId: string
): Promise<Response> {
  // Fetch the sale with joined customer
  const { data: sale, error } = await supabase
    .from("sales")
    .select(`
      id, sale_number, customer_id, product_name_snapshot, plan_name_snapshot,
      purchase_type_snapshot, duration_days_snapshot, final_selling_price, payment_fee,
      amount_received, refund_amount, replacement_cost,
      sale_date, payment_status, fulfilment_status,
      payment_method, transaction_reference, subscription_start_date, renewal_date,
      warranty_end_date, note,
      sale_source, external_reference, salesperson_name,
      customers ( id, name, phone_display, email )
    `)
    .eq("id", saleId)
    .is("archived_at", null)
    .maybeSingle();

  if (error) {
    const { body, status } = errorResponse("INTERNAL_ERROR", "Failed to retrieve sale", auditCtx.requestId, 500);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  if (!sale) {
    const { body, status } = errorResponse("NOT_FOUND", "Sale not found", auditCtx.requestId, 404);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  // Fetch payments
  const { data: payments, error: paymentsError } = await supabase
    .from("payments")
    .select("id, amount, payment_method, payment_date, status")
    .eq("sale_id", saleId)
    .order("payment_date", { ascending: true });

  if (paymentsError) {
    const { body, status } = errorResponse("INTERNAL_ERROR", "Failed to retrieve payments", auditCtx.requestId, 500);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  // Fetch subscription and renewal if recurring
  let subscription = null;
  let renewal = null;

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("id, status, next_renewal_date, start_date, end_date")
    .eq("current_sale_id", saleId)
    .maybeSingle();

  if (sub) {
    subscription = sub;

    const { data: ren } = await supabase
      .from("renewals")
      .select("id, due_date, status, snoozed_until")
      .eq("subscription_id", sub.id)
      .order("due_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ren) renewal = ren;
  }

  const { body, status } = success({
    sale: {
      ...sale,
      payments: payments || [],
      subscription,
      renewal,
    },
  });
  return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}

export async function handleSaleCreate(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const idempotencyKey = extractIdempotencyKey(req);
  if (!idempotencyKey) {
    const { body, status } = errorResponse("VALIDATION_ERROR", "Idempotency-Key header is required", auditCtx.requestId, 422);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid JSON body", auditCtx.requestId, 422);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const parsed = saleCreateSchema.safeParse(body);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid request body", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { data, error } = await supabase.rpc("api_create_sale", {
    p_payload: body as Record<string, unknown>,
    p_api_key_id: apiKeyInfo.id,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    const mapped = mapRpcError(error.message);
    const { body, status } = errorResponse(mapped.code, mapped.message, auditCtx.requestId, mapped.status);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { body: successBody, status } = success(data);
  return jsonResponse(successBody, 201, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}

export async function handlePaymentCreate(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>,
  saleId: string
): Promise<Response> {
  const idempotencyKey = extractIdempotencyKey(req);
  if (!idempotencyKey) {
    const { body, status } = errorResponse("VALIDATION_ERROR", "Idempotency-Key header is required", auditCtx.requestId, 422);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid JSON body", auditCtx.requestId, 422);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid request body", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { amount, payment_method, transaction_reference, payment_date, note } = parsed.data;

  const { data, error } = await supabase.rpc("api_add_payment", {
    p_sale_id: saleId,
    p_amount: amount,
    p_api_key_id: apiKeyInfo.id,
    p_idempotency_key: idempotencyKey,
    p_payment_method: payment_method || null,
    p_transaction_reference: transaction_reference || null,
    p_payment_date: payment_date || null,
    p_note: note || null,
  });

  if (error) {
    const mapped = mapRpcError(error.message);
    const { body, status } = errorResponse(mapped.code, mapped.message, auditCtx.requestId, mapped.status);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { body: successBody, status } = success(data);
  return jsonResponse(successBody, 201, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}

export async function handleFulfilmentUpdate(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>,
  saleId: string
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid JSON body", auditCtx.requestId, 422);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const parsed = fulfilmentUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid request body", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { fulfilment_status, note } = parsed.data;

  const { data, error } = await supabase.rpc("api_update_fulfilment", {
    p_sale_id: saleId,
    p_fulfilment_status: fulfilment_status,
    p_api_key_id: apiKeyInfo.id,
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
