// DigiXO Desk API — scoped API-key access for integrations
// Single Edge Function handling all /v1/* routes.
// JWT verification is disabled; authentication is via API keys only.

import { createClient } from "npm:@supabase/supabase-js@2.112.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const RATE_LIMIT_PER_KEY = 120; // requests per minute

function jsonResponse(body: unknown, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

function errorResponse(code: string, message: string, requestId: string, status: number): Response {
  return jsonResponse({ success: false, error: { code, message, request_id: requestId } }, status);
}

function successResponse(data: unknown, status = 200, extra?: Record<string, string>): Response {
  return jsonResponse({ success: true, data }, status, extra);
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

function getClientIP(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  return real || null;
}

function createServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Missing server configuration");
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// =========================================================
// Auth
// =========================================================

interface ApiKeyInfo {
  key_id: string;
  key_name: string;
  permissions: string[];
}

function hasPermission(apiKey: ApiKeyInfo | null, permission: string): boolean {
  if (!apiKey) return false;
  if (apiKey.permissions.includes("*")) return true;
  return apiKey.permissions.includes(permission);
}

async function authenticate(req: Request, supabase: ReturnType<typeof createClient>): Promise<ApiKeyInfo | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  // Hash the token with SHA-256
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const keyHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const { data, error } = await supabase.rpc("validate_api_key", { p_key_hash: keyHash });
  if (error || !data || data.valid !== true) return null;

  // Touch last_used_at (fire and forget)
  supabase.rpc("touch_api_key_last_used", { p_key_id: data.key_id }).then(() => {});

  if (!Array.isArray(data.permissions) || data.permissions.length === 0 || data.permissions.some((value: unknown) => typeof value !== "string")) {
    return null;
  }
  return { key_id: data.key_id, key_name: data.key_name, permissions: data.permissions };
}

// =========================================================
// Rate limiting (simple per-key counter in api_request_logs)
// =========================================================

async function checkRateLimit(supabase: ReturnType<typeof createClient>, keyId: string): Promise<{ allowed: boolean; remaining: number }> {
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await supabase
    .from("api_request_logs")
    .select("*", { count: "exact", head: true })
    .eq("api_key_id", keyId)
    .gte("created_at", oneMinuteAgo);

  if (error) return { allowed: true, remaining: RATE_LIMIT_PER_KEY };
  const current = count ?? 0;
  return { allowed: current < RATE_LIMIT_PER_KEY, remaining: Math.max(0, RATE_LIMIT_PER_KEY - current) };
}

// =========================================================
// Request logging
// =========================================================

async function logRequest(
  supabase: ReturnType<typeof createClient>,
  requestId: string,
  apiKey: ApiKeyInfo | null,
  endpoint: string,
  method: string,
  statusCode: number,
  ip: string | null,
  durationMs: number,
  errorMessage: string | null
): Promise<void> {
  try {
    await supabase.rpc("log_api_request", {
      p_request_id: requestId,
      p_api_key_id: apiKey?.key_id ?? null,
      p_key_name: apiKey?.key_name ?? null,
      p_endpoint: endpoint,
      p_method: method,
      p_status_code: statusCode,
      p_ip_address: ip,
      p_duration_ms: durationMs,
      p_error_message: errorMessage,
    });
  } catch {
    // Logging failure should not block the request
  }
}

// =========================================================
// Route handlers
// =========================================================

// --- Health ---
function handleHealth(requestId: string): Response {
  return successResponse({ status: "ok" });
}

// --- Whoami ---
function handleWhoami(apiKey: ApiKeyInfo, requestId: string): Response {
  return successResponse({ key_id: apiKey.key_id, key_name: apiKey.key_name, permissions: apiKey.permissions, access: apiKey.permissions.includes("*") ? "full_admin" : "limited" });
}

// --- Dashboard ---
async function handleDashboard(supabase: ReturnType<typeof createClient>, requestId: string): Promise<Response> {
  const { data, error } = await supabase.rpc("dashboard_financial_stats");
  if (error) return errorResponse("INTERNAL_ERROR", "Failed to fetch dashboard stats", requestId, 500);
  if (!Array.isArray(data) || data.length !== 1) return errorResponse("INTERNAL_ERROR", "Dashboard stats returned an invalid response", requestId, 500);
  return successResponse(data[0]);
}

// --- Sales ---
async function handleSalesList(supabase: ReturnType<typeof createClient>, req: Request, apiKey: ApiKeyInfo, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const search = url.searchParams.get("search");
  const paymentStatus = url.searchParams.get("payment_status");
  const fulfilmentStatus = url.searchParams.get("fulfilment_status");
  const fromDate = url.searchParams.get("from");
  const toDate = url.searchParams.get("to");
  const offset = (page - 1) * limit;

  const includeCustomers = hasPermission(apiKey, "customers:read");
  let matchingIds: string[] | null = null;
  if (search?.trim()) {
    const digits = search.replace(/\D/g, "");
    const { data, error } = await supabase.rpc("search_sale_ids", {
      p_search: search.trim(),
      p_phone_digits: digits.length >= 3 ? digits : null,
      p_include_customer: includeCustomers,
    });
    if (error) return errorResponse("INTERNAL_ERROR", "Failed to search sales", requestId, 500);
    matchingIds = (data ?? []).map((row: { id: string }) => row.id);
    if (matchingIds.length === 0) return successResponse({ sales: [], pagination: { page, limit, total: 0, has_more: false } });
  }

  const selection = `
      id, sale_number, customer_id, product_name_snapshot, plan_name_snapshot,
      purchase_type_snapshot, final_selling_price, amount_received, payment_fee,
      sale_date, payment_status, fulfilment_status,
      payment_method, transaction_reference, note, created_at, updated_at
      ${includeCustomers ? ", customers ( id, name, phone_display, email )" : ""}
    `;
  let query = supabase
    .from("sales")
    .select(selection, { count: "exact" })
    .eq("is_demo", false)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (matchingIds) query = query.in("id", matchingIds);
  if (paymentStatus) query = query.eq("payment_status", paymentStatus);
  if (fulfilmentStatus) query = query.eq("fulfilment_status", fulfilmentStatus);
  if (fromDate) query = query.gte("sale_date", fromDate);
  if (toDate) {
    const next = new Date(`${toDate}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    query = query.lt("sale_date", next.toISOString().slice(0, 10));
  }

  const { data, error, count } = await query;
  if (error) return errorResponse("INTERNAL_ERROR", "Failed to fetch sales", requestId, 500);

  return successResponse({
    sales: data ?? [],
    pagination: { page, limit, total: count ?? 0, has_more: (count ?? 0) > offset + limit },
  });
}

async function handleSaleDetail(supabase: ReturnType<typeof createClient>, saleId: string, apiKey: ApiKeyInfo, requestId: string): Promise<Response> {
  const { data: sale, error } = await supabase
    .from("sales")
    .select("*")
    .eq("id", saleId)
    .eq("is_demo", false)
    .is("archived_at", null)
    .maybeSingle();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to fetch sale", requestId, 500);
  if (!sale) return errorResponse("NOT_FOUND", "Sale not found", requestId, 404);

  let customer = null;
  let payments: unknown[] = [];
  let subscription = null;
  let renewal = null;
  if (hasPermission(apiKey, "customers:read")) {
    const result = await supabase.from("customers").select("id,name,phone_display,email,customer_type").eq("id", sale.customer_id).maybeSingle();
    customer = result.data;
  }
  if (hasPermission(apiKey, "payments:read")) {
    const result = await supabase.from("payments").select("id,amount,payment_method,transaction_reference,payment_date,status,note,created_at").eq("sale_id", saleId).eq("is_demo", false);
    payments = result.data ?? [];
  }
  if (sale.purchase_type_snapshot === "recurring" && hasPermission(apiKey, "subscriptions:read")) {
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("current_sale_id", saleId)
      .maybeSingle();
    subscription = sub;
    if (sub && hasPermission(apiKey, "renewals:read")) {
      const { data: ren } = await supabase
        .from("renewals")
        .select("*")
        .eq("subscription_id", sub.id)
        .maybeSingle();
      renewal = ren;
    }
  }

  return successResponse({ sale: { ...sale, customer, payments, subscription, renewal } });
}

async function handleSaleCreate(supabase: ReturnType<typeof createClient>, req: Request, apiKey: ApiKeyInfo, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  // Get the owner profile to use as actor
  const { data: owner } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "owner")
    .eq("is_active", true)
    .maybeSingle();

  if (!owner) return errorResponse("INTERNAL_ERROR", "No active owner found", requestId, 500);

  const { data, error } = await supabase.rpc("api_create_sale", {
    p_payload: body,
    p_actor_id: owner.id,
  });
  if (error) {
    const msg = error.message || "Failed to create sale";
    if (msg.includes("VALIDATION_ERROR") || msg.includes("NOT_FOUND") || msg.includes("BUSINESS_RULE")) {
      const cleanMsg = msg.replace(/^(VALIDATION_ERROR|NOT_FOUND|BUSINESS_RULE_ERROR):\s*/, "");
      return errorResponse("VALIDATION_ERROR", cleanMsg, requestId, 422);
    }
    return errorResponse("INTERNAL_ERROR", msg, requestId, 500);
  }
  return successResponse(data, 201);
}

async function handleFulfilmentUpdate(supabase: ReturnType<typeof createClient>, saleId: string, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  const allowedStatuses = ["payment_confirmation", "activation_pending", "processing", "activated", "replacement_required", "completed"];
  if (!body.fulfilment_status || !allowedStatuses.includes(body.fulfilment_status)) {
    return errorResponse("VALIDATION_ERROR", "Invalid fulfilment_status", requestId, 422);
  }

  const { data, error } = await supabase
    .from("sales")
    .update({
      fulfilment_status: body.fulfilment_status,
      note: body.note ?? undefined,
      updated_at: new Date().toISOString(),
    })
    .eq("id", saleId)
    .is("archived_at", null)
    .select("id, sale_number, fulfilment_status")
    .maybeSingle();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to update fulfilment", requestId, 500);
  if (!data) return errorResponse("NOT_FOUND", "Sale not found", requestId, 404);
  return successResponse(data);
}

// --- Payments ---
async function handlePaymentCreate(supabase: ReturnType<typeof createClient>, saleId: string, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  if (!body.amount || body.amount <= 0) {
    return errorResponse("VALIDATION_ERROR", "Amount must be greater than zero", requestId, 422);
  }

  // Get the owner profile to use as actor
  const { data: owner } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "owner")
    .eq("is_active", true)
    .maybeSingle();

  if (!owner) return errorResponse("INTERNAL_ERROR", "No active owner found", requestId, 500);

  const { data, error } = await supabase.rpc("api_add_payment", {
    p_sale_id: saleId,
    p_amount: body.amount,
    p_actor_id: owner.id,
    p_payment_method: body.payment_method ?? null,
    p_transaction_reference: body.transaction_reference ?? null,
    p_payment_date: body.payment_date ?? null,
    p_note: body.note ?? null,
  });

  if (error) {
    const msg = error.message || "Failed to add payment";
    if (msg.includes("NOT_FOUND")) return errorResponse("NOT_FOUND", msg, requestId, 404);
    if (msg.includes("BUSINESS_RULE")) return errorResponse("BUSINESS_RULE_ERROR", msg.replace(/^BUSINESS_RULE_ERROR:\s*/, ""), requestId, 422);
    if (msg.includes("VALIDATION")) return errorResponse("VALIDATION_ERROR", msg.replace(/^VALIDATION_ERROR:\s*/, ""), requestId, 422);
    return errorResponse("INTERNAL_ERROR", msg, requestId, 500);
  }
  return successResponse(data, 201);
}

// --- Customers ---
async function handleCustomersList(supabase: ReturnType<typeof createClient>, req: Request, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const search = url.searchParams.get("search");
  const offset = (page - 1) * limit;

  let matchingIds: string[] | null = null;
  if (search?.trim()) {
    const digits = search.replace(/\D/g, "");
    const { data, error } = await supabase.rpc("search_customer_ids", { p_search: search.trim(), p_phone_digits: digits.length >= 3 ? digits : null });
    if (error) return errorResponse("INTERNAL_ERROR", "Failed to search customers", requestId, 500);
    matchingIds = (data ?? []).map((row: { id: string }) => row.id);
    if (matchingIds.length === 0) return successResponse({ customers: [], pagination: { page, limit, total: 0, has_more: false } });
  }

  let query = supabase
    .from("customers")
    .select("id, name, phone_display, email, customer_type, created_at, updated_at, archived_at", { count: "exact" })
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (matchingIds) query = query.in("id", matchingIds);

  const { data, error, count } = await query;
  if (error) return errorResponse("INTERNAL_ERROR", "Failed to fetch customers", requestId, 500);

  return successResponse({
    customers: data ?? [],
    pagination: { page, limit, total: count ?? 0, has_more: (count ?? 0) > offset + limit },
  });
}

async function handleCustomerDetail(supabase: ReturnType<typeof createClient>, customerId: string, apiKey: ApiKeyInfo, requestId: string): Promise<Response> {
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("id", customerId)
    .is("archived_at", null)
    .maybeSingle();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to fetch customer", requestId, 500);
  if (!data) return errorResponse("NOT_FOUND", "Customer not found", requestId, 404);

  let sales: unknown[] = [];
  if (hasPermission(apiKey, "sales:read")) {
    const result = await supabase.from("sales").select("id,sale_number,product_name_snapshot,final_selling_price,payment_status,fulfilment_status,sale_date").eq("customer_id", customerId).eq("is_demo", false).is("archived_at", null).order("sale_date", { ascending: false }).limit(20);
    sales = result.data ?? [];
  }

  return successResponse({ customer: data, recent_sales: sales ?? [] });
}

async function handleCustomerCreate(supabase: ReturnType<typeof createClient>, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  if (!body.name || !body.phone) {
    return errorResponse("VALIDATION_ERROR", "Name and phone are required", requestId, 422);
  }

  // Normalize phone using the RPC
  const { data: normalized, error: normError } = await supabase.rpc("normalize_phone", { raw: body.phone });
  if (normError || !normalized) {
    return errorResponse("VALIDATION_ERROR", "Invalid phone number", requestId, 422);
  }

  // Check if customer already exists
  const { data: existing } = await supabase
    .from("customers")
    .select("id")
    .eq("phone_normalized", normalized)
    .maybeSingle();

  if (existing) {
    return successResponse({ customer_id: existing.id, created: false });
  }

  // Get the owner profile to set as created_by
  const { data: owner } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "owner")
    .eq("is_active", true)
    .maybeSingle();

  const { data, error } = await supabase
    .from("customers")
    .insert({
      name: body.name,
      phone_normalized: normalized,
      phone_display: body.phone,
      phone_country_code: "",
      email: body.email ?? null,
      customer_type: body.customer_type ?? "retail",
      acquisition_source: body.acquisition_source ?? null,
      created_by: owner?.id ?? null,
    })
    .select("id, name, phone_display, email, customer_type, created_at")
    .single();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to create customer", requestId, 500);
  return successResponse({ customer: data, created: true }, 201);
}

async function handleCustomerUpdate(supabase: ReturnType<typeof createClient>, customerId: string, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  const allowedFields: Record<string, string> = {
    name: "name", email: "email", customer_type: "customer_type",
    internal_note: "internal_note", marketing_allowed: "marketing_allowed",
    do_not_message: "do_not_message",
  };

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [key, col] of Object.entries(allowedFields)) {
    if (body[key] !== undefined) update[col] = body[key];
  }
  if (body.tags !== undefined) update.tags = body.tags;

  if (Object.keys(update).length <= 1) {
    return errorResponse("VALIDATION_ERROR", "No updatable fields provided", requestId, 422);
  }

  const { data, error } = await supabase
    .from("customers")
    .update(update)
    .eq("id", customerId)
    .is("archived_at", null)
    .select("id, name, phone_display, email, customer_type, tags, internal_note, marketing_allowed, do_not_message, updated_at")
    .maybeSingle();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to update customer", requestId, 500);
  if (!data) return errorResponse("NOT_FOUND", "Customer not found", requestId, 404);
  return successResponse(data);
}

// --- Products ---
async function handleProductsList(supabase: ReturnType<typeof createClient>, req: Request, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const includePlans = url.searchParams.get("include_plans") !== "false";

  let select = "id, name, category_id, description, supplier_name, is_active, created_at, updated_at";
  if (includePlans) {
    select += ", product_plans ( id, plan_name, purchase_type, duration_days, warranty_days, default_cost_price, default_selling_price, optional_list_price, is_active )";
  }

  const { data, error } = await supabase
    .from("products")
    .select(select)
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to fetch products", requestId, 500);
  return successResponse({ products: data ?? [] });
}

async function handleProductCreate(supabase: ReturnType<typeof createClient>, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  if (!body.name) return errorResponse("VALIDATION_ERROR", "Product name is required", requestId, 422);

  const { data: owner } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "owner")
    .eq("is_active", true)
    .maybeSingle();

  const { data, error } = await supabase
    .from("products")
    .insert({
      name: body.name,
      category_id: body.category_id ?? null,
      description: body.description ?? null,
      supplier_name: body.supplier_name ?? null,
      is_active: body.is_active ?? true,
      created_by: owner?.id ?? null,
    })
    .select("id, name, category_id, description, supplier_name, is_active, created_at")
    .single();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to create product", requestId, 500);
  return successResponse(data, 201);
}

async function handleProductUpdate(supabase: ReturnType<typeof createClient>, productId: string, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  const allowedFields: Record<string, string> = {
    name: "name", category_id: "category_id", description: "description",
    supplier_name: "supplier_name", is_active: "is_active",
  };

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [key, col] of Object.entries(allowedFields)) {
    if (body[key] !== undefined) update[col] = body[key];
  }

  const { data, error } = await supabase
    .from("products")
    .update(update)
    .eq("id", productId)
    .is("archived_at", null)
    .select("id, name, category_id, description, supplier_name, is_active, updated_at")
    .maybeSingle();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to update product", requestId, 500);
  if (!data) return errorResponse("NOT_FOUND", "Product not found", requestId, 404);
  return successResponse(data);
}

// --- Product Plans ---
async function handleProductPlanCreate(supabase: ReturnType<typeof createClient>, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  if (!body.product_id || !body.plan_name) {
    return errorResponse("VALIDATION_ERROR", "product_id and plan_name are required", requestId, 422);
  }

  const { data: owner } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "owner")
    .eq("is_active", true)
    .maybeSingle();

  const { data, error } = await supabase
    .from("product_plans")
    .insert({
      product_id: body.product_id,
      plan_name: body.plan_name,
      purchase_type: body.purchase_type ?? "one_time",
      duration_days: body.duration_days ?? null,
      warranty_days: body.warranty_days ?? null,
      default_cost_price: body.default_cost_price ?? 0,
      default_selling_price: body.default_selling_price ?? 0,
      optional_list_price: body.optional_list_price ?? null,
      optional_stock_count: body.optional_stock_count ?? null,
      low_stock_threshold: body.low_stock_threshold ?? 0,
      is_active: body.is_active ?? true,
      created_by: owner?.id ?? null,
    })
    .select("id, product_id, plan_name, purchase_type, duration_days, warranty_days, default_cost_price, default_selling_price, is_active, created_at")
    .single();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to create product plan", requestId, 500);
  return successResponse(data, 201);
}

async function handleProductPlanUpdate(supabase: ReturnType<typeof createClient>, planId: string, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  const allowedFields: Record<string, string> = {
    plan_name: "plan_name", purchase_type: "purchase_type",
    duration_days: "duration_days", warranty_days: "warranty_days",
    default_cost_price: "default_cost_price", default_selling_price: "default_selling_price",
    optional_list_price: "optional_list_price", optional_stock_count: "optional_stock_count",
    low_stock_threshold: "low_stock_threshold", is_active: "is_active",
  };

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [key, col] of Object.entries(allowedFields)) {
    if (body[key] !== undefined) update[col] = body[key];
  }

  const { data, error } = await supabase
    .from("product_plans")
    .update(update)
    .eq("id", planId)
    .is("archived_at", null)
    .select("id, plan_name, purchase_type, default_cost_price, default_selling_price, is_active, updated_at")
    .maybeSingle();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to update product plan", requestId, 500);
  if (!data) return errorResponse("NOT_FOUND", "Product plan not found", requestId, 404);
  return successResponse(data);
}

// --- Categories ---
async function handleCategoriesList(supabase: ReturnType<typeof createClient>, requestId: string): Promise<Response> {
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, colour, created_at")
    .is("archived_at", null)
    .order("name", { ascending: true });

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to fetch categories", requestId, 500);
  return successResponse({ categories: data ?? [] });
}

async function handleCategoryCreate(supabase: ReturnType<typeof createClient>, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  if (!body.name) return errorResponse("VALIDATION_ERROR", "Category name is required", requestId, 422);

  const { data: owner } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "owner")
    .eq("is_active", true)
    .maybeSingle();

  const { data, error } = await supabase
    .from("categories")
    .insert({
      name: body.name,
      colour: body.colour ?? "#6366f1",
      created_by: owner?.id ?? null,
    })
    .select("id, name, colour, created_at")
    .single();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to create category", requestId, 500);
  return successResponse(data, 201);
}

async function handleCategoryUpdate(supabase: ReturnType<typeof createClient>, categoryId: string, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.colour !== undefined) update.colour = body.colour;

  if (Object.keys(update).length === 0) {
    return errorResponse("VALIDATION_ERROR", "No updatable fields provided", requestId, 422);
  }

  const { data, error } = await supabase
    .from("categories")
    .update(update)
    .eq("id", categoryId)
    .is("archived_at", null)
    .select("id, name, colour")
    .maybeSingle();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to update category", requestId, 500);
  if (!data) return errorResponse("NOT_FOUND", "Category not found", requestId, 404);
  return successResponse(data);
}

// --- Renewals ---
async function handleRenewalsList(supabase: ReturnType<typeof createClient>, req: Request, apiKey: ApiKeyInfo, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const status = url.searchParams.get("status");
  const offset = (page - 1) * limit;

  const selection = `id,subscription_id,customer_id,due_date,status,snoozed_until,note,created_at,updated_at
    ${hasPermission(apiKey, "customers:read") ? ",customers(id,name,phone_display,email)" : ""}
    ${hasPermission(apiKey, "subscriptions:read") ? ",subscriptions(id,product_plan_id,start_date,end_date,status,next_renewal_date)" : ""}`;
  let query = supabase
    .from("renewals")
    .select(selection, { count: "exact" })
    .eq("is_demo", false)
    .order("due_date", { ascending: true })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) return errorResponse("INTERNAL_ERROR", "Failed to fetch renewals", requestId, 500);

  return successResponse({
    renewals: data ?? [],
    pagination: { page, limit, total: count ?? 0, has_more: (count ?? 0) > offset + limit },
  });
}

async function handleRenewalUpdate(supabase: ReturnType<typeof createClient>, renewalId: string, req: Request, requestId: string): Promise<Response> {
  let body;
  try { body = await req.json(); } catch { return errorResponse("VALIDATION_ERROR", "Invalid JSON body", requestId, 422); }

  const allowedStatuses = ["pending", "reminded", "interested", "awaiting_payment", "snoozed", "no_response", "renewed", "not_renewing"];
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.status !== undefined) {
    if (!allowedStatuses.includes(body.status)) {
      return errorResponse("VALIDATION_ERROR", "Invalid renewal status", requestId, 422);
    }
    if (body.status === "renewed") return errorResponse("VALIDATION_ERROR", "Complete a renewal through the renewal-sale workflow", requestId, 422);
    update.status = body.status;
  }
  if (body.snoozed_until !== undefined) update.snoozed_until = body.snoozed_until;
  if (body.note !== undefined) update.note = body.note;

  if (Object.keys(update).length <= 1) {
    return errorResponse("VALIDATION_ERROR", "No updatable fields provided", requestId, 422);
  }

  const { data, error } = await supabase
    .from("renewals")
    .update(update)
    .eq("id", renewalId)
    .select("id, status, snoozed_until, note, updated_at")
    .maybeSingle();

  if (error) return errorResponse("INTERNAL_ERROR", "Failed to update renewal", requestId, 500);
  if (!data) return errorResponse("NOT_FOUND", "Renewal not found", requestId, 404);
  return successResponse(data);
}

// --- Subscriptions ---
async function handleSubscriptionsList(supabase: ReturnType<typeof createClient>, req: Request, apiKey: ApiKeyInfo, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const status = url.searchParams.get("status");
  const offset = (page - 1) * limit;

  const selection = `id,customer_id,original_sale_id,current_sale_id,product_plan_id,start_date,end_date,status,next_renewal_date,created_at,updated_at
    ${hasPermission(apiKey, "customers:read") ? ",customers(id,name,phone_display,email)" : ""}`;
  let query = supabase
    .from("subscriptions")
    .select(selection, { count: "exact" })
    .eq("is_demo", false)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) return errorResponse("INTERNAL_ERROR", "Failed to fetch subscriptions", requestId, 500);

  return successResponse({
    subscriptions: data ?? [],
    pagination: { page, limit, total: count ?? 0, has_more: (count ?? 0) > offset + limit },
  });
}

// --- Reports ---
async function handleReportsSummary(supabase: ReturnType<typeof createClient>, req: Request, requestId: string): Promise<Response> {
  const url = new URL(req.url);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const fromDate = url.searchParams.get("from") || `${today.slice(0, 7)}-01`;
  const toDate = url.searchParams.get("to") || today;
  const validDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!validDate.test(fromDate) || !validDate.test(toDate) || fromDate > toDate) return errorResponse("VALIDATION_ERROR", "Use valid from/to dates with from not after to", requestId, 422);
  const date = new Date(`${toDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1);
  const toExclusive = date.toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc("financial_report_summary", { p_from: fromDate, p_to_exclusive: toExclusive });
  if (error) return errorResponse("INTERNAL_ERROR", "Failed to fetch reports", requestId, 500);
  return successResponse(data);
}

// =========================================================
// Router
// =========================================================

interface RouteMatch {
  handler: (supabase: ReturnType<typeof createClient>, req: Request, apiKey: ApiKeyInfo, requestId: string, pathParam?: string) => Promise<Response>;
  pathParam?: string;
  requiresAuth: boolean;
  requiredPermission: string | null;
}

function matchRoute(path: string, method: string): RouteMatch | null {
  // Public routes
  if (path === "/v1/health" && method === "GET") {
    return { requiresAuth: false, requiredPermission: null, handler: async () => Promise.resolve(handleHealth(generateRequestId())) };
  }

  // Authenticated routes
  if (path === "/v1/whoami" && method === "GET") {
    return { requiresAuth: true, requiredPermission: null, handler: async (_s, _r, apiKey, requestId) => Promise.resolve(handleWhoami(apiKey, requestId)) };
  }
  if (path === "/v1/dashboard" && method === "GET") {
    return { requiresAuth: true, requiredPermission: "dashboard:read", handler: async (s, _r, _a, requestId) => handleDashboard(s, requestId) };
  }

  // Sales
  if (path === "/v1/sales" && method === "GET") {
    return { requiresAuth: true, requiredPermission: "sales:read", handler: async (s, r, a, requestId) => handleSalesList(s, r, a, requestId) };
  }
  if (path === "/v1/sales" && method === "POST") {
    return { requiresAuth: true, requiredPermission: "sales:write", handler: async (s, r, a, requestId) => handleSaleCreate(s, r, a, requestId) };
  }
  const saleMatch = path.match(/^\/v1\/sales\/([^/]+)$/);
  if (saleMatch && method === "GET") {
    return { requiresAuth: true, requiredPermission: "sales:read", pathParam: saleMatch[1], handler: async (s, _r, a, requestId, id) => handleSaleDetail(s, id!, a, requestId) };
  }
  if (saleMatch && method === "PATCH") {
    return { requiresAuth: true, requiredPermission: "sales:write", pathParam: saleMatch[1], handler: async (s, r, _a, requestId, id) => handleFulfilmentUpdate(s, id!, r, requestId) };
  }

  // Payments
  const paymentMatch = path.match(/^\/v1\/sales\/([^/]+)\/payments$/);
  if (paymentMatch && method === "POST") {
    return { requiresAuth: true, requiredPermission: "payments:write", pathParam: paymentMatch[1], handler: async (s, r, _a, requestId, id) => handlePaymentCreate(s, id!, r, requestId) };
  }

  // Customers
  if (path === "/v1/customers" && method === "GET") {
    return { requiresAuth: true, requiredPermission: "customers:read", handler: async (s, r, _a, requestId) => handleCustomersList(s, r, requestId) };
  }
  if (path === "/v1/customers" && method === "POST") {
    return { requiresAuth: true, requiredPermission: "customers:write", handler: async (s, r, _a, requestId) => handleCustomerCreate(s, r, requestId) };
  }
  const customerMatch = path.match(/^\/v1\/customers\/([^/]+)$/);
  if (customerMatch && method === "GET") {
    return { requiresAuth: true, requiredPermission: "customers:read", pathParam: customerMatch[1], handler: async (s, _r, a, requestId, id) => handleCustomerDetail(s, id!, a, requestId) };
  }
  if (customerMatch && method === "PATCH") {
    return { requiresAuth: true, requiredPermission: "customers:write", pathParam: customerMatch[1], handler: async (s, r, _a, requestId, id) => handleCustomerUpdate(s, id!, r, requestId) };
  }

  // Products
  if (path === "/v1/products" && method === "GET") {
    return { requiresAuth: true, requiredPermission: "products:read", handler: async (s, r, _a, requestId) => handleProductsList(s, r, requestId) };
  }
  if (path === "/v1/products" && method === "POST") {
    return { requiresAuth: true, requiredPermission: "products:write", handler: async (s, r, _a, requestId) => handleProductCreate(s, r, requestId) };
  }
  const productMatch = path.match(/^\/v1\/products\/([^/]+)$/);
  if (productMatch && method === "PATCH") {
    return { requiresAuth: true, requiredPermission: "products:write", pathParam: productMatch[1], handler: async (s, r, _a, requestId, id) => handleProductUpdate(s, id!, r, requestId) };
  }

  // Product Plans
  if (path === "/v1/product-plans" && method === "POST") {
    return { requiresAuth: true, requiredPermission: "products:write", handler: async (s, r, _a, requestId) => handleProductPlanCreate(s, r, requestId) };
  }
  const planMatch = path.match(/^\/v1\/product-plans\/([^/]+)$/);
  if (planMatch && method === "PATCH") {
    return { requiresAuth: true, requiredPermission: "products:write", pathParam: planMatch[1], handler: async (s, r, _a, requestId, id) => handleProductPlanUpdate(s, id!, r, requestId) };
  }

  // Categories
  if (path === "/v1/categories" && method === "GET") {
    return { requiresAuth: true, requiredPermission: "categories:read", handler: async (s, _r, _a, requestId) => handleCategoriesList(s, requestId) };
  }
  if (path === "/v1/categories" && method === "POST") {
    return { requiresAuth: true, requiredPermission: "categories:write", handler: async (s, r, _a, requestId) => handleCategoryCreate(s, r, requestId) };
  }
  const categoryMatch = path.match(/^\/v1\/categories\/([^/]+)$/);
  if (categoryMatch && method === "PATCH") {
    return { requiresAuth: true, requiredPermission: "categories:write", pathParam: categoryMatch[1], handler: async (s, r, _a, requestId, id) => handleCategoryUpdate(s, id!, r, requestId) };
  }

  // Renewals
  if (path === "/v1/renewals" && method === "GET") {
    return { requiresAuth: true, requiredPermission: "renewals:read", handler: async (s, r, a, requestId) => handleRenewalsList(s, r, a, requestId) };
  }
  const renewalMatch = path.match(/^\/v1\/renewals\/([^/]+)$/);
  if (renewalMatch && method === "PATCH") {
    return { requiresAuth: true, requiredPermission: "renewals:write", pathParam: renewalMatch[1], handler: async (s, r, _a, requestId, id) => handleRenewalUpdate(s, id!, r, requestId) };
  }

  // Subscriptions
  if (path === "/v1/subscriptions" && method === "GET") {
    return { requiresAuth: true, requiredPermission: "subscriptions:read", handler: async (s, r, a, requestId) => handleSubscriptionsList(s, r, a, requestId) };
  }

  // Reports
  if (path === "/v1/reports/summary" && method === "GET") {
    return { requiresAuth: true, requiredPermission: "reports:read", handler: async (s, r, _a, requestId) => handleReportsSummary(s, r, requestId) };
  }

  return null;
}

// =========================================================
// Main handler
// =========================================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname
    .replace(/^\/functions\/v1\/digixodesk-api/, "")
    .replace(/^\/digixodesk-api/, "");

  const requestId = generateRequestId();
  const ip = getClientIP(req);
  const startTime = Date.now();
  const supabase = createServiceClient();

  const routeMatch = matchRoute(path, req.method);
  if (!routeMatch) {
    const resp = errorResponse("NOT_FOUND", "Endpoint not found", requestId, 404);
    await logRequest(supabase, requestId, null, path, req.method, 404, ip, Date.now() - startTime, "Endpoint not found");
    return resp;
  }

  try {
    let apiKey: ApiKeyInfo | null = null;

    if (routeMatch.requiresAuth) {
      apiKey = await authenticate(req, supabase);
      if (!apiKey) {
        const resp = errorResponse("UNAUTHORIZED", "Invalid or missing API key", requestId, 401);
        await logRequest(supabase, requestId, null, path, req.method, 401, ip, Date.now() - startTime, "Authentication failed");
        return resp;
      }

      // Permission check
      if (routeMatch.requiredPermission && !hasPermission(apiKey, routeMatch.requiredPermission)) {
        const resp = errorResponse("FORBIDDEN", `This API key lacks the '${routeMatch.requiredPermission}' permission`, requestId, 403);
        await logRequest(supabase, requestId, apiKey, path, req.method, 403, ip, Date.now() - startTime, "Permission denied");
        return resp;
      }

      // Rate limit check
      const rateCheck = await checkRateLimit(supabase, apiKey.key_id);
      if (!rateCheck.allowed) {
        const resp = errorResponse("RATE_LIMITED", "Rate limit exceeded", requestId, 429);
        await logRequest(supabase, requestId, apiKey, path, req.method, 429, ip, Date.now() - startTime, "Rate limited");
        return resp;
      }
    }

    const response = await routeMatch.handler(supabase, req, apiKey!, requestId, routeMatch.pathParam);

    await logRequest(supabase, requestId, apiKey, path, req.method, response.status, ip, Date.now() - startTime, null);

    return response;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Internal error";
    const resp = errorResponse("INTERNAL_ERROR", "Internal error", requestId, 500);
    await logRequest(supabase, requestId, null, path, req.method, 500, ip, Date.now() - startTime, errMsg);
    return resp;
  }
});
