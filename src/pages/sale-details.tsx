import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { PageContainer, EmptyState, StatusBadge } from "@/components/ui-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  ArrowLeft,
  User,
  Package,
  CreditCard,
  Plus,
  Undo2,
  Printer,
  Calendar,
  RefreshCw,
  StickyNote,
} from "lucide-react";
import { formatMoney, formatDate, formatDateTime } from "@/lib/format";
import type { Sale, Payment, Subscription, Renewal, Customer, Profile } from "@/lib/types";

interface SaleDetail extends Sale {
  customer: Customer | null;
  created_by_profile: Profile | null;
}

interface FinancialDetail {
  total_price: number;
  total_paid: number;
  refund_amount: number;
  outstanding: number;
  net_collected: number;
  cost_price: number;
  payment_fee: number;
  gross_profit: number;
  margin_pct: number;
}

export function SaleDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isOwner } = useAuth();
  const queryClient = useQueryClient();

  const { data: sale, isLoading } = useQuery({
    queryKey: ["sale-detail", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("*, customer:customers(*), created_by_profile:profiles!sales_created_by_fkey(*)")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as SaleDetail | null;
    },
    enabled: !!id,
  });

  const { data: financial } = useQuery({
    queryKey: ["sale-financial-detail", id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("sale_financial_detail", {
        p_sale_id: id!,
      });
      if (error) throw error;
      return data as FinancialDetail;
    },
    enabled: !!id,
  });

  const { data: payments } = useQuery({
    queryKey: ["sale-payments", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("*")
        .eq("sale_id", id!)
        .order("payment_date", { ascending: false });
      if (error) throw error;
      return data as Payment[];
    },
    enabled: !!id,
  });

  const { data: subscription } = useQuery({
    queryKey: ["sale-subscription", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("current_sale_id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as Subscription | null;
    },
    enabled: !!id && sale?.purchase_type_snapshot === "recurring",
  });

  const { data: renewal } = useQuery({
    queryKey: ["sale-renewal", id],
    queryFn: async () => {
      if (!subscription) return null;
      const { data, error } = await supabase
        .from("renewals")
        .select("*")
        .eq("subscription_id", subscription.id)
        .order("due_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Renewal | null;
    },
    enabled: !!id && !!subscription,
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
      const { error } = await supabase.rpc("add_payment", {
        p_sale_id: id!,
        p_amount: amount,
        p_payment_method: addPayMethod || null,
        p_transaction_reference: addPayRef || null,
        p_payment_date: addPayDate,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sale-payments", id] });
      queryClient.invalidateQueries({ queryKey: ["sale-financial-detail", id] });
      queryClient.invalidateQueries({ queryKey: ["sales"] });
      queryClient.invalidateQueries({ queryKey: ["sales-financial-summary"] });
      setAddPayAmount("");
      setAddPayMethod("");
      setAddPayRef("");
    },
  });

  const reversePayment = useMutation({
    mutationFn: async (paymentId: string) => {
      const { error } = await supabase.rpc("reverse_payment", { p_payment_id: paymentId });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sale-payments", id] });
      queryClient.invalidateQueries({ queryKey: ["sale-financial-detail", id] });
      queryClient.invalidateQueries({ queryKey: ["sales"] });
    },
  });

  const updateFulfilment = useMutation({
    mutationFn: async (status: string) => {
      const { error } = await supabase
        .from("sales")
        .update({ fulfilment_status: status })
        .eq("id", id!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sale-detail", id] });
    },
  });

  if (isLoading) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-48" />
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </PageContainer>
    );
  }

  if (!sale) {
    return (
      <PageContainer>
        <EmptyState title="Sale not found" description="This sale may have been removed." />
      </PageContainer>
    );
  }

  const canAddPayment =
    sale.payment_status !== "paid" &&
    sale.payment_status !== "cancelled" &&
    sale.payment_status !== "refunded" &&
    sale.payment_status !== "partially_refunded";

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/sales")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{sale.sale_number}</h1>
              <p className="text-sm text-muted-foreground">{formatDateTime(sale.created_at)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-1.5 h-4 w-4" /> Print
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Left column: Customer + Product */}
          <div className="flex flex-col gap-4">
            {/* Customer card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <User className="h-4 w-4" /> Customer
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {sale.customer && (
                  <div
                    className="cursor-pointer rounded-lg border p-3 hover:bg-muted/40"
                    onClick={() => navigate(`/customers/${sale.customer!.id}`)}
                  >
                    <p className="font-medium">{sale.customer.name ?? "Unnamed"}</p>
                    <p className="text-sm text-muted-foreground">{sale.customer.phone_display ?? sale.customer.phone_normalized}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <StatusBadge status={sale.customer.customer_type} />
                      {sale.customer.email && <span className="text-xs text-muted-foreground">{sale.customer.email}</span>}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Product card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Package className="h-4 w-4" /> Product
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="rounded-lg border p-3">
                  <p className="font-medium">{sale.product_name_snapshot}</p>
                  <p className="text-sm text-muted-foreground">{sale.plan_name_snapshot}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {sale.purchase_type_snapshot === "recurring" ? "Recurring" : "One-time"}
                    {sale.duration_days_snapshot ? ` · ${sale.duration_days_snapshot} days` : ""}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Dates card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Calendar className="h-4 w-4" /> Dates
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-col gap-1 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Sale Date</span><span>{formatDate(sale.sale_date)}</span></div>
                  {sale.subscription_start_date && <div className="flex justify-between"><span className="text-muted-foreground">Subscription Start</span><span>{formatDate(sale.subscription_start_date)}</span></div>}
                  {sale.renewal_date && <div className="flex justify-between"><span className="text-muted-foreground">Renewal Date</span><span>{formatDate(sale.renewal_date)}</span></div>}
                  {sale.warranty_end_date && <div className="flex justify-between"><span className="text-muted-foreground">Warranty End</span><span>{formatDate(sale.warranty_end_date)}</span></div>}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Middle column: Financial breakdown + Payments */}
          <div className="flex flex-col gap-4">
            {/* Financial breakdown */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CreditCard className="h-4 w-4" /> Financial Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-col gap-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Selling Price</span><span className="font-medium">{formatMoney(financial?.total_price ?? sale.final_selling_price)}</span></div>
                  {sale.list_price_snapshot != null && <div className="flex justify-between"><span className="text-muted-foreground">List Price</span><span>{formatMoney(sale.list_price_snapshot)}</span></div>}
                  <div className="flex justify-between"><span className="text-muted-foreground">Paid</span><span className="font-medium text-success">{formatMoney(financial?.total_paid ?? 0)}</span></div>
                  {(financial?.refund_amount ?? sale.refund_amount) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Refunded</span><span className="font-medium text-destructive">{formatMoney(financial?.refund_amount ?? sale.refund_amount)}</span></div>}
                  {(financial?.outstanding ?? 0) > 0 && <div className="flex justify-between border-t pt-1"><span className="font-medium text-warning">Outstanding</span><span className="font-semibold text-warning">{formatMoney(financial?.outstanding ?? 0)}</span></div>}
                  <div className="flex justify-between"><span className="text-muted-foreground">Net Collected</span><span className="font-medium">{formatMoney(financial?.net_collected ?? 0)}</span></div>
                </div>

                {isOwner && financial && (
                  <div className="mt-3 border-t pt-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Profit Analysis (Owner Only)</p>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><p className="text-xs text-muted-foreground">Cost</p><p>{formatMoney(financial.cost_price)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Payment Fee</p><p>{formatMoney(financial.payment_fee)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Gross Profit</p><p className="font-medium text-success">{formatMoney(financial.gross_profit)}</p></div>
                      <div><p className="text-xs text-muted-foreground">Margin</p><p className="font-medium">{financial.margin_pct}%</p></div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Payment timeline */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CreditCard className="h-4 w-4" /> Payment Timeline
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {payments && payments.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {payments.map((p) => (
                      <div key={p.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                        <div>
                          <p className={p.status === "reversed" ? "text-muted-foreground line-through" : ""}>
                            {formatDate(p.payment_date)} · {p.payment_method ?? "—"}
                          </p>
                          {p.transaction_reference && <p className="text-xs text-muted-foreground">Ref: {p.transaction_reference}</p>}
                          {p.status === "reversed" && <p className="text-xs text-destructive">Reversed</p>}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`font-medium ${p.status === "reversed" ? "text-muted-foreground line-through" : ""}`}>{formatMoney(p.amount)}</span>
                          {p.status === "valid" && isOwner && (
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-destructive" onClick={() => reversePayment.mutate(p.id)} disabled={reversePayment.isPending}>
                              <Undo2 className="mr-1 h-3 w-3" /> Reverse
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-4 text-center text-sm text-muted-foreground">No payments recorded yet.</p>
                )}

                {/* Add payment */}
                {canAddPayment && (
                  <div className="mt-3 border-t pt-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Add Payment</p>
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2">
                        <Input type="number" min={0} step="0.01" placeholder="Amount" value={addPayAmount} onChange={(e) => setAddPayAmount(e.target.value)} />
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          onClick={() => setAddPayAmount(String(financial?.outstanding ?? sale.final_selling_price))}
                        >
                          Full
                        </Button>
                      </div>
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
              </CardContent>
            </Card>
          </div>

          {/* Right column: Status + Subscription + Notes */}
          <div className="flex flex-col gap-4">
            {/* Status card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Status</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-col gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">Payment Status</Label>
                    <div className="mt-1 flex h-8 items-center"><StatusBadge status={sale.payment_status} /></div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Fulfilment Status</Label>
                    <Select
                      value={sale.fulfilment_status}
                      onValueChange={(v) => updateFulfilment.mutate(v)}
                    >
                      <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
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
              </CardContent>
            </Card>

            {/* Subscription & Renewal */}
            {sale.purchase_type_snapshot === "recurring" && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <RefreshCw className="h-4 w-4" /> Subscription
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {subscription ? (
                    <div className="flex flex-col gap-2 text-sm">
                      <div className="flex justify-between"><span className="text-muted-foreground">Status</span><StatusBadge status={subscription.status} /></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Start</span><span>{formatDate(subscription.start_date)}</span></div>
                      {subscription.end_date && <div className="flex justify-between"><span className="text-muted-foreground">End</span><span>{formatDate(subscription.end_date)}</span></div>}
                      {subscription.next_renewal_date && <div className="flex justify-between"><span className="text-muted-foreground">Next Renewal</span><span>{formatDate(subscription.next_renewal_date)}</span></div>}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No subscription record.</p>
                  )}
                  {renewal && (
                    <div className="mt-3 border-t pt-3">
                      <p className="mb-1 text-xs font-medium text-muted-foreground">Latest Renewal</p>
                      <div className="flex flex-col gap-1 text-sm">
                        <div className="flex justify-between"><span className="text-muted-foreground">Due Date</span><span>{formatDate(renewal.due_date)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Status</span><StatusBadge status={renewal.status} /></div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Notes */}
            {sale.note && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <StickyNote className="h-4 w-4" /> Note
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="text-sm text-muted-foreground">{sale.note}</p>
                </CardContent>
              </Card>
            )}

            {/* Audit */}
            <Card>
              <CardContent className="p-4">
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <p>Created by {sale.created_by_profile?.full_name ?? "—"}</p>
                  <p>Created: {formatDateTime(sale.created_at)}</p>
                  <p>Updated: {formatDateTime(sale.updated_at)}</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
