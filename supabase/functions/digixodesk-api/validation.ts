// Request validation using Zod.
// All validation errors return generic field-level messages, never database details.
// Pagination is capped at 50, date ranges at 365 days.

import { z } from "npm:zod@3.23.8";

export const MAX_PAGE_LIMIT = 50;
export const MAX_DATE_RANGE_DAYS = 365;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(20),
});

export const catalogQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  active: z.enum(["true", "false"]).optional(),
});

export const customerSearchSchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
});

export const customerCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(30),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
  customer_type: z.enum(["retail", "reseller", "business"]).optional(),
  acquisition_source: z.string().trim().max(100).optional(),
});

export const customerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
  customer_type: z.enum(["retail", "reseller", "business"]).optional(),
  tags: z.array(z.string().trim().max(50)).max(20).optional(),
  internal_note: z.string().trim().max(5000).optional(),
  marketing_allowed: z.boolean().optional(),
  do_not_message: z.boolean().optional(),
});

export const saleSearchSchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["pending", "partial", "paid", "cancelled", "refunded", "partially_refunded"]).optional(),
  fulfilment_status: z.string().trim().max(50).optional(),
});

export const renewalSearchSchema = paginationSchema.extend({
  status: z.string().trim().max(50).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  upcoming: z.enum(["true", "false"]).optional(),
});

export const reportsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
}).refine(
  (data) => {
    const from = new Date(data.from);
    const to = new Date(data.to);
    const diffDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays <= MAX_DATE_RANGE_DAYS;
  },
  { message: "Date range cannot exceed 365 days and 'to' must be on or after 'from'" }
);

export const saleCreateSchema = z.object({
  customer_id: z.string().uuid().optional(),
  new_customer_name: z.string().trim().max(200).optional(),
  new_customer_phone: z.string().trim().max(30).optional(),
  new_customer_email: z.string().trim().email().max(200).optional().or(z.literal("")),
  new_customer_type: z.enum(["retail", "reseller", "business"]).optional(),
  new_customer_source: z.string().trim().max(100).optional(),
  is_custom: z.boolean().default(false),
  product_plan_id: z.string().uuid().optional(),
  product_name: z.string().trim().max(200).optional(),
  plan_name: z.string().trim().max(200).optional(),
  purchase_type: z.enum(["one_time", "recurring"]).optional(),
  duration_days: z.coerce.number().int().positive().optional(),
  warranty_days: z.coerce.number().int().positive().optional(),
  cost_price: z.coerce.number().min(0).optional(),
  list_price: z.coerce.number().min(0).optional(),
  final_selling_price: z.coerce.number().min(0),
  payment_fee: z.coerce.number().min(0).default(0),
  amount_received: z.coerce.number().min(0).default(0),
  payment_method: z.string().trim().max(50).optional(),
  transaction_reference: z.string().trim().max(200).optional(),
  sale_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fulfilment_status: z.enum(["payment_confirmation", "activation_pending", "processing", "activated", "replacement_required", "completed"]).optional(),
  note: z.string().trim().max(5000).optional(),
  sale_source: z.enum(["WhatsApp", "Telegram", "Website", "Referral", "Reseller", "Other"]).optional(),
  external_reference: z.string().trim().max(200).optional(),
  salesperson_id: z.string().uuid().optional(),
  salesperson_name: z.string().trim().max(200).optional(),
}).refine(
  (data) => data.customer_id || data.new_customer_phone,
  { message: "Either customer_id or new_customer_phone is required" }
).refine(
  (data) => data.is_custom || data.product_plan_id,
  { message: "Either product_plan_id or is_custom=true is required" }
).refine(
  (data) => !data.is_custom || (data.product_name && data.product_name.trim() !== ""),
  { message: "product_name is required for custom sales" }
);

export const paymentCreateSchema = z.object({
  amount: z.coerce.number().positive("Amount must be greater than zero"),
  payment_method: z.string().trim().max(50).optional(),
  transaction_reference: z.string().trim().max(200).optional(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().max(5000).optional(),
});

export const fulfilmentUpdateSchema = z.object({
  fulfilment_status: z.enum(["payment_confirmation", "activation_pending", "processing", "activated", "replacement_required", "completed"]),
  note: z.string().trim().max(5000).optional(),
});

export const renewalUpdateSchema = z.object({
  status: z.enum(["pending", "reminded", "interested", "awaiting_payment", "snoozed", "no_response"]).optional(),
  snoozed_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().max(5000).optional(),
}).refine(
  (data) => data.status || data.snoozed_until || data.note,
  { message: "At least one of status, snoozed_until, or note is required" }
).refine(
  (data) => data.status !== "snoozed" || data.snoozed_until,
  { message: "snoozed_until is required when status is snoozed" }
);

export type PaginationInput = z.infer<typeof paginationSchema>;
export type CatalogQueryInput = z.infer<typeof catalogQuerySchema>;
export type CustomerSearchInput = z.infer<typeof customerSearchSchema>;
export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;
export type SaleSearchInput = z.infer<typeof saleSearchSchema>;
export type SaleCreateInput = z.infer<typeof saleCreateSchema>;
export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;
export type FulfilmentUpdateInput = z.infer<typeof fulfilmentUpdateSchema>;
export type RenewalSearchInput = z.infer<typeof renewalSearchSchema>;
export type RenewalUpdateInput = z.infer<typeof renewalUpdateSchema>;
export type ReportsQueryInput = z.infer<typeof reportsQuerySchema>;

export function formatValidationError(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "unknown",
    message: issue.message,
  }));
}

// Maps RPC error messages (CODE: message format) to HTTP status and sanitized error code.
export function mapRpcError(rpcMessage: string): { code: string; message: string; status: number } {
  const match = rpcMessage.match(/^([A-Z_]+):\s*(.*)$/);
  if (!match) {
    return { code: "INTERNAL_ERROR", message: "An unexpected error occurred", status: 500 };
  }
  const [, code, rawMessage] = match;
  switch (code) {
    case "NOT_FOUND":
      return { code: "NOT_FOUND", message: rawMessage, status: 404 };
    case "VALIDATION_ERROR":
      return { code: "VALIDATION_ERROR", message: rawMessage, status: 422 };
    case "IDEMPOTENCY_CONFLICT":
      return { code: "IDEMPOTENCY_CONFLICT", message: rawMessage, status: 409 };
    case "DUPLICATE_EXTERNAL_REFERENCE":
      return { code: "DUPLICATE_EXTERNAL_REFERENCE", message: rawMessage, status: 409 };
    case "BUSINESS_RULE_ERROR":
      return { code: "BUSINESS_RULE_ERROR", message: rawMessage, status: 422 };
    default:
      return { code: "INTERNAL_ERROR", message: "An unexpected error occurred", status: 500 };
  }
}
