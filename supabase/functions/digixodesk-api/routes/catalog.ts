// GET /v1/catalog/products — search active products and plans.
// Scope: catalog:read

import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { success, errorResponse, jsonResponse } from "../response.ts";
import type { AuditContext } from "../audit.ts";
import type { ApiKeyInfo } from "../auth.ts";
import { catalogQuerySchema, formatValidationError } from "../validation.ts";

export async function handleCatalogProducts(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  auditCtx: AuditContext,
  apiKeyInfo: ApiKeyInfo,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams.entries());

  const parsed = catalogQuerySchema.safeParse(params);
  if (!parsed.success) {
    const errors = formatValidationError(parsed.error);
    const { body, status } = errorResponse("VALIDATION_ERROR", "Invalid query parameters", auditCtx.requestId, 422);
    body.error.details = errors;
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { q, active } = parsed.data;
  const showActiveOnly = active !== "false";

  let productQuery = supabase
    .from("products")
    .select(`
      id,
      name,
      category_id,
      is_active,
      product_plans (
        id,
        plan_name,
        purchase_type,
        duration_days,
        warranty_days,
        optional_list_price,
        is_active
      )
    `)
    .order("name", { ascending: true });

  if (showActiveOnly) {
    productQuery = productQuery.eq("is_active", true);
  }

  if (q) {
    productQuery = productQuery.ilike("name", `%${q}%`);
  }

  const { data: products, error } = await productQuery;

  if (error) {
    const { body, status } = errorResponse("INTERNAL_ERROR", "Failed to retrieve catalog", auditCtx.requestId, 500);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const filtered = (products || []).map((p: Record<string, unknown>) => ({
    id: p.id,
    name: p.name,
    category_id: p.category_id,
    is_active: p.is_active,
    plans: ((p.product_plans as Record<string, unknown>[]) || [])
      .filter((plan) => !showActiveOnly || plan.is_active === true)
      .map((plan) => ({
        id: plan.id,
        plan_name: plan.plan_name,
        purchase_type: plan.purchase_type,
        duration_days: plan.duration_days,
        warranty_days: plan.warranty_days,
        default_selling_price: plan.optional_list_price,
        is_active: plan.is_active,
      })),
  }));

  const { body, status } = success({ products: filtered });
  return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
}
