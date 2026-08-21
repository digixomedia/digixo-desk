import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { PageContainer, PageHeader, EmptyState, StatusBadge } from "@/components/ui-shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  RotateCcw,
  IndianRupee,
  TrendingDown,
  CalendarDays,
  Plus,
  Search,
} from "lucide-react";
import { formatMoney, formatDate, normalizePhone } from "@/lib/format";
import type { Sale, Customer } from "@/lib/types";

type SaleWithCustomer = Sale & { customer: Customer | null };

function getMonthRange(monthKey: string): { start: string; end: string } {
  const [year, month] = monthKey.split("-").map(Number);
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = new Date(year, month, 0).toISOString().slice(0, 10);
  return { start, end };
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  const d = new Date(year, month - 1, 1);
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

function buildMonthOptions(count: number): string[] {
  const now = new Date();
  const opts: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    opts.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return opts;
}

export function RefundsPage() {
  const queryClient = useQueryClient();

  const monthOptions = useMemo(() => buildMonthOptions(12), []);
  const [monthKey, setMonthKey] = useState(monthOptions[0]);
  const [search, setSearch] = useState("");
  const [recordOpen, setRecordOpen] = useState(false);

  const { start, end } = getMonthRange(monthKey);

  const { data: refundedSales, isLoading } = useQuery({
    queryKey: ["refunds", monthKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("*, customer:customers(*)")
        .gt("refund_amount", 0)
        .gte("sale_date", start)
        .lte("sale_date", end)
        .order("sale_date", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as SaleWithCustomer[];
    },
  });

  const { data: monthRevenue } = useQuery({
    queryKey: ["refunds-month-revenue", monthKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("final_selling_price")
        .gte("sale_date", start)
        .lte("sale_date", end);
      if (error) throw error;
      return (data ?? []).reduce((sum, s) => sum + s.final_selling_price, 0);
    },
  });

  const allRefunds = refundedSales ?? [];

  const filteredRefunds = search.trim()
    ? allRefunds.filter((s) => {
        const norm = normalizePhone(search);
        const lower = search.toLowerCase();
        return (
          (s.customer?.name?.toLowerCase().includes(lower) ?? false) ||
          (s.customer?.phone_normalized.includes(norm) ?? false) ||
          (s.customer?.phone_display?.toLowerCase().includes(lower) ?? false) ||
          s.sale_number.toLowerCase().includes(lower) ||
          (s.product_name_snapshot.toLowerCase().includes(lower) ?? false)
        );
      })
    : allRefunds;

  const totalRefundAmount = allRefunds.reduce((sum, s) => sum + s.refund_amount, 0);
  const refundCount = allRefunds.length;
  const avgRefund = refundCount > 0 ? totalRefundAmount / refundCount : 0;
  const revenue = monthRevenue ?? 0;
  const refundShare = revenue > 0 ? (totalRefundAmount / revenue) * 100 : 0;

  const summaryCards = [
    {
      label: "Total Refunds",
      value: formatMoney(totalRefundAmount),
      icon: <IndianRupee className="h-5 w-5" />,
      tone: "text-destructive bg-destructive/10",
    },
    {
      label: "Number of Refunds",
      value: String(refundCount),
      icon: <RotateCcw className="h-5 w-5" />,
      tone: "text-warning bg-warning/10",
    },
    {
      label: "Average Refund",
      value: formatMoney(avgRefund),
      icon: <TrendingDown className="h-5 w-5" />,
      tone: "text-info bg-info/10",
    },
    {
      label: "Share of Revenue",
      value: `${refundShare.toFixed(1)}%`,
      icon: <CalendarDays className="h-5 w-5" />,
      tone: "text-muted-foreground bg-muted/50",
    },
  ];

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Refunds"
          description="Track refunds issued to customers and their impact on monthly profit"
          actions={
            <div className="flex items-center gap-2">
              <Select value={monthKey} onValueChange={setMonthKey}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {monthOptions.map((m) => (
                    <SelectItem key={m} value={m}>
                      {monthLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button className="gap-1.5" onClick={() => setRecordOpen(true)}>
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">Record Refund</span>
              </Button>
            </div>
          }
        />

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {isLoading
            ? Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <Skeleton className="h-10 w-10 rounded-lg" />
                    <Skeleton className="mt-2 h-4 w-20" />
                    <Skeleton className="mt-1 h-6 w-16" />
                  </CardContent>
                </Card>
              ))
            : summaryCards.map((card) => (
                <Card key={card.label}>
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${card.tone}`}>
                      {card.icon}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-muted-foreground">{card.label}</p>
                      <p className="text-lg font-semibold tracking-tight">{card.value}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by customer, phone, sale #, or product…"
            className="pl-9"
          />
        </div>

        {/* List */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : filteredRefunds.length === 0 ? (
          <EmptyState
            icon={<RotateCcw className="h-5 w-5" />}
            title="No refunds this month"
            description="Record a refund when a customer's product doesn't work and needs reimbursement."
          />
        ) : (
          <>
            {/* Desktop table */}
            <Card className="hidden lg:block">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 px-3 font-medium">Sale #</th>
                      <th className="py-2 px-3 font-medium">Customer</th>
                      <th className="py-2 px-3 font-medium">Phone</th>
                      <th className="py-2 px-3 font-medium">Product</th>
                      <th className="py-2 px-3 font-medium">Sale Date</th>
                      <th className="py-2 px-3 font-medium text-right">Refund Amount</th>
                      <th className="py-2 px-3 font-medium">Status</th>
                      <th className="py-2 px-3 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRefunds.map((s) => (
                      <tr key={s.id} className="border-b last:border-0 hover:bg-muted/40">
                        <td className="py-2 px-3 font-medium">{s.sale_number}</td>
                        <td className="py-2 px-3">{s.customer?.name ?? "Unnamed"}</td>
                        <td className="py-2 px-3 text-muted-foreground">
                          {s.customer?.phone_display ?? s.customer?.phone_normalized ?? "—"}
                        </td>
                        <td className="py-2 px-3">
                          {s.product_name_snapshot}
                          <span className="text-muted-foreground"> · {s.plan_name_snapshot}</span>
                        </td>
                        <td className="py-2 px-3 text-muted-foreground">{formatDate(s.sale_date)}</td>
                        <td className="py-2 px-3 text-right font-medium text-destructive">
                          {formatMoney(s.refund_amount)}
                        </td>
                        <td className="py-2 px-3">
                          <StatusBadge status={s.payment_status} />
                        </td>
                        <td className="py-2 px-3 text-muted-foreground">
                          {s.note ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Mobile cards */}
            <div className="flex flex-col gap-2 lg:hidden">
              {filteredRefunds.map((s) => (
                <Card key={s.id}>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{s.sale_number}</span>
                      <StatusBadge status={s.payment_status} />
                    </div>
                    <p className="mt-1 text-sm">
                      {s.customer?.name ?? "Unnamed"} —{" "}
                      {s.customer?.phone_display ?? s.customer?.phone_normalized ?? "—"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.product_name_snapshot} · {s.plan_name_snapshot}
                    </p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        {formatDate(s.sale_date)}
                      </span>
                      <span className="font-medium text-destructive">
                        {formatMoney(s.refund_amount)}
                      </span>
                    </div>
                    {s.note && (
                      <p className="mt-1 text-xs text-muted-foreground">{s.note}</p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>

      <RecordRefundDialog
        open={recordOpen}
        onOpenChange={setRecordOpen}
        onRecorded={() => {
          queryClient.invalidateQueries({ queryKey: ["refunds"] });
          queryClient.invalidateQueries({ queryKey: ["refunds-month-revenue"] });
          queryClient.invalidateQueries({ queryKey: ["sales"] });
          queryClient.invalidateQueries({ queryKey: ["financial-reports"] });
        }}
      />
    </PageContainer>
  );
}

function RecordRefundDialog({
  open,
  onOpenChange,
  onRecorded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecorded: () => void;
}) {
  const [saleSearch, setSaleSearch] = useState("");
  const [selectedSaleId, setSelectedSaleId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [refundType, setRefundType] = useState<"full" | "partial">("full");
  const [reason, setReason] = useState("");

  const { data: saleOptions, isLoading: searchingSales } = useQuery({
    queryKey: ["refund-sale-options", saleSearch],
    queryFn: async () => {
      let q = supabase
        .from("sales")
        .select("*, customer:customers(*)")
        .order("sale_date", { ascending: false })
        .limit(50);

      const { data, error } = await q;
      if (error) throw error;
      let result = data as (Sale & { customer: Customer | null })[];

      if (saleSearch.trim()) {
        const norm = normalizePhone(saleSearch);
        const lower = saleSearch.toLowerCase();
        result = result.filter(
          (s) =>
            s.sale_number.toLowerCase().includes(lower) ||
            (s.customer?.name?.toLowerCase().includes(lower) ?? false) ||
            (s.customer?.phone_normalized.includes(norm) ?? false) ||
            (s.customer?.phone_display?.toLowerCase().includes(lower) ?? false),
        );
      }

      return result;
    },
    enabled: open,
  });

  const selectedSale = saleOptions?.find((s) => s.id === selectedSaleId);

  const recordMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSaleId) throw new Error("Select a sale to refund");
      const refundAmount = parseFloat(amount);
      if (!refundAmount || refundAmount <= 0) throw new Error("Enter a valid refund amount");

      const sale = saleOptions?.find((s) => s.id === selectedSaleId);
      if (!sale) throw new Error("Sale not found");

      if (refundAmount > sale.final_selling_price) {
        throw new Error("Refund amount cannot exceed the sale's selling price");
      }

      const { error } = await supabase.rpc("record_refund", {
        p_sale_id: selectedSaleId,
        p_amount: refundAmount,
        p_reason: reason || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Refund recorded");
      onRecorded();
      onOpenChange(false);
      setSaleSearch("");
      setSelectedSaleId("");
      setAmount("");
      setRefundType("full");
      setReason("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a refund</DialogTitle>
          <DialogDescription>
            Record a refund for a customer whose product didn't work. This will be subtracted from monthly profit.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Sale search */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Search sale</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={saleSearch}
                onChange={(e) => setSaleSearch(e.target.value)}
                placeholder="Sale #, customer name, or phone…"
                className="pl-9"
              />
            </div>
          </div>

          {/* Sale picker */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Select sale</Label>
            {searchingSales ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <Select value={selectedSaleId} onValueChange={setSelectedSaleId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a sale…" />
                </SelectTrigger>
                <SelectContent>
                  {(saleOptions ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.sale_number} — {s.customer?.name ?? "Unnamed"} · {s.product_name_snapshot}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {selectedSale && (
            <div className="rounded-lg border p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Selling Price</span>
                <span className="font-medium">{formatMoney(selectedSale.final_selling_price)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Existing Refund</span>
                <span>{formatMoney(selectedSale.refund_amount)}</span>
              </div>
            </div>
          )}

          {/* Refund type */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Refund type</Label>
            <Select value={refundType} onValueChange={(v) => setRefundType(v as "full" | "partial")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full refund</SelectItem>
                <SelectItem value="partial">Partial refund</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Amount */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Refund amount</Label>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>

          {/* Reason */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Reason (optional)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Product not working, customer returned item…"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => recordMutation.mutate()}
            disabled={recordMutation.isPending || !selectedSaleId}
          >
            Record Refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
