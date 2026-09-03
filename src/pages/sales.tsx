import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { PageContainer, PageHeader, EmptyState, StatusBadge } from "@/components/ui-shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "sonner";
import {
  Search,
  ShoppingCart,
  X,
  Plus,
  Undo2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  IndianRupee,
  Clock,
} from "lucide-react";
import { formatMoney, formatDate, formatDateTime, normalizePhone } from "@/lib/format";
import type { Sale, Payment } from "@/lib/types";

const PAGE_SIZE = 20;

type SortField = "sale_date" | "final_selling_price" | "sale_number";
type SortDir = "asc" | "desc";

export function SalesPage() {
  const { profile, isOwner } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [payStatus, setPayStatus] = useState<string>(searchParams.get("pay") || "all");
  const [fulfilStatus, setFulfilStatus] = useState<string>(searchParams.get("fulfil") || "all");
  const [page, setPage] = useState(0);
  const [sortField, setSortField] = useState<SortField>("sale_date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(
    searchParams.get("id")
  );

  // Sync URL params to filters
  useEffect(() => {
    const pay = searchParams.get("pay");
    const fulfil = searchParams.get("fulfil");
    if (pay) setPayStatus(pay);
    if (fulfil) setFulfilStatus(fulfil);
  }, [searchParams]);

  const { data: salesData, isLoading } = useQuery({
    queryKey: ["sales-paginated", search, payStatus, fulfilStatus, page, sortField, sortDir],
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let countQuery = supabase
        .from("sales")
        .select("id, final_selling_price", { count: "exact" });

      let dataQuery = supabase
        .from("sales")
        .select("*, customer:customers(*), created_by_profile:profiles!sales_created_by_fkey(*)");

      if (payStatus !== "all") {
        countQuery = countQuery.eq("payment_status", payStatus);
        dataQuery = dataQuery.eq("payment_status", payStatus);
      }
      if (fulfilStatus !== "all") {
        countQuery = countQuery.eq("fulfilment_status", fulfilStatus);
        dataQuery = dataQuery.eq("fulfilment_status", fulfilStatus);
      }
      if (search.trim()) {
        const lower = search.toLowerCase();
        const norm = normalizePhone(search);
        const orFilter = `sale_number.ilike.%${lower}%,product_name_snapshot.ilike.%${lower}%`;
        countQuery = countQuery.or(orFilter);
        dataQuery = dataQuery.or(orFilter);
        if (norm) {
          dataQuery = dataQuery.or(`customer.phone_normalized.ilike.%${norm}%`);
        }
      }

      dataQuery = dataQuery
        .order(sortField, { ascending: sortDir === "asc" })
        .range(from, to);

      const [countResult, dataResult] = await Promise.all([countQuery, dataQuery]);

      if (countResult.error) throw countResult.error;
      if (dataResult.error) throw dataResult.error;

      return {
        sales: dataResult.data as Sale[],
        total: countResult.count ?? 0,
        totalValue: (countResult.data ?? []).reduce(
          (sum, s) => sum + s.final_selling_price,
          0
        ),
      };
    },
  });

  // Fetch all matching sales' total value (separate query for summary)
  const { data: summary } = useQuery({
    queryKey: ["sales-summary", search, payStatus, fulfilStatus],
    queryFn: async () => {
      let q = supabase
        .from("sales")
        .select("final_selling_price, payment_status");

      if (payStatus !== "all") q = q.eq("payment_status", payStatus);
      if (fulfilStatus !== "all") q = q.eq("fulfilment_status", fulfilStatus);
      if (search.trim()) {
        const lower = search.toLowerCase();
        q = q.or(`sale_number.ilike.%${lower}%,product_name_snapshot.ilike.%${lower}%`);
      }

      const { data, error } = await q;
      if (error) throw error;
      const rows = data as Pick<Sale, "final_selling_price" | "payment_status">[];
      const totalValue = rows.reduce((s, r) => s + r.final_selling_price, 0);
      const outstanding = rows
        .filter((r) => r.payment_status === "pending" || r.payment_status === "partial")
        .reduce((s, r) => s + r.final_selling_price, 0);
      return { totalValue, outstanding, count: rows.length };
    },
  });

  const selectedSale = salesData?.sales.find((s) => s.id === selectedSaleId);

  const { data: payments } = useQuery({
    queryKey: ["sale-payments", selectedSaleId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("*")
        .eq("sale_id", selectedSaleId!)
        .order("payment_date", { ascending: false });
      if (error) throw error;
      return data as Payment[];
    },
    enabled: !!selectedSaleId,
  });

  const { data: outstanding } = useQuery({
    queryKey: ["sale-outstanding", selectedSaleId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("sale_outstanding", {
        p_sale_id: selectedSaleId!,
      });
      if (error) throw error;
      return data as number;
    },
    enabled: !!selectedSaleId,
  });

  const [addPayAmount, setAddPayAmount] = useState("");
  const [addPayMethod, setAddPayMethod] = useState("");
  const [addPayRef, setAddPayRef] = useState("");
  const [addPayDate, setAddPayDate] = useState(new Date().toISOString().slice(0, 10));

  const addPayment = useMutation({
    mutationFn: async () => {
      const amount = parseFloat(addPayAmount);
      if (!amount || amount <= 0) throw new Error("Enter a valid amount");
      const idempotencyKey = crypto.randomUUID();
      const { data, error } = await supabase.rpc("add_payment", {
        p_sale_id: selectedSaleId!,
        p_amount: amount,
        p_payment_method: addPayMethod || null,
        p_transaction_reference: addPayRef || null,
        p_payment_date: addPayDate,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sale-payments", selectedSaleId] });
      queryClient.invalidateQueries({ queryKey: ["sale-outstanding", selectedSaleId] });
      queryClient.invalidateQueries({ queryKey: ["sales"] });
      queryClient.invalidateQueries({ queryKey: ["customer-payments"] });
      setAddPayAmount("");
      setAddPayMethod("");
      setAddPayRef("");
      toast.success("Payment added");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const reversePayment = useMutation({
    mutationFn: async (paymentId: string) => {
      const { error } = await supabase.rpc("reverse_payment", {
        p_payment_id: paymentId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sale-payments", selectedSaleId] });
      queryClient.invalidateQueries({ queryKey: ["sale-outstanding", selectedSaleId] });
      queryClient.invalidateQueries({ queryKey: ["sales"] });
      queryClient.invalidateQueries({ queryKey: ["customer-payments"] });
      toast.success("Payment reversed");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateSaleStatus = useMutation({
    mutationFn: async (payload: { field: "fulfilment_status"; value: string }) => {
      const { error } = await supabase
        .from("sales")
        .update({ [payload.field]: payload.value, updated_by: profile?.id })
        .eq("id", selectedSaleId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sales"] });
      toast.success("Status updated");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const closePanel = () => {
    setSelectedSaleId(null);
    setSearchParams({});
  };

  const totalPaid =
    payments?.filter((p) => p.status === "valid").reduce((sum, p) => sum + p.amount, 0) ?? 0;

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === "asc" ? (
      <ArrowUp className="h-3 w-3" />
    ) : (
      <ArrowDown className="h-3 w-3" />
    );
  };

  const quickFilters = [
    { label: "Pending Payment", pay: "pending", fulfil: "all" },
    { label: "Activation Pending", pay: "all", fulfil: "activation_pending" },
    { label: "This Month", pay: "all", fulfil: "all" },
  ];

  const applyQuickFilter = (pay: string, fulfil: string) => {
    setPayStatus(pay);
    setFulfilStatus(fulfil);
    setPage(0);
  };

  const totalPages = Math.ceil((salesData?.total ?? 0) / PAGE_SIZE);

  return (
    <PageContainer>
      <div className="flex flex-col gap-4">
        <PageHeader title="Sales" description="Browse, search and manage all sales" />

        {/* Summary bar */}
        <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Total Sales:</span>
            <span className="text-sm font-semibold">{summary?.count ?? 0}</span>
          </div>
          <div className="flex items-center gap-2">
            <IndianRupee className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Total Value:</span>
            <span className="text-sm font-semibold">{formatMoney(summary?.totalValue ?? 0)}</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Outstanding:</span>
            <span className="text-sm font-semibold text-warning">{formatMoney(summary?.outstanding ?? 0)}</span>
          </div>
        </div>

        {/* Quick filter buttons */}
        <div className="flex flex-wrap gap-2">
          {quickFilters.map((filter) => {
            const active = payStatus === filter.pay && fulfilStatus === filter.fulfil;
            return (
              <Button
                key={filter.label}
                size="sm"
                variant={active ? "default" : "outline"}
                onClick={() => applyQuickFilter(filter.pay, filter.fulfil)}
              >
                {filter.label}
              </Button>
            );
          })}
          {(payStatus !== "all" || fulfilStatus !== "all") && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPayStatus("all");
                setFulfilStatus("all");
                setPage(0);
              }}
            >
              <X className="mr-1 h-3 w-3" /> Clear
            </Button>
          )}
        </div>

        {/* Search + dropdowns */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Search by sale #, customer, phone, product…"
              className="pl-9"
            />
          </div>
          <Select value={payStatus} onValueChange={(v) => { setPayStatus(v); setPage(0); }}>
            <SelectTrigger className="w-full lg:w-44"><SelectValue placeholder="Payment" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Payment</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="partial">Partial</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="refunded">Refunded</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Select value={fulfilStatus} onValueChange={(v) => { setFulfilStatus(v); setPage(0); }}>
            <SelectTrigger className="w-full lg:w-44"><SelectValue placeholder="Fulfilment" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Fulfilment</SelectItem>
              <SelectItem value="payment_confirmation">Payment Confirmation</SelectItem>
              <SelectItem value="activation_pending">Activation Pending</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
              <SelectItem value="activated">Activated</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : !salesData || salesData.sales.length === 0 ? (
          <EmptyState
            icon={<ShoppingCart className="h-5 w-5" />}
            title="No sales found"
            description="Create a new sale or adjust your filters."
          />
        ) : (
          <>
            {/* Desktop table */}
            <Card className="hidden lg:block">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th
                        className="cursor-pointer py-2 px-3 font-medium hover:text-foreground"
                        onClick={() => toggleSort("sale_number")}
                      >
                        <span className="flex items-center gap-1">Sale # <SortIcon field="sale_number" /></span>
                      </th>
                      <th
                        className="cursor-pointer py-2 px-3 font-medium hover:text-foreground"
                        onClick={() => toggleSort("sale_date")}
                      >
                        <span className="flex items-center gap-1">Date <SortIcon field="sale_date" /></span>
                      </th>
                      <th className="py-2 px-3 font-medium">Customer</th>
                      <th className="py-2 px-3 font-medium">Phone</th>
                      <th className="py-2 px-3 font-medium">Product</th>
                      <th className="py-2 px-3 font-medium">Cost</th>
                      <th
                        className="cursor-pointer py-2 px-3 font-medium hover:text-foreground"
                        onClick={() => toggleSort("final_selling_price")}
                      >
                        <span className="flex items-center gap-1">Selling <SortIcon field="final_selling_price" /></span>
                      </th>
                      <th className="py-2 px-3 font-medium">Payment</th>
                      <th className="py-2 px-3 font-medium">Fulfilment</th>
                      <th className="py-2 px-3 font-medium">Renewal</th>
                      <th className="py-2 px-3 font-medium">Added by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesData.sales.map((s) => (
                      <tr
                        key={s.id}
                        className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                        onClick={() => setSelectedSaleId(s.id)}
                      >
                        <td className="py-2 px-3 font-medium">{s.sale_number}</td>
                        <td className="py-2 px-3 text-muted-foreground">{formatDate(s.sale_date)}</td>
                        <td className="py-2 px-3">{s.customer?.name ?? "Unnamed"}</td>
                        <td className="py-2 px-3 text-muted-foreground">{s.customer?.phone_display ?? s.customer?.phone_normalized ?? "—"}</td>
                        <td className="py-2 px-3">{s.product_name_snapshot}<span className="text-muted-foreground"> · {s.plan_name_snapshot}</span></td>
                        <td className="py-2 px-3">{formatMoney(s.cost_price_snapshot)}</td>
                        <td className="py-2 px-3 font-medium">{formatMoney(s.final_selling_price)}</td>
                        <td className="py-2 px-3"><StatusBadge status={s.payment_status} /></td>
                        <td className="py-2 px-3"><StatusBadge status={s.fulfilment_status} /></td>
                        <td className="py-2 px-3 text-muted-foreground">{s.renewal_date ? formatDate(s.renewal_date) : "—"}</td>
                        <td className="py-2 px-3 text-muted-foreground">{s.created_by_profile?.full_name ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Mobile cards */}
            <div className="flex flex-col gap-2 lg:hidden">
              {salesData.sales.map((s) => (
                <Card key={s.id} className="cursor-pointer" onClick={() => setSelectedSaleId(s.id)}>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{s.sale_number}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(s.sale_date)}</span>
                    </div>
                    <p className="mt-1 text-sm">{s.customer?.name ?? "Unnamed"} — {s.customer?.phone_display ?? s.customer?.phone_normalized}</p>
                    <p className="text-xs text-muted-foreground">{s.product_name_snapshot} · {s.plan_name_snapshot}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="font-medium">{formatMoney(s.final_selling_price)}</span>
                      <div className="flex gap-1">
                        <StatusBadge status={s.payment_status} />
                        <StatusBadge status={s.fulfilment_status} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, salesData.total)} of {salesData.total}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                  >
                    <ChevronLeft className="h-4 w-4" /> Prev
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {page + 1} / {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Sale detail slide-over */}
      <Sheet open={!!selectedSaleId} onOpenChange={(open) => !open && closePanel()}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {selectedSale && (
            <>
              <SheetHeader>
                <div className="flex items-center justify-between">
                  <SheetTitle>Sale {selectedSale.sale_number}</SheetTitle>
                  <Button variant="ghost" size="icon" onClick={closePanel}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <SheetDescription>{formatDateTime(selectedSale.created_at)}</SheetDescription>
              </SheetHeader>

              <div className="mt-4 flex flex-col gap-4">
                {/* Customer */}
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground">Customer</p>
                  <p className="text-sm font-medium">{selectedSale.customer?.name ?? "Unnamed"}</p>
                  <p className="text-sm text-muted-foreground">{selectedSale.customer?.phone_display ?? selectedSale.customer?.phone_normalized}</p>
                </div>

                {/* Product */}
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium text-muted-foreground">Product</p>
                  <p className="text-sm font-medium">{selectedSale.product_name_snapshot}</p>
                  <p className="text-sm text-muted-foreground">{selectedSale.plan_name_snapshot} · {selectedSale.purchase_type_snapshot === "recurring" ? "Recurring" : "One-time"}</p>
                </div>

                {/* Prices */}
                <div className="grid grid-cols-2 gap-2 rounded-lg border p-3 text-sm">
                  <div><p className="text-xs text-muted-foreground">Selling Price</p><p className="font-medium">{formatMoney(selectedSale.final_selling_price)}</p></div>
                  <div><p className="text-xs text-muted-foreground">Product Cost</p><p>{formatMoney(selectedSale.cost_price_snapshot)}</p></div>
                  <div><p className="text-xs text-muted-foreground">Payment Fee</p><p>{formatMoney(selectedSale.payment_fee)}</p></div>
                  <div><p className="text-xs text-muted-foreground">List Price</p><p>{formatMoney(selectedSale.list_price_snapshot)}</p></div>
                  {selectedSale.refund_amount > 0 && <div><p className="text-xs text-muted-foreground">Refund</p><p>{formatMoney(selectedSale.refund_amount)}</p></div>}
                  {selectedSale.replacement_cost > 0 && <div><p className="text-xs text-muted-foreground">Replacement</p><p>{formatMoney(selectedSale.replacement_cost)}</p></div>}
                </div>

                {/* Payment summary */}
                <div className="rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground">Payment Summary</p>
                    <StatusBadge status={selectedSale.payment_status} />
                  </div>
                  <div className="mt-2 flex justify-between text-sm">
                    <span>Total: <span className="font-medium">{formatMoney(selectedSale.final_selling_price)}</span></span>
                    <span>Paid: <span className="font-medium text-success">{formatMoney(totalPaid)}</span></span>
                  </div>
                  {outstanding !== undefined && outstanding > 0 && (
                    <div className="mt-1 flex justify-between text-sm">
                      <span className="text-warning">Outstanding:</span>
                      <span className="font-medium text-warning">{formatMoney(outstanding)}</span>
                    </div>
                  )}
                </div>

                {/* Payments list */}
                {payments && payments.length > 0 && (
                  <div className="rounded-lg border p-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Payment Timeline</p>
                    <div className="flex flex-col gap-1.5">
                      {payments.map((p) => (
                        <div key={p.id} className="flex items-center justify-between text-sm">
                          <span className={p.status === "reversed" ? "text-muted-foreground line-through" : ""}>
                            {formatDate(p.payment_date)} · {p.payment_method ?? "—"}{p.status === "reversed" ? " · Reversed" : ""}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className={`font-medium ${p.status === "reversed" ? "text-muted-foreground line-through" : ""}`}>{formatMoney(p.amount)}</span>
                            {p.status === "valid" && isOwner && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10"
                                onClick={() => reversePayment.mutate(p.id)}
                                disabled={reversePayment.isPending}
                              >
                                <Undo2 className="mr-1 h-3 w-3" /> Reverse
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Add payment */}
                {selectedSale.payment_status !== "paid" && selectedSale.payment_status !== "cancelled" && selectedSale.payment_status !== "refunded" && selectedSale.payment_status !== "partially_refunded" && (
                  <div className="rounded-lg border p-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Add Payment</p>
                    <div className="flex flex-col gap-2">
                      <Input type="number" min={0} step="0.01" placeholder="Amount" value={addPayAmount} onChange={(e) => setAddPayAmount(e.target.value)} />
                      <Input type="date" value={addPayDate} onChange={(e) => setAddPayDate(e.target.value)} />
                      <Select value={addPayMethod} onValueChange={setAddPayMethod}>
                        <SelectTrigger><SelectValue placeholder="Method" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="UPI">UPI</SelectItem>
                          <SelectItem value="Bank Transfer">Bank Transfer</SelectItem>
                          <SelectItem value="Cash">Cash</SelectItem>
                          <SelectItem value="Card">Card</SelectItem>
                          <SelectItem value="Crypto">Crypto</SelectItem>
                          <SelectItem value="Other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input placeholder="Reference (optional)" value={addPayRef} onChange={(e) => setAddPayRef(e.target.value)} />
                      <Button size="sm" onClick={() => addPayment.mutate()} disabled={addPayment.isPending}>
                        <Plus className="mr-1 h-4 w-4" /> Add Payment
                      </Button>
                    </div>
                  </div>
                )}

                {/* Status update */}
                <div className="grid grid-cols-1 gap-2 rounded-lg border p-3">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Payment Status</Label>
                    <div className="flex h-8 items-center"><StatusBadge status={selectedSale.payment_status} /></div>
                    <p className="text-xs text-muted-foreground">Payment status is derived from collected payments and cannot be set manually.</p>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs">Fulfilment</Label>
                    <Select
                      value={selectedSale.fulfilment_status}
                      onValueChange={(v) => updateSaleStatus.mutate({ field: "fulfilment_status", value: v })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="payment_confirmation">Payment Confirmation</SelectItem>
                        <SelectItem value="activation_pending">Activation Pending</SelectItem>
                        <SelectItem value="processing">Processing</SelectItem>
                        <SelectItem value="activated">Activated</SelectItem>
                        <SelectItem value="replacement_required">Replacement Required</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="cancelled">Cancelled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Dates */}
                <div className="rounded-lg border p-3 text-sm">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Dates</p>
                  <div className="flex flex-col gap-1 text-muted-foreground">
                    <div className="flex justify-between"><span>Sale Date</span><span>{formatDate(selectedSale.sale_date)}</span></div>
                    {selectedSale.subscription_start_date && <div className="flex justify-between"><span>Subscription Start</span><span>{formatDate(selectedSale.subscription_start_date)}</span></div>}
                    {selectedSale.renewal_date && <div className="flex justify-between"><span>Renewal Date</span><span>{formatDate(selectedSale.renewal_date)}</span></div>}
                    {selectedSale.warranty_end_date && <div className="flex justify-between"><span>Warranty End</span><span>{formatDate(selectedSale.warranty_end_date)}</span></div>}
                  </div>
                </div>

                {/* Note */}
                {selectedSale.note && (
                  <div className="rounded-lg border p-3">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Note</p>
                    <p className="text-sm">{selectedSale.note}</p>
                  </div>
                )}

                {/* Created by */}
                <p className="text-xs text-muted-foreground">
                  Created by {selectedSale.created_by_profile?.full_name ?? "—"} on {formatDateTime(selectedSale.created_at)}
                </p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}
