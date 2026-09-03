import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { PageContainer, EmptyState, StatusBadge } from "@/components/ui-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ArrowLeft,
  Phone,
  Mail,
  PlusCircle,
  ShoppingCart,
  Clock,
  CreditCard,
  RefreshCw,
  MessageCircle,
  StickyNote,
} from "lucide-react";
import { formatMoney, formatDate, formatDateTime } from "@/lib/format";
import type { Customer, Sale, Payment, Subscription, Renewal } from "@/lib/types";

export function CustomerProfilePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: customer, isLoading } = useQuery({
    queryKey: ["customer", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as Customer | null;
    },
    enabled: !!id,
  });

  const { data: sales } = useQuery({
    queryKey: ["customer-sales", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("*")
        .eq("customer_id", id!)
        .order("sale_date", { ascending: false });
      if (error) throw error;
      return data as Sale[];
    },
    enabled: !!id,
  });

  const { data: payments, isLoading: paymentsLoading } = useQuery({
    queryKey: ["customer-payments", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("*, sale:sales(*)")
        .eq("sale.customer_id", id!)
        .order("payment_date", { ascending: false });
      if (error) throw error;
      return data as (Payment & { sale: Sale | null })[];
    },
    enabled: !!id,
  });

  const { data: subscriptions } = useQuery({
    queryKey: ["customer-subscriptions", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("customer_id", id!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Subscription[];
    },
    enabled: !!id,
  });

  const { data: renewals } = useQuery({
    queryKey: ["customer-renewals", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("renewals")
        .select("*")
        .eq("customer_id", id!)
        .order("due_date", { ascending: false });
      if (error) throw error;
      return data as Renewal[];
    },
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <PageContainer>
        <Skeleton className="h-32" />
        <div className="mt-4 space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      </PageContainer>
    );
  }

  if (!customer) {
    return (
      <PageContainer>
        <EmptyState title="Customer not found" description="This customer may have been removed." />
      </PageContainer>
    );
  }

  // Financial metrics
  const validSales = sales?.filter((s) => s.payment_status !== "cancelled" && s.payment_status !== "refunded") ?? [];
  const totalOrderValue = validSales.reduce((sum, s) => sum + s.final_selling_price, 0);
  const validPayments = payments?.filter((p) => p.status === "valid") ?? [];
  const amountPaid = validPayments.reduce((sum, p) => sum + p.amount, 0);
  const refunded = sales?.reduce((sum, s) => sum + s.refund_amount, 0) ?? 0;
  const netCollected = amountPaid - refunded;

  const outstanding = (sales ?? [])
    .filter((s) => s.payment_status === "pending" || s.payment_status === "partial")
    .reduce((sum, s) => {
      const paidForSale = validPayments
        .filter((p) => p.sale_id === s.id)
        .reduce((sum, p) => sum + p.amount, 0);
      const balance = s.final_selling_price - paidForSale - s.refund_amount;
      return sum + Math.max(0, balance);
    }, 0);

  const lastPurchase = sales?.[0];

  const saleById = new Map((sales ?? []).map((s) => [s.id, s]));
  const activeSubs = (subscriptions ?? []).filter((sub) => {
    if (sub.status !== "active") return false;
    const sale = sub.original_sale_id ? saleById.get(sub.original_sale_id) : null;
    if (!sale) return false;
    return sale.fulfilment_status === "activated" || sale.fulfilment_status === "completed";
  });

  const whatsappNumber = customer.phone_normalized.replace(/^91/, "");

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        {/* Breadcrumb + header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/customers")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-semibold tracking-tight">
            {customer.name ?? "Unnamed Customer"}
          </h1>
        </div>

        {/* Contact info card with quick actions */}
        <Card>
          <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary">
                {(customer.name ?? "?")[0]?.toUpperCase()}
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <p className="text-lg font-medium">{customer.name ?? "Unnamed"}</p>
                  <StatusBadge status={customer.customer_type} />
                </div>
                <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> {customer.phone_display ?? customer.phone_normalized}</span>
                  {customer.email && <span className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> {customer.email}</span>}
                  <span>Source: {customer.acquisition_source ?? "—"}</span>
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:items-end">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => navigate(`/sales/new?customer=${customer.id}`)}>
                  <PlusCircle className="mr-1.5 h-4 w-4" /> New Sale
                </Button>
                <Button size="sm" variant="outline" onClick={() => navigate(`/sales?pay=pending`)}>
                  <CreditCard className="mr-1.5 h-4 w-4" /> Add Payment
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate("/renewals")}
                >
                  <RefreshCw className="mr-1.5 h-4 w-4" /> Renewal Reminder
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  asChild
                >
                  <a
                    href={`https://wa.me/${whatsappNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <MessageCircle className="mr-1.5 h-4 w-4" /> WhatsApp
                  </a>
                </Button>
              </div>
              {customer.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {customer.tags.map((t) => (
                    <span key={t} className="rounded-md bg-muted px-2 py-0.5 text-xs">{t}</span>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Financial stats */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Total Order Value</p>
              <p className="text-lg font-semibold">{formatMoney(totalOrderValue)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Amount Paid</p>
              <p className="text-lg font-semibold text-success">{formatMoney(amountPaid)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Outstanding</p>
              <p className={`text-lg font-semibold ${outstanding > 0 ? "text-warning" : ""}`}>{formatMoney(outstanding)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Net Collected</p>
              <p className="text-lg font-semibold">{formatMoney(netCollected)}</p>
            </CardContent>
          </Card>
        </div>

        {/* Tabbed 360-degree view */}
        <Tabs defaultValue="overview">
          <TabsList className="flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="purchases">Purchases</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="renewals">Renewals</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
          </TabsList>

          {/* Overview tab */}
          <TabsContent value="overview">
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Total Sales</p>
                    <p className="text-lg font-semibold">{sales?.length ?? 0}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Active Subscriptions</p>
                    <p className="text-lg font-semibold">{activeSubs.length}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Last Purchase</p>
                    <p className="text-lg font-semibold">{lastPurchase ? formatDate(lastPurchase.sale_date) : "—"}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Customer Since</p>
                    <p className="text-lg font-semibold">{formatDate(customer.created_at)}</p>
                  </CardContent>
                </Card>
              </div>

              {/* Active subscriptions */}
              {activeSubs.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Clock className="h-4 w-4" /> Active Subscriptions
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="flex flex-col gap-2">
                      {activeSubs.map((sub) => {
                        const sale = sub.original_sale_id ? saleById.get(sub.original_sale_id) : null;
                        return (
                          <div key={sub.id} className="flex items-center justify-between rounded-lg border p-3">
                            <div>
                              <p className="text-sm font-medium">Started {formatDate(sub.start_date)}</p>
                              <p className="text-xs text-muted-foreground">
                                Ends {sub.end_date ? formatDate(sub.end_date) : "—"}
                                {sub.next_renewal_date ? ` · Renewal: ${formatDate(sub.next_renewal_date)}` : ""}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {sale && <StatusBadge status={sale.payment_status} />}
                              <StatusBadge status={sub.status} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Recent activity (last 5 sales) */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShoppingCart className="h-4 w-4" /> Recent Activity
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {sales && sales.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {sales.slice(0, 5).map((s) => (
                        <div
                          key={s.id}
                          className="flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 hover:bg-muted/40"
                          onClick={() => navigate(`/sales?id=${s.id}`)}
                        >
                          <div>
                            <p className="text-sm font-medium">{s.sale_number}</p>
                            <p className="text-xs text-muted-foreground">{s.product_name_snapshot} · {formatDate(s.sale_date)}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{formatMoney(s.final_selling_price)}</span>
                            <StatusBadge status={s.payment_status} />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="py-6 text-center text-sm text-muted-foreground">No activity yet.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Purchases tab */}
          <TabsContent value="purchases">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShoppingCart className="h-4 w-4" /> Purchase History
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {sales && sales.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-3 font-medium">Sale #</th>
                          <th className="py-2 pr-3 font-medium">Date</th>
                          <th className="py-2 pr-3 font-medium">Product</th>
                          <th className="py-2 pr-3 font-medium">Amount</th>
                          <th className="py-2 pr-3 font-medium">Payment</th>
                          <th className="py-2 font-medium">Fulfilment</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sales.map((s) => (
                          <tr
                            key={s.id}
                            className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                            onClick={() => navigate(`/sales?id=${s.id}`)}
                          >
                            <td className="py-2 pr-3 font-medium">{s.sale_number}</td>
                            <td className="py-2 pr-3 text-muted-foreground">{formatDate(s.sale_date)}</td>
                            <td className="py-2 pr-3">{s.product_name_snapshot} · {s.plan_name_snapshot}</td>
                            <td className="py-2 pr-3">{formatMoney(s.final_selling_price)}</td>
                            <td className="py-2 pr-3"><StatusBadge status={s.payment_status} /></td>
                            <td className="py-2"><StatusBadge status={s.fulfilment_status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">No purchases yet.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Payments tab */}
          <TabsContent value="payments">
            <div key={`payments-${id}`}>
              {paymentsLoading ? (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Payments</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-8 w-full" />
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : payments && payments.length > 0 ? (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <CreditCard className="h-4 w-4" /> Payment History
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-xs text-muted-foreground">
                            <th className="py-2 pr-3 font-medium">Date</th>
                            <th className="py-2 pr-3 font-medium">Amount</th>
                            <th className="py-2 pr-3 font-medium">Method</th>
                            <th className="py-2 pr-3 font-medium">Reference</th>
                            <th className="py-2 font-medium">Sale</th>
                          </tr>
                        </thead>
                        <tbody>
                          {payments.map((p) => (
                            <tr key={p.id} className="border-b last:border-0">
                              <td className="py-2 pr-3">{formatDate(p.payment_date)}</td>
                              <td className={`py-2 pr-3 font-medium ${p.status === "reversed" ? "text-muted-foreground line-through" : ""}`}>
                                {formatMoney(p.amount)}
                              </td>
                              <td className="py-2 pr-3 text-muted-foreground">{p.payment_method ?? "—"}</td>
                              <td className="py-2 pr-3 text-muted-foreground">{p.transaction_reference ?? "—"}</td>
                              <td className="py-2 text-muted-foreground">{p.sale?.sale_number ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <EmptyState icon={<CreditCard className="h-5 w-5" />} title="No payments" description="Payments will appear here once recorded." />
              )}
            </div>
          </TabsContent>

          {/* Renewals tab */}
          <TabsContent value="renewals">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <RefreshCw className="h-4 w-4" /> Renewal History
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {renewals && renewals.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {renewals.map((r) => (
                      <div key={r.id} className="flex items-center justify-between rounded-lg border p-3">
                        <div>
                          <p className="text-sm font-medium">Due {formatDate(r.due_date)}</p>
                          {r.note && <p className="text-xs text-muted-foreground">{r.note}</p>}
                          {r.reminded_at && <p className="text-xs text-muted-foreground">Reminded: {formatDateTime(r.reminded_at)}</p>}
                        </div>
                        <StatusBadge status={r.status} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">No renewals yet.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Notes tab */}
          <TabsContent value="notes">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <StickyNote className="h-4 w-4" /> Internal Notes
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {customer.internal_note ? (
                  <div className="rounded-lg border p-4">
                    <p className="text-sm text-muted-foreground">{customer.internal_note}</p>
                  </div>
                ) : (
                  <EmptyState
                    icon={<StickyNote className="h-5 w-5" />}
                    title="No internal notes"
                    description="Notes added to this customer will appear here."
                  />
                )}
                <div className="mt-4 flex flex-col gap-2 text-sm text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Created</span>
                    <span>{formatDateTime(customer.created_at)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Last Updated</span>
                    <span>{formatDateTime(customer.updated_at)}</span>
                  </div>
                  {customer.do_not_message && (
                    <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                      Do Not Message flag is set
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </PageContainer>
  );
}
