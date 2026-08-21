// DigiXO Desk API — Phase 2B: Core Business Operations (Read + Write)
// Single Edge Function handling all /v1/* routes with custom API-key authentication.
// JWT verification is disabled; authentication is done via DigiXO Desk API keys.

import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { extractBearerToken, validateApiKey, touchLastUsed, type ApiKeyInfo } from "./auth.ts";
import { checkRateLimit, maybeCleanupRateLimits } from "./rate-limit.ts";
import { createAuditContext, logAudit, redactError, type AuditContext } from "./audit.ts";
import { errorResponse, jsonResponse } from "./response.ts";
import { requireScope } from "./middleware.ts";
import { handleHealth } from "./routes/health.ts";
import { handleWhoami } from "./routes/whoami.ts";
import { handleCatalogProducts } from "./routes/catalog.ts";
import { handleCustomerSearch, handleCustomerDetail, handleCustomerCreate, handleCustomerUpdate } from "./routes/customers.ts";
import { handleSaleSearch, handleSaleDetail, handleSaleCreate, handlePaymentCreate, handleFulfilmentUpdate } from "./routes/sales.ts";
import { handleRenewalSearch, handleRenewalUpdate } from "./routes/renewals.ts";
import { handleReportsSummary } from "./routes/reports.ts";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "https://digixo-desk-gt8r.bolt.host";

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
    "Access-Control-Max-Age": "86400",
  };
  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  }
  return headers;
}

const RATE_LIMIT_PER_KEY = 60;
const RATE_LIMIT_PER_IP = 120;

function createServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Missing server configuration");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface RouteMatch {
  route: string;
  action: string;
  requiresAuth: boolean;
  scope: string | null;
  handler: (req: Request, supabase: ReturnType<typeof createClient>, auditCtx: AuditContext, apiKeyInfo: ApiKeyInfo, corsHeaders: Record<string, string>, pathParam?: string) => Promise<Response>;
  pathParam?: string;
}

function matchRoute(path: string, method: string): RouteMatch | null {
  // Public routes
  if (path === "/v1/health" && method === "GET") {
    return {
      route: "/v1/health", action: "health_check", requiresAuth: false, scope: null,
      handler: async (req, _supabase, auditCtx, _apiKeyInfo, corsHeaders) => handleHealth(req, auditCtx, corsHeaders),
    };
  }

  // Authenticated routes
  if (path === "/v1/whoami" && method === "GET") {
    return {
      route: "/v1/whoami", action: "key_validate", requiresAuth: true, scope: null,
      handler: async (req, _supabase, auditCtx, apiKeyInfo, corsHeaders) => handleWhoami(req, auditCtx, apiKeyInfo, corsHeaders),
    };
  }

  if (path === "/v1/catalog/products" && method === "GET") {
    return {
      route: "/v1/catalog/products", action: "catalog_read", requiresAuth: true, scope: "catalog:read",
      handler: handleCatalogProducts,
    };
  }

  // Customers: GET (list), POST (create), GET/:id (detail), PATCH/:id (update)
  if (path === "/v1/customers" && method === "GET") {
    return {
      route: "/v1/customers", action: "customers_read", requiresAuth: true, scope: "customers:read",
      handler: handleCustomerSearch,
    };
  }
  if (path === "/v1/customers" && method === "POST") {
    return {
      route: "/v1/customers", action: "customer_create", requiresAuth: true, scope: "customers:create",
      handler: handleCustomerCreate,
    };
  }

  const customerMatch = path.match(/^\/v1\/customers\/([^/]+)$/);
  if (customerMatch && method === "GET") {
    return {
      route: "/v1/customers/:id", action: "customer_detail", requiresAuth: true, scope: "customers:read",
      handler: handleCustomerDetail, pathParam: customerMatch[1],
    };
  }
  if (customerMatch && method === "PATCH") {
    return {
      route: "/v1/customers/:id", action: "customer_update", requiresAuth: true, scope: "customers:update",
      handler: handleCustomerUpdate, pathParam: customerMatch[1],
    };
  }

  // Sales: GET (list), POST (create), GET/:id (detail)
  if (path === "/v1/sales" && method === "GET") {
    return {
      route: "/v1/sales", action: "sales_read", requiresAuth: true, scope: "sales:read",
      handler: handleSaleSearch,
    };
  }
  if (path === "/v1/sales" && method === "POST") {
    return {
      route: "/v1/sales", action: "sale_create", requiresAuth: true, scope: "sales:create",
      handler: handleSaleCreate,
    };
  }

  const saleMatch = path.match(/^\/v1\/sales\/([^/]+)$/);
  if (saleMatch && method === "GET") {
    return {
      route: "/v1/sales/:id", action: "sale_detail", requiresAuth: true, scope: "sales:read",
      handler: handleSaleDetail, pathParam: saleMatch[1],
    };
  }

  // Payments: POST /v1/sales/:id/payments
  const paymentMatch = path.match(/^\/v1\/sales\/([^/]+)\/payments$/);
  if (paymentMatch && method === "POST") {
    return {
      route: "/v1/sales/:id/payments", action: "payment_create", requiresAuth: true, scope: "payments:create",
      handler: handlePaymentCreate, pathParam: paymentMatch[1],
    };
  }

  // Fulfilment: PATCH /v1/sales/:id/fulfilment
  const fulfilmentMatch = path.match(/^\/v1\/sales\/([^/]+)\/fulfilment$/);
  if (fulfilmentMatch && method === "PATCH") {
    return {
      route: "/v1/sales/:id/fulfilment", action: "fulfilment_update", requiresAuth: true, scope: "fulfilment:update",
      handler: handleFulfilmentUpdate, pathParam: fulfilmentMatch[1],
    };
  }

  // Renewals: GET (list), PATCH/:id (update)
  if (path === "/v1/renewals" && method === "GET") {
    return {
      route: "/v1/renewals", action: "renewals_read", requiresAuth: true, scope: "renewals:read",
      handler: handleRenewalSearch,
    };
  }

  const renewalMatch = path.match(/^\/v1\/renewals\/([^/]+)$/);
  if (renewalMatch && method === "PATCH") {
    return {
      route: "/v1/renewals/:id", action: "renewal_update", requiresAuth: true, scope: "renewals:update",
      handler: handleRenewalUpdate, pathParam: renewalMatch[1],
    };
  }

  if (path === "/v1/reports/summary" && method === "GET") {
    return {
      route: "/v1/reports/summary", action: "reports_read", requiresAuth: true, scope: "reports:read",
      handler: handleReportsSummary,
    };
  }

  return null;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname
    .replace(/^\/functions\/v1\/digixodesk-api/, "")
    .replace(/^\/digixodesk-api/, "");

  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabase = createServiceClient();

  const routeMatch = matchRoute(path, req.method);
  if (!routeMatch) {
    const auditCtx = createAuditContext(req, path, "unknown");
    const { body, status } = errorResponse("NOT_FOUND", "Endpoint not found", auditCtx.requestId, 404);
    await logAudit(supabase, auditCtx, status, "error", "Endpoint not found");
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }

  const { route, action, requiresAuth, scope, handler, pathParam } = routeMatch;
  const auditCtx = createAuditContext(req, route, action);

  try {
    await maybeCleanupRateLimits(supabase);
  } catch {
    // Cleanup failure should not block the request
  }

  try {
    let rateBucket: string;
    let rateLimit: number;

    if (!requiresAuth) {
      const ip = auditCtx.ipAddress || "unknown";
      rateBucket = `ip:${ip}`;
      rateLimit = RATE_LIMIT_PER_IP;
    } else {
      const token = extractBearerToken(req);
      if (!token) {
        const { body, status } = errorResponse("UNAUTHORIZED", "Missing or invalid Authorization header", auditCtx.requestId, 401);
        await logAudit(supabase, auditCtx, status, "auth_error", "Missing Authorization header");
        return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
      }

      const encoder = new TextEncoder();
      const hashData = await crypto.subtle.digest("SHA-256", encoder.encode(token));
      const tokenHash = Array.from(new Uint8Array(hashData)).map((b) => b.toString(16).padStart(2, "0")).join("");
      rateBucket = `key:${tokenHash.slice(0, 16)}`;
      rateLimit = RATE_LIMIT_PER_KEY;
    }

    const rateResult = await checkRateLimit(supabase, rateBucket, rateLimit);
    if (!rateResult.allowed) {
      const { body, status } = errorResponse("RATE_LIMITED", "Rate limit exceeded", auditCtx.requestId, 429);
      await logAudit(supabase, auditCtx, status, "rate_limited", "Rate limit exceeded");
      return jsonResponse(body, status, {
        ...corsHeaders,
        "X-Request-ID": auditCtx.requestId,
        "Retry-After": String(rateResult.retryAfter),
        "X-RateLimit-Remaining": "0",
      });
    }

    let apiKeyInfo: ApiKeyInfo | null = null;
    if (requiresAuth) {
      const token = extractBearerToken(req);
      if (!token) {
        const { body, status } = errorResponse("UNAUTHORIZED", "Missing or invalid Authorization header", auditCtx.requestId, 401);
        await logAudit(supabase, auditCtx, status, "auth_error", "Missing Authorization header");
        return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
      }

      apiKeyInfo = await validateApiKey(supabase, token);
      if (!apiKeyInfo) {
        const { body, status } = errorResponse("UNAUTHORIZED", "Invalid or expired API key", auditCtx.requestId, 401);
        await logAudit(supabase, auditCtx, status, "auth_error", "Invalid or expired API key");
        return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
      }

      auditCtx.apiKeyId = apiKeyInfo.id;
      touchLastUsed(supabase, apiKeyInfo.id).catch(() => {});

      // Scope check (in-memory, no DB round trip)
      if (scope) {
        const scopeError = requireScope(apiKeyInfo, scope, auditCtx, corsHeaders);
        if (scopeError) {
          await logAudit(supabase, auditCtx, scopeError.status, "error", `Missing scope: ${scope}`);
          return scopeError;
        }
      }
    }

    let response: Response;
    if (pathParam) {
      response = await handler(req, supabase, auditCtx, apiKeyInfo!, corsHeaders, pathParam);
    } else {
      response = await handler(req, supabase, auditCtx, apiKeyInfo!, corsHeaders);
    }

    response.headers.set("X-RateLimit-Remaining", String(rateResult.remaining));

    await logAudit(supabase, auditCtx, response.status, response.status < 400 ? "success" : "error", null);

    return response;
  } catch (err) {
    const redactedMsg = redactError(err);
    const { body, status } = errorResponse("INTERNAL_ERROR", "Internal error", auditCtx.requestId, 500);
    await logAudit(supabase, auditCtx, status, "error", redactedMsg);
    return jsonResponse(body, status, { ...corsHeaders, "X-Request-ID": auditCtx.requestId });
  }
});
