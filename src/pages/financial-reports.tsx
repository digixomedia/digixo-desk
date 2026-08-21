import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { PageContainer, PageHeader } from "@/components/ui-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IndianRupee,
  CheckCircle2,
  Clock,
  Package,
  TrendingUp,
  ShoppingCart,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import { formatMoney } from "@/lib/format";
import type { Sale, Payment } from "@/lib/types";

type RangeKey = "7d" | "30d" | "90d" | "ytd" | "all";

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "ytd", label: "Year to date" },
  { key: "all", label: "All time" },
];

function getStartDate(range: RangeKey): string | null {
  if (range === "all") return null;
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "7d") d.setDate(d.getDate() - 7);
  else if (range === "30d") d.setDate(d.getDate() - 30);
  else if (range === "90d") d.setDate(d.getDate() - 90);
  else if (range === "ytd") {
    d.setMonth(0);
    d.setDate(1);
  }
  return d.toISOString().slice(0, 10);
}

type SaleWithCustomer = Sale & { customer: { name: string | null; phone_display: string | null } | null };

export function FinancialReportsPage() {
  const [range, setRange] = useState<RangeKey>("30d");

  const startDate = getStartDate(range);

  const { data: stats, isLoading } = useQuery({
    queryKey: ["financial-reports", range],
    queryFn: async () => {
      let saleQuery = supabase
        .from("sales")
        .select("*, customer:customers(name, phone_display)")
        .order("sale_date", { ascending: false });

      if (startDate) saleQuery = saleQuery.gte("sale_date", startDate);

      const { data: sales, error: saleError } = await saleQuery;
      if (saleError) throw saleError;

      const salesData = (sales ?? []) as SaleWithCustomer[];
      const saleIds = salesData.map((s) => s.id);

      let paymentsData: Payment[] = [];
      if (saleIds.length > 0) {
        let payQuery = supabase
          .from("payments")
          .select("*")
          .in("sale_id", saleIds)
          .eq("status", "valid");

        if (startDate) payQuery = payQuery.gte("payment_date", startDate);

        const { data: payments, error: payError } = await payQuery;
        if (payError) throw payError;
        paymentsData = (payments ?? []) as Payment[];
      }

      const nonCancelledSales = salesData.filter((s) => s.payment_status !== "cancelled");
      const totalSales = nonCancelledSales.length;
      const revenue = nonCancelledSales.reduce((sum, s) => sum + s.final_selling_price, 0);
      const productCost = nonCancelledSales.reduce((sum, s) => sum + s.cost_price_snapshot, 0);
      const paymentFees = nonCancelledSales.reduce((sum, s) => sum + s.payment_fee, 0);
      const refunds = nonCancelledSales.reduce((sum, s) => sum + s.refund_amount, 0);
      const replacementCosts = nonCancelledSales.reduce((sum, s) => sum + s.replacement_cost, 0);
      const paymentsReceived = paymentsData.reduce((sum, p) => sum + p.amount, 0);

      const outstandingSales = nonCancelledSales.filter(
        (s) => s.payment_status === "pending" || s.payment_status === "partial",
      );
      const outstandingAmount = outstandingSales.reduce((sum, s) => {
        const paidForSale = paymentsData
          .filter((p) => p.sale_id === s.id)
          .reduce((sum, p) => sum + p.amount, 0);
        return sum + Math.max(0, s.final_selling_price - paidForSale);
      }, 0);

      const grossProfit = revenue - productCost - paymentFees - refunds - replacementCosts;

      const topProducts = new Map<string, { count: number; revenue: number }>();
      for (const s of nonCancelledSales) {
        const key = `${s.product_name_snapshot} · ${s.plan_name_snapshot}`;
        const existing = topProducts.get(key) ?? { count: 0, revenue: 0 };
        existing.count += 1;
        existing.revenue += s.final_selling_price;
        topProducts.set(key, existing);
      }
      const topProductsList = Array.from(topProducts.entries())
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);

      return {
        totalSales,
        revenue,
        productCost,
        paymentFees,
        refunds,
        replacementCosts,
        paymentsReceived,
        outstandingAmount,
        outstandingCount: outstandingSales.length,
        grossProfit,
        topProducts: topProductsList,
      };
    },
  });

  const cards = [
    {
      label: "Total Sales",
      value: String(stats?.totalSales ?? 0),
      icon: <ShoppingCart className="h-5 w-5" />,
      tone: "text-primary bg-primary/10",
    },
    {
      label: "Revenue",
      value: formatMoney(stats?.revenue ?? 0),
      icon: <IndianRupee className="h-5 w-5" />,
      tone: "text-primary bg-primary/10",
    },
    {
      label: "Payments Received",
      value: formatMoney(stats?.paymentsReceived ?? 0),
      icon: <CheckCircle2 className="h-5 w-5" />,
      tone: "text-success bg-success/10",
    },
    {
      label: "Outstanding",
      value: formatMoney(stats?.outstandingAmount ?? 0),
      icon: <Clock className="h-5 w-5" />,
      tone: "text-warning bg-warning/10",
    },
    {
      label: "Refunds",
      value: formatMoney(stats?.refunds ?? 0),
      icon: <RotateCcw className="h-5 w-5" />,
      tone: "text-destructive bg-destructive/10",
    },
    {
      label: "Product Cost",
      value: formatMoney(stats?.productCost ?? 0),
      icon: <Package className="h-5 w-5" />,
      tone: "text-info bg-info/10",
    },
    {
      label: "Gross Profit",
      value: formatMoney(stats?.grossProfit ?? 0),
      icon: <TrendingUp className="h-5 w-5" />,
      tone: "text-success bg-success/10",
    },
  ];

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Financial Reports"
          description="Revenue, costs, and profit across your sales"
          actions={
            <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.key} value={opt.key}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        {/* Stat cards */}
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
            {Array.from({ length: 7 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <Skeleton className="mt-2 h-4 w-20" />
                  <Skeleton className="mt-1 h-6 w-16" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
            {cards.map((card) => (
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
        )}

        {/* Outstanding alert */}
        {stats && stats.outstandingCount > 0 && (
          <Card className="border-warning/30">
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium">
                  {stats.outstandingCount} sale{stats.outstandingCount === 1 ? "" : "s"} with outstanding payments
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatMoney(stats.outstandingAmount)} still to be collected
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Top products */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top Products by Revenue</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : !stats?.topProducts || stats.topProducts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No sales in this period.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Product</th>
                      <th className="py-2 pr-3 font-medium text-right">Sales</th>
                      <th className="py-2 pr-3 font-medium text-right">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.topProducts.map((p) => (
                      <tr key={p.name} className="border-b last:border-0">
                        <td className="py-2 pr-3 font-medium">{p.name}</td>
                        <td className="py-2 pr-3 text-right text-muted-foreground">{p.count}</td>
                        <td className="py-2 pr-3 text-right font-medium">{formatMoney(p.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
