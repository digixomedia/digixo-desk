export type UserRole = "owner" | "manager";

export type CustomerType = "retail" | "reseller" | "business";
export type AcquisitionSource =
  | "WhatsApp"
  | "Telegram"
  | "Website"
  | "Referral"
  | "Reseller"
  | "Other";

export type PurchaseType = "one_time" | "recurring";
export type PaymentStatus =
  | "pending"
  | "partial"
  | "paid"
  | "refunded"
  | "partially_refunded"
  | "cancelled";
export type FulfilmentStatus =
  | "payment_confirmation"
  | "activation_pending"
  | "processing"
  | "activated"
  | "replacement_required"
  | "completed"
  | "cancelled";

export type SubscriptionStatus =
  | "active"
  | "due"
  | "overdue"
  | "renewed"
  | "lapsed"
  | "cancelled";

export type RenewalStatus =
  | "pending"
  | "reminded"
  | "interested"
  | "awaiting_payment"
  | "snoozed"
  | "renewed"
  | "no_response"
  | "not_renewing";

export type LeadStatus =
  | "new"
  | "follow_up"
  | "interested"
  | "awaiting_payment"
  | "won"
  | "lost"
  | "follow_up_later";

export type PaymentRecordStatus = "valid" | "bounced" | "reversed";

export interface Profile {
  id: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Customer {
  id: string;
  name: string | null;
  phone_country_code: string;
  phone_normalized: string;
  phone_display: string | null;
  email: string | null;
  customer_type: CustomerType;
  acquisition_source: AcquisitionSource | null;
  marketing_allowed: boolean;
  do_not_message: boolean;
  tags: string[];
  internal_note: string | null;
  assigned_to: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface Category {
  id: string;
  name: string;
  colour: string;
  created_by: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface Product {
  id: string;
  name: string;
  category_id: string | null;
  description: string | null;
  supplier_name: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  category?: Category | null;
}

export interface ProductPlan {
  id: string;
  product_id: string;
  plan_name: string;
  purchase_type: PurchaseType;
  duration_days: number | null;
  warranty_days: number | null;
  default_cost_price: number;
  default_selling_price: number;
  optional_list_price: number | null;
  optional_stock_count: number | null;
  low_stock_threshold: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  product?: Product | null;
}

export interface ProductPriceHistory {
  id: string;
  product_plan_id: string;
  previous_cost_price: number | null;
  new_cost_price: number;
  previous_selling_price: number | null;
  new_selling_price: number;
  effective_at: string;
  changed_by: string | null;
  created_at: string;
}

export interface Sale {
  id: string;
  sale_number: string;
  customer_id: string;
  product_plan_id: string | null;
  product_name_snapshot: string;
  plan_name_snapshot: string;
  purchase_type_snapshot: PurchaseType;
  duration_days_snapshot: number | null;
  list_price_snapshot: number | null;
  cost_price_snapshot: number;
  final_selling_price: number;
  payment_fee: number;
  refund_amount: number;
  replacement_cost: number;
  sale_date: string;
  payment_status: PaymentStatus;
  fulfilment_status: FulfilmentStatus;
  payment_method: string | null;
  transaction_reference: string | null;
  subscription_start_date: string | null;
  renewal_date: string | null;
  warranty_end_date: string | null;
  note: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  is_demo: boolean;
  customer?: Customer | null;
  product_plan?: ProductPlan | null;
  created_by_profile?: Profile | null;
}

export interface Payment {
  id: string;
  sale_id: string;
  amount: number;
  payment_method: string | null;
  transaction_reference: string | null;
  payment_date: string;
  status: PaymentRecordStatus;
  note: string | null;
  created_by: string | null;
  created_at: string;
  is_demo: boolean;
}

export interface Subscription {
  id: string;
  customer_id: string;
  original_sale_id: string | null;
  current_sale_id: string | null;
  product_plan_id: string | null;
  start_date: string;
  end_date: string | null;
  status: SubscriptionStatus;
  next_renewal_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  is_demo: boolean;
}

export interface Renewal {
  id: string;
  subscription_id: string;
  customer_id: string;
  due_date: string;
  status: RenewalStatus;
  snoozed_until: string | null;
  reminder_opened_at: string | null;
  reminded_at: string | null;
  renewed_at: string | null;
  linked_new_sale_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  is_demo: boolean;
}

export interface ActivityLog {
  id: string;
  user_id: string | null;
  action: string;
  description: string | null;
  entity_type: string | null;
  entity_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  created_at: string;
  user?: Profile | null;
}

export interface OwnerDashboardStats {
  revenue_this_month: number;
  cash_received_this_month: number;
  product_cost_this_month: number;
  gross_profit_this_month: number;
  active_customers: number;
  pending_payments: number;
  activations_pending: number;
  renewals_due_today: number;
  overdue_renewals: number;
  upcoming_renewals: number;
}

export interface ManagerDashboardStats {
  my_sales_today: number;
  pending_payments: number;
  activations_pending: number;
  renewals_due_today: number;
  overdue_renewals: number;
  upcoming_renewals: number;
  recent_customers: number;
}

export interface CreateSaleResult {
  sale_id: string;
  sale_number: string;
  customer_id: string;
}

// ===== API Key Management Types =====

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  is_active: boolean;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  rotated_from: string | null;
  created_by: string;
  request_count: number;
  last_request: string | null;
}

export interface ApiKeyStats {
  total_keys: number;
  active_keys: number;
  revoked_keys: number;
  total_requests: number;
  requests_today: number;
}

export interface ApiKeyAnalytics {
  keys: ApiKey[];
  stats: ApiKeyStats;
}

export interface CreateApiKeyResult {
  key_id: string;
  api_key: string;
  key_prefix: string;
  name: string;
}

export interface ApiRequestLog {
  id: string;
  request_id: string;
  key_name: string | null;
  endpoint: string;
  method: string;
  status_code: number;
  ip_address: string | null;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

export interface ApiRequestLogsResult {
  logs: ApiRequestLog[];
  total: number;
  limit: number;
  offset: number;
}
