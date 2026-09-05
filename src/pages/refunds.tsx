import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IndianRupee, Plus, RotateCcw, Search, TrendingDown } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { currentIstDate, requireSingleRpcRow, usablePhoneSearch } from "@/lib/data-safety";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { formatDate, formatMoney } from "@/lib/format";
import type { Customer, Sale } from "@/lib/types";
import { EmptyState, PageContainer, PageHeader, RetryableError, StatusBadge } from "@/components/ui-shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

type SaleWithCustomer = Sale & { customer: Customer | null };
type RefundEvent = { id: string; sale_id: string; amount: number; refund_type: string; occurred_on: string | null; reason: string | null; sale: SaleWithCustomer | null };

function monthRange(key: string) {
  const [year, month] = key.split("-").map(Number);
  return { start: `${year}-${String(month).padStart(2, "0")}-01`, end: `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01` };
}
function monthOptions() {
  const [year, month] = currentIstDate().split("-").map(Number);
  return Array.from({ length: 12 }, (_, i) => { const date = new Date(Date.UTC(year, month - 1 - i, 1)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; });
}
function monthLabel(key: string) {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(Date.UTC(year, month - 1, 1)));
}
async function matchingSaleIds(search: string): Promise<string[] | undefined> {
  if (!search.trim()) return undefined;
  const { data, error } = await supabase.rpc("search_sale_ids", { p_search: search.trim(), p_phone_digits: usablePhoneSearch(search) });
  if (error) throw error;
  return (data ?? []).map((row: { id: string }) => row.id);
}
async function allRefundEvents(start: string, end: string, ids?: string[]): Promise<RefundEvent[]> {
  if (ids?.length === 0) return [];
  const result: RefundEvent[] = [];
  for (let offset = 0; ; offset += 500) {
    let query = supabase.from("refund_events").select("id,sale_id,amount,refund_type,occurred_on,reason,sale:sales!inner(*,customer:customers(*))").eq("sale.is_demo", false).neq("refund_type", "legacy_unknown").gte("occurred_on", start).lt("occurred_on", end).order("occurred_on", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 499);
    if (ids) query = query.in("sale_id", ids);
    const { data, error } = await query;
    if (error) throw error;
    const page = (data ?? []) as unknown as RefundEvent[];
    result.push(...page);
    if (page.length < 500) return result;
  }
}

export function RefundsPage() {
  const client = useQueryClient();
  const options = useMemo(monthOptions, []);
  const [month, setMonth] = useState(options[0]);
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState(false);
  const debounced = useDebouncedValue(search, 300);
  const range = monthRange(month);
  const query = useQuery({ queryKey: ["refunds", month, debounced], queryFn: async () => allRefundEvents(range.start, range.end, await matchingSaleIds(debounced)) });
  const events = query.data ?? [];
  const cashEvents = events.filter((event) => event.refund_type === "cash_refund");
  const total = cashEvents.reduce((sum, event) => sum + Number(event.amount), 0);
  const cards = [["Cash Refunded", formatMoney(total), IndianRupee], ["Refund Events", String(cashEvents.length), RotateCcw], ["Average Refund", formatMoney(cashEvents.length ? total / cashEvents.length : 0), TrendingDown]] as const;
  const refresh = () => [["refunds"], ["sales"], ["financial-reports"], ["dashboard-financial-stats"], ["customer-financial-summary"], ["sale-financial-detail"]].forEach((key) => client.invalidateQueries({ queryKey: key }));
  return <PageContainer><div className="flex flex-col gap-6">
    <PageHeader title="Refunds" description="Cash refunds are reported by their actual refund date; balance adjustments remain separate." actions={<div className="flex gap-2"><Select value={month} onValueChange={setMonth}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent>{options.map((value) => <SelectItem key={value} value={value}>{monthLabel(value)}</SelectItem>)}</SelectContent></Select><Button onClick={() => setDialog(true)}><Plus className="mr-1 h-4 w-4" />Record Refund</Button></div>} />
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{query.isLoading ? [1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />) : cards.map(([label, value, Icon]) => <Card key={label}><CardContent className="flex items-center gap-3 p-4"><Icon className="h-5 w-5" /><div><p className="text-xs text-muted-foreground">{label}</p><p className="text-lg font-semibold">{value}</p></div></CardContent></Card>)}</div>
    <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer, phone, sale #, or product…" /></div>
    {query.isError ? <RetryableError message="Refunds could not be loaded." onRetry={() => query.refetch()} /> : query.isLoading ? <Skeleton className="h-64" /> : events.length === 0 ? <EmptyState icon={<RotateCcw className="h-5 w-5" />} title="No matching refund events" description="Refunds appear in the period when the money was returned." /> : <Card><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="p-3">Sale #</th><th className="p-3">Customer</th><th className="p-3">Product</th><th className="p-3">Refund Date</th><th className="p-3 text-right">Cash Refunded</th><th className="p-3">Status</th><th className="p-3">Reason</th></tr></thead><tbody>{events.map((event) => <tr key={event.id} className="border-b last:border-0"><td className="p-3 font-medium">{event.sale?.sale_number ?? "—"}</td><td className="p-3">{event.sale?.customer?.name ?? "Unnamed"}</td><td className="p-3">{event.sale?.product_name_snapshot ?? "—"}</td><td className="p-3">{event.occurred_on ? formatDate(event.occurred_on) : "Unknown"}</td><td className="p-3 text-right text-destructive">{formatMoney(event.amount)}</td><td className="p-3">{event.sale ? <StatusBadge status={event.sale.payment_status} /> : "—"}</td><td className="p-3">{event.reason ?? "—"}</td></tr>)}</tbody></table></div></Card>}
  </div><RecordRefundDialog open={dialog} onOpenChange={setDialog} onRecorded={refresh} /></PageContainer>;
}

function RecordRefundDialog({ open, onOpenChange, onRecorded }: { open: boolean; onOpenChange: (v: boolean) => void; onRecorded: () => void }) {
  const [search, setSearch] = useState(""); const debounced = useDebouncedValue(search, 300);
  const [saleId, setSaleId] = useState(""); const [amount, setAmount] = useState(""); const [date, setDate] = useState(currentIstDate()); const [reason, setReason] = useState("");
  const idempotency = useRef(crypto.randomUUID());
  const sales = useQuery({ queryKey: ["refund-sale-options", debounced], enabled: open, queryFn: async () => { const ids = await matchingSaleIds(debounced); if (ids?.length === 0) return []; let q = supabase.from("sales").select("*,customer:customers(*)").eq("is_demo", false).is("archived_at", null).order("sale_date", { ascending: false }).limit(50); if (ids) q = q.in("id", ids); const { data, error } = await q; if (error) throw error; return (data ?? []) as SaleWithCustomer[]; } });
  const selected = sales.data?.find((sale) => sale.id === saleId);
  const financial = useQuery({ queryKey: ["sale-financial-detail", saleId], enabled: !!saleId, queryFn: async () => { const { data, error } = await supabase.rpc("sale_financial_detail", { p_sale_id: saleId }); if (error) throw error; return requireSingleRpcRow<{ total_paid: number; cash_refunded: number }>(data, "Sale financial detail", ["total_paid", "cash_refunded"]); } });
  const available = financial.data ? Math.max(0, financial.data.total_paid - financial.data.cash_refunded) : 0;
  const mutation = useMutation({ mutationFn: async () => { const value = Number(amount); if (!saleId || !date || !Number.isFinite(value) || value <= 0) throw new Error("Select a sale, date, and valid amount"); if (!financial.data || value > available) throw new Error("Refund cannot exceed the available collected cash"); const { error } = await supabase.rpc("record_refund", { p_sale_id: saleId, p_amount: value, p_reason: reason || null, p_refund_type: "cash_refund", p_refund_date: date, p_idempotency_key: idempotency.current }); if (error) throw error; }, onSuccess: () => { toast.success("Refund recorded"); onRecorded(); onOpenChange(false); setSearch(""); setSaleId(""); setAmount(""); setDate(currentIstDate()); setReason(""); idempotency.current = crypto.randomUUID(); }, onError: (error: Error) => toast.error(error.message) });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Record a cash refund</DialogTitle><DialogDescription>Use the date the money was actually returned.</DialogDescription></DialogHeader><div className="space-y-4">
    <div><Label>Search sale</Label><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Sale #, product, customer, or phone…" /></div>
    <div><Label>Select sale</Label>{sales.isLoading ? <Skeleton className="h-10" /> : <Select value={saleId} onValueChange={(id) => { setSaleId(id); setAmount(""); }}><SelectTrigger><SelectValue placeholder="Choose a sale…" /></SelectTrigger><SelectContent>{(sales.data ?? []).map((sale) => <SelectItem key={sale.id} value={sale.id}>{sale.sale_number} — {sale.customer?.name ?? "Unnamed"} · {sale.product_name_snapshot}</SelectItem>)}</SelectContent></Select>}</div>
    {selected && <div className="rounded border p-3 text-sm"><div className="flex justify-between"><span>Sale value</span><span>{formatMoney(selected.final_selling_price)}</span></div><div className="flex justify-between"><span>Available cash to refund</span><span>{financial.isLoading ? "Loading…" : financial.isError ? "Unavailable" : formatMoney(available)}</span></div></div>}
    <div className="grid gap-3 sm:grid-cols-2"><div><Label>Amount</Label><Input type="number" min={0} max={available || undefined} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div><div><Label>Actual refund date</Label><Input type="date" max={currentIstDate()} value={date} onChange={(e) => setDate(e.target.value)} /></div></div>
    <div><Label>Reason (optional)</Label><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></div>
  </div><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="destructive" disabled={mutation.isPending || !saleId || financial.isLoading} onClick={() => mutation.mutate()}>{mutation.isPending ? "Recording…" : "Record Refund"}</Button></DialogFooter></DialogContent></Dialog>;
}
