// Convert a UTC timestamp string to an IST Date for display.
// Supabase returns timestamptz as ISO strings in UTC (Z suffix).
// IST is UTC+5:30.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function toISTDate(value: string | Date | null): Date | null {
  if (!value) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS);
}

export function formatDate(value: string | Date | null): string {
  const d = toISTDate(value);
  if (!d) return "—";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export function formatDateTime(value: string | Date | null): string {
  const d = toISTDate(value);
  if (!d) return "—";
  const date = formatDate(value);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${date} ${hh}:${min}`;
}

export function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "₹0.00";
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "₹0.00";
  return n.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "0";
  return value.toLocaleString("en-IN");
}

export function normalizePhone(raw: string): string {
  return raw.replace(/[^0-9]/g, "").replace(/^0+/, "");
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function relativeTime(value: string | Date | null): string {
  const d = toISTDate(value);
  if (!d) return "—";
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const diffMs = istNow.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return formatDate(value);
}
