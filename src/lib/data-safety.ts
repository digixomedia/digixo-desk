export const BUSINESS_TIME_ZONE = "Asia/Kolkata";

export interface FinancialSummary {
  total_order_value: number;
  cash_collected: number;
  outstanding: number;
  refund_total: number;
  net_collected: number;
  sale_count: number;
}

export interface SaleFinancialDetail {
  total_price: number;
  total_paid: number;
  refund_amount: number;
  cash_refunded: number;
  balance_adjusted: number;
  outstanding: number;
  net_collected: number;
  cost_price: number;
  payment_fee: number;
  replacement_cost: number;
  gross_profit: number;
  margin_pct: number;
}

export interface DashboardFinancialStats {
  revenue_this_month: number;
  cash_received_this_month: number;
  expenses_this_month: number;
  gross_profit_this_month: number;
  net_profit_this_month: number;
  pending_payments_count: number;
  activations_pending_count: number;
  upcoming_renewals_count: number;
  overdue_renewals_count: number;
  renewals_due_today_count: number;
  prev_month_revenue: number;
  prev_month_profit: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFiniteNumbers(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => {
    const candidate = value[field];
    return (typeof candidate === "number" && Number.isFinite(candidate)) ||
      (typeof candidate === "string" && candidate.trim() !== "" && Number.isFinite(Number(candidate)));
  });
}

export function requireSingleRpcRow<T>(
  data: unknown,
  label: string,
  numericFields: readonly string[],
): T {
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0]) || !hasFiniteNumbers(data[0], numericFields)) {
    throw new Error(`${label} returned an unexpected response. Please retry.`);
  }
  return Object.fromEntries(
    Object.entries(data[0]).map(([key, value]) => [key, numericFields.includes(key) ? Number(value) : value]),
  ) as T;
}

export const FINANCIAL_SUMMARY_FIELDS = [
  "total_order_value",
  "cash_collected",
  "outstanding",
  "refund_total",
  "net_collected",
  "sale_count",
] as const;

export const SALE_FINANCIAL_DETAIL_FIELDS = [
  "total_price",
  "total_paid",
  "refund_amount",
  "cash_refunded",
  "balance_adjusted",
  "outstanding",
  "net_collected",
  "cost_price",
  "payment_fee",
  "replacement_cost",
  "gross_profit",
  "margin_pct",
] as const;

export const DASHBOARD_FINANCIAL_FIELDS = [
  "revenue_this_month",
  "cash_received_this_month",
  "expenses_this_month",
  "gross_profit_this_month",
  "net_profit_this_month",
  "pending_payments_count",
  "activations_pending_count",
  "upcoming_renewals_count",
  "overdue_renewals_count",
  "renewals_due_today_count",
  "prev_month_revenue",
  "prev_month_profit",
] as const;

export function usablePhoneSearch(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, "").replace(/^0+/, "");
  return digits.length >= 3 ? digits : null;
}

export function currentIstDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function currentIstMonthRange(now = new Date()): { from: string; toExclusive: string } {
  const today = currentIstDate(now);
  const [year, month] = today.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    from: `${year}-${String(month).padStart(2, "0")}-01`,
    toExclusive: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
  };
}

export function dateRangeStart(range: "7d" | "30d" | "90d" | "ytd" | "all", now = new Date()): string | null {
  if (range === "all") return null;
  const today = currentIstDate(now);
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (range === "7d") date.setUTCDate(date.getUTCDate() - 6);
  else if (range === "30d") date.setUTCDate(date.getUTCDate() - 29);
  else if (range === "90d") date.setUTCDate(date.getUTCDate() - 89);
  else date.setUTCMonth(0, 1);
  return date.toISOString().slice(0, 10);
}

export function addDateDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function requireRpcObject<T>(data: unknown, label: string, numericFields: readonly string[]): T {
  if (!isRecord(data) || !hasFiniteNumbers(data, numericFields)) {
    throw new Error(`${label} returned an unexpected response. Please retry.`);
  }
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, numericFields.includes(key) ? Number(value) : value]),
  ) as T;
}

export function escapeCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function rowsToCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

export async function collectCompletePages<T>(
  pageSize: number,
  loadPage: (offset: number, withCount: boolean) => Promise<{ rows: T[]; total: number }>,
  stableKey: (row: T) => string,
): Promise<{ rows: T[]; total: number }> {
  const rows: T[] = [];
  const keys = new Set<string>();
  let expectedTotal = 0;
  for (let offset = 0; ; offset += pageSize) {
    const page = await loadPage(offset, offset === 0);
    if (offset === 0) expectedTotal = page.total;
    for (const row of page.rows) {
      const key = stableKey(row);
      if (!key || keys.has(key)) throw new Error("Export returned a missing or duplicate stable record ID");
      keys.add(key);
      rows.push(row);
    }
    if (page.rows.length < pageSize) break;
  }
  if (rows.length !== expectedTotal) throw new Error(`Export stopped after ${rows.length} of ${expectedTotal} records`);
  return { rows, total: expectedTotal };
}
