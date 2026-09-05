import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { PageContainer, PageHeader, RetryableError } from "@/components/ui-shared";
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
import { addDateDays, currentIstDate, dateRangeStart, requireRpcObject } from "@/lib/data-safety";

type RangeKey = "7d" | "30d" | "90d" | "ytd" | "all";

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "ytd", label: "Year to date" },
  { key: "all", label: "All time" },
];

interface ReportStats {
  totalSales: number; revenue: number; productCost: number; paymentFees: number;
  refunds: number; replacementCosts: number; paymentsReceived: number;
  outstandingAmount: number; outstandingCount: number; grossProfit: number;
  expenses: number; netProfit: number; undatedLegacyRefunds: number;
  topProducts: { name: string; count: number; revenue: number }[];
}

const REPORT_NUMERIC_FIELDS = ["totalSales","revenue","productCost","paymentFees","refunds","replacementCosts","paymentsReceived","outstandingAmount","outstandingCount","grossProfit","expenses","netProfit","undatedLegacyRefunds"] as const;

export function FinancialReportsPage() {
  const [range, setRange] = useState<RangeKey>("30d");

  const startDate = dateRangeStart(range);
  const toExclusive = range === "all" ? null : addDateDays(currentIstDate(), 1);

  const { data: stats, isLoading, isError, refetch } = useQuery({
    queryKey: ["financial-reports", range],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("financial_report_summary", { p_from: startDate, p_to_exclusive: toExclusive });
      if (error) throw error;
      const result = requireRpcObject<ReportStats>(data, "Financial report", REPORT_NUMERIC_FIELDS);
      if (!Array.isArray(result.topProducts)) throw new Error("Financial report returned an unexpected response. Please retry.");
      return result;
    },
  });

  const cards = [
    {
      label: "Total Sales",
      value: stats ? String(stats.totalSales) : "—",
      icon: <ShoppingCart className="h-5 w-5" />,
      tone: "text-primary bg-primary/10",
    },
    {
      label: "Revenue",
      value: stats ? formatMoney(stats.revenue) : "—",
      icon: <IndianRupee className="h-5 w-5" />,
      tone: "text-primary bg-primary/10",
    },
    {
      label: "Payments Received",
      value: stats ? formatMoney(stats.paymentsReceived) : "—",
      icon: <CheckCircle2 className="h-5 w-5" />,
      tone: "text-success bg-success/10",
    },
    {
      label: "Outstanding",
      value: stats ? formatMoney(stats.outstandingAmount) : "—",
      icon: <Clock className="h-5 w-5" />,
      tone: "text-warning bg-warning/10",
    },
    {
      label: "Refunds",
      value: stats ? formatMoney(stats.refunds) : "—",
      icon: <RotateCcw className="h-5 w-5" />,
      tone: "text-destructive bg-destructive/10",
    },
    {
      label: "Product Cost",
      value: stats ? formatMoney(stats.productCost) : "—",
      icon: <Package className="h-5 w-5" />,
      tone: "text-info bg-info/10",
    },
    {
      label: "Gross Profit",
      value: stats ? formatMoney(stats.grossProfit) : "—",
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

        {isError && <RetryableError message="Financial report could not be loaded. Values are hidden until the request succeeds." onRetry={() => void refetch()} />}

        {stats && stats.undatedLegacyRefunds > 0 && (
          <p className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
            {formatMoney(stats.undatedLegacyRefunds)} of legacy refunds have no historical event date and are excluded from date-range refund totals.
          </p>
        )}

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
