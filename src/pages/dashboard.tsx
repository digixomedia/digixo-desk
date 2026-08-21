import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { PageContainer, PageHeader } from "@/components/ui-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-shared";
import {
  PlusCircle,
  ShoppingCart,
  Users,
  Package,
  IndianRupee,
  TrendingUp,
  Clock,
  AlertTriangle,
  CalendarClock,
  UserPlus,
  CheckCircle2,
} from "lucide-react";
import { formatMoney } from "@/lib/format";
import type { OwnerDashboardStats, ManagerDashboardStats, Sale, Customer } from "@/lib/types";
import { StatusBadge } from "@/components/ui-shared";
import { formatDate } from "@/lib/format";

function StatCard({
  label,
  value,
  icon,
  tone = "default",
  loading,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "info" | "primary";
  loading?: boolean;
}) {
  const toneClass = {
    default: "text-muted-foreground bg-muted/50",
    success: "text-success bg-success/10",
    warning: "text-warning bg-warning/10",
    danger: "text-destructive bg-destructive/10",
    info: "text-info bg-info/10",
    primary: "text-primary bg-primary/10",
  }[tone];

  return (
    <Card className="overflow-hidden">
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${toneClass}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="mt-1 h-5 w-20" />
          ) : (
            <p className="text-lg font-semibold tracking-tight">{value}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function QuickActions() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="default" onClick={() => navigate("/sales/new")}>
        <PlusCircle className="mr-1.5 h-4 w-4" /> New Sale
      </Button>
      <Button size="sm" variant="outline" onClick={() => navigate("/customers")}>
        <UserPlus className="mr-1.5 h-4 w-4" /> Add Customer
      </Button>
      <Button size="sm" variant="outline" onClick={() => navigate("/sales")}>
        <ShoppingCart className="mr-1.5 h-4 w-4" /> View Sales
      </Button>
      <Button size="sm" variant="outline" onClick={() => navigate("/products")}>
        <Package className="mr-1.5 h-4 w-4" /> View Products
      </Button>
    </div>
  );
}

function RecentSalesTable({ sales }: { sales: Sale[] }) {
  const navigate = useNavigate();

  if (sales.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingCart className="h-5 w-5" />}
        title="No sales yet"
        description="Create your first sale to see it here."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Sale #</th>
            <th className="py-2 pr-3 font-medium">Date</th>
            <th className="py-2 pr-3 font-medium">Customer</th>
            <th className="py-2 pr-3 font-medium">Product</th>
            <th className="py-2 pr-3 font-medium">Amount</th>
            <th className="py-2 pr-3 font-medium">Payment</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((sale) => (
            <tr
              key={sale.id}
              className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
              onClick={() => navigate(`/sales?id=${sale.id}`)}
            >
              <td className="py-2 pr-3 font-medium">{sale.sale_number}</td>
              <td className="py-2 pr-3 text-muted-foreground">{formatDate(sale.sale_date)}</td>
              <td className="py-2 pr-3">{sale.customer?.name ?? sale.customer?.phone_display ?? "—"}</td>
              <td className="py-2 pr-3">
                {sale.product_name_snapshot}
                <span className="text-muted-foreground"> · {sale.plan_name_snapshot}</span>
              </td>
              <td className="py-2 pr-3 font-medium">{formatMoney(sale.final_selling_price)}</td>
              <td className="py-2 pr-3">
                <StatusBadge status={sale.payment_status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPage() {
  const { isOwner, profile } = useAuth();
  const navigate = useNavigate();

  const { data: ownerStats, isLoading: ownerLoading } = useQuery({
    queryKey: ["owner-dashboard"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("owner_dashboard_stats");
      if (error) throw error;
      return data as OwnerDashboardStats;
    },
    enabled: isOwner,
  });

  const { data: managerStats, isLoading: managerLoading } = useQuery({
    queryKey: ["manager-dashboard"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("manager_dashboard_stats");
      if (error) throw error;
      return data as ManagerDashboardStats;
    },
    enabled: !isOwner,
  });

  const { data: recentSales } = useQuery({
    queryKey: ["dashboard-recent-sales"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales")
        .select("*, customer:customers(*), created_by_profile:profiles!sales_created_by_fkey(*)")
        .order("created_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return data as Sale[];
    },
  });

  const { data: recentCustomers } = useQuery({
    queryKey: ["dashboard-recent-customers"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return data as Customer[];
    },
  });

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title={`Welcome, ${profile?.full_name ?? "User"}`}
          description={isOwner ? "Owner dashboard — full business overview" : "Manager dashboard — today's operations"}
          actions={<QuickActions />}
        />

        {isOwner ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Revenue (Month)" value={formatMoney(ownerStats?.revenue_this_month ?? 0)} icon={<IndianRupee className="h-5 w-5" />} tone="primary" loading={ownerLoading} />
            <StatCard label="Cash Received (Month)" value={formatMoney(ownerStats?.cash_received_this_month ?? 0)} icon={<CheckCircle2 className="h-5 w-5" />} tone="success" loading={ownerLoading} />
            <StatCard label="Product Cost (Month)" value={formatMoney(ownerStats?.product_cost_this_month ?? 0)} icon={<Package className="h-5 w-5" />} tone="info" loading={ownerLoading} />
            <StatCard label="Gross Profit (Month)" value={formatMoney(ownerStats?.gross_profit_this_month ?? 0)} icon={<TrendingUp className="h-5 w-5" />} tone="success" loading={ownerLoading} />
            <StatCard label="Active Customers" value={String(ownerStats?.active_customers ?? 0)} icon={<Users className="h-5 w-5" />} loading={ownerLoading} />
            <StatCard label="Pending Payments" value={String(ownerStats?.pending_payments ?? 0)} icon={<Clock className="h-5 w-5" />} tone="warning" loading={ownerLoading} />
            <StatCard label="Activations Pending" value={String(ownerStats?.activations_pending ?? 0)} icon={<Clock className="h-5 w-5" />} tone="warning" loading={ownerLoading} />
            <StatCard label="Renewals Due Today" value={String(ownerStats?.renewals_due_today ?? 0)} icon={<CalendarClock className="h-5 w-5" />} tone="warning" loading={ownerLoading} />
            <StatCard label="Overdue Renewals" value={String(ownerStats?.overdue_renewals ?? 0)} icon={<AlertTriangle className="h-5 w-5" />} tone="danger" loading={ownerLoading} />
            <StatCard label="Upcoming Renewals" value={String(ownerStats?.upcoming_renewals ?? 0)} icon={<CalendarClock className="h-5 w-5" />} tone="info" loading={ownerLoading} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <StatCard label="My Sales Today" value={String(managerStats?.my_sales_today ?? 0)} icon={<ShoppingCart className="h-5 w-5" />} tone="primary" loading={managerLoading} />
            <StatCard label="Pending Payments" value={String(managerStats?.pending_payments ?? 0)} icon={<Clock className="h-5 w-5" />} tone="warning" loading={managerLoading} />
            <StatCard label="Activations Pending" value={String(managerStats?.activations_pending ?? 0)} icon={<Clock className="h-5 w-5" />} tone="warning" loading={managerLoading} />
            <StatCard label="Renewals Due Today" value={String(managerStats?.renewals_due_today ?? 0)} icon={<CalendarClock className="h-5 w-5" />} tone="warning" loading={managerLoading} />
            <StatCard label="Overdue Renewals" value={String(managerStats?.overdue_renewals ?? 0)} icon={<AlertTriangle className="h-5 w-5" />} tone="danger" loading={managerLoading} />
            <StatCard label="Upcoming Renewals" value={String(managerStats?.upcoming_renewals ?? 0)} icon={<CalendarClock className="h-5 w-5" />} tone="info" loading={managerLoading} />
            <StatCard label="Recent Customers" value={String(managerStats?.recent_customers ?? 0)} icon={<Users className="h-5 w-5" />} tone="info" loading={managerLoading} />
          </div>
        )}

        {/* Recent sales */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">Recent Sales</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => navigate("/sales")}>
              View all
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            {!recentSales ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : (
              <RecentSalesTable sales={recentSales} />
            )}
          </CardContent>
        </Card>

        {/* Recent customers */}
        {recentCustomers && recentCustomers.length > 0 && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">Recent Customers</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate("/customers")}>
                View all
              </Button>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex flex-col gap-2">
                {recentCustomers.map((c) => (
                  <div
                    key={c.id}
                    className="flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 hover:bg-muted/40"
                    onClick={() => navigate(`/customers/${c.id}`)}
                  >
                    <div>
                      <p className="text-sm font-medium">{c.name ?? "Unnamed"}</p>
                      <p className="text-xs text-muted-foreground">{c.phone_display ?? c.phone_normalized}</p>
                    </div>
                    <StatusBadge status={c.customer_type} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </PageContainer>
  );
}
