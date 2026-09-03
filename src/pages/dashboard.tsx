import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { PageContainer, PageHeader, EmptyState, StatusBadge } from "@/components/ui-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PlusCircle,
  ShoppingCart,
  Users,
  Package,
  IndianRupee,
  TrendingUp,
  TrendingDown,
  Clock,
  AlertTriangle,
  CalendarClock,
  UserPlus,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { formatMoney } from "@/lib/format";
import type { OwnerDashboardStats, ManagerDashboardStats, Sale, Customer } from "@/lib/types";

interface MonthlyTrend {
  month: string;
  revenue: number;
  cost: number;
  profit: number;
  sale_count: number;
}

interface CategoryRevenue {
  category_name: string;
  revenue: number;
  count: number;
}

interface WeeklySales {
  day_label: string;
  revenue: number;
  sale_count: number;
}

const CHART_COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
];

function TrendIndicator({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) {
    return current > 0 ? (
      <span className="flex items-center gap-0.5 text-xs text-success">
        <TrendingUp className="h-3 w-3" /> New
      </span>
    ) : null;
  }
  const pct = ((current - previous) / previous) * 100;
  const isUp = pct >= 0;
  return (
    <span className={`flex items-center gap-0.5 text-xs ${isUp ? "text-success" : "text-destructive"}`}>
      {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {Math.abs(pct).toFixed(0)}% vs last month
    </span>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone = "default",
  loading,
  trend,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "info" | "primary";
  loading?: boolean;
  trend?: React.ReactNode;
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
          {trend && <div className="mt-0.5">{trend}</div>}
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

function ActionItems({
  stats,
  loading,
}: {
  stats?: OwnerDashboardStats | ManagerDashboardStats;
  loading: boolean;
}) {
  const navigate = useNavigate();
  const items = [
    {
      label: "Pending Payments",
      count: stats?.pending_payments ?? 0,
      icon: Clock,
      tone: "text-warning",
      path: "/sales?pay=pending",
    },
    {
      label: "Activations Pending",
      count: stats?.activations_pending ?? 0,
      icon: Clock,
      tone: "text-warning",
      path: "/sales?fulfil=activation_pending",
    },
    {
      label: "Overdue Renewals",
      count: stats?.overdue_renewals ?? 0,
      icon: AlertTriangle,
      tone: "text-destructive",
      path: "/renewals?status=overdue",
    },
    {
      label: "Renewals Due Today",
      count: stats?.renewals_due_today ?? 0,
      icon: CalendarClock,
      tone: "text-warning",
      path: "/renewals?status=due",
    },
  ];

  const activeItems = items.filter((item) => item.count > 0);

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Action Items</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (activeItems.length === 0) {
    return (
      <Card className="border-success/20 bg-success/5">
        <CardContent className="flex items-center gap-3 p-4">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <div>
            <p className="text-sm font-medium">All caught up!</p>
            <p className="text-xs text-muted-foreground">No items need your attention right now.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Action Items</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex flex-col gap-1">
          {activeItems.map((item) => (
            <button
              key={item.label}
              onClick={() => navigate(item.path)}
              className="flex items-center gap-3 rounded-lg border px-3 py-2 text-left hover:bg-muted/40"
            >
              <item.icon className={`h-4 w-4 ${item.tone}`} />
              <span className="flex-1 text-sm font-medium">{item.label}</span>
              <span className="text-lg font-semibold">{item.count}</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function RevenueChart({ months }: { months: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard-monthly-trends", months],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("dashboard_monthly_trends", {
        p_months: months,
      });
      if (error) throw error;
      return data as MonthlyTrend[];
    },
  });

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  const chartData = (data ?? []).map((d) => ({
    ...d,
    revenue: Number(d.revenue),
    cost: Number(d.cost),
    profit: Number(d.profit),
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
        <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="hsl(var(--muted-foreground))"
          tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
            fontSize: "12px",
          }}
          formatter={(value) => formatMoney(Number(value))}
        />
        <Area
          type="monotone"
          dataKey="revenue"
          stroke="#6366f1"
          strokeWidth={2}
          fill="url(#revGrad)"
          name="Revenue"
        />
        <Area
          type="monotone"
          dataKey="profit"
          stroke="#22c55e"
          strokeWidth={2}
          fill="url(#profitGrad)"
          name="Profit"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function CategoryChart() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard-revenue-by-category"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("dashboard_revenue_by_category");
      if (error) throw error;
      return data as CategoryRevenue[];
    },
  });

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  const chartData = (data ?? []).map((d) => ({
    ...d,
    revenue: Number(d.revenue),
  }));

  if (chartData.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No sales this month yet.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie
          data={chartData}
          dataKey="revenue"
          nameKey="category_name"
          cx="50%"
          cy="50%"
          outerRadius={80}
          innerRadius={40}
          paddingAngle={2}
        >
          {chartData.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
            fontSize: "12px",
          }}
          formatter={(value) => formatMoney(Number(value))}
        />
        <Legend wrapperStyle={{ fontSize: "12px" }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function WeeklySalesChart() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard-weekly-sales"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("dashboard_weekly_sales");
      if (error) throw error;
      return data as WeeklySales[];
    },
  });

  if (isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  const chartData = (data ?? []).map((d) => ({
    ...d,
    revenue: Number(d.revenue),
  }));

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
        <XAxis dataKey="day_label" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="hsl(var(--muted-foreground))"
          tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
            fontSize: "12px",
          }}
          formatter={(value) => formatMoney(Number(value))}
        />
        <Bar dataKey="revenue" fill="#6366f1" radius={[4, 4, 0, 0]} name="Revenue" />
      </BarChart>
    </ResponsiveContainer>
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
              <td className="py-2 pr-3 text-muted-foreground">
                {new Date(sale.sale_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
              </td>
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
  const [chartMonths, setChartMonths] = useState("6");

  const { data: finStats, isLoading: finLoading } = useQuery({
    queryKey: ["dashboard-financial-stats"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("dashboard_financial_stats");
      if (error) throw error;
      return data as {
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
      };
    },
  });

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

        {/* Action Items */}
        <ActionItems
          stats={isOwner ? ownerStats : managerStats}
          loading={isOwner ? ownerLoading : managerLoading}
        />

        {isOwner ? (
          <>
            {/* Key stats with trends */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                label="Revenue"
                value={formatMoney(finStats?.revenue_this_month ?? 0)}
                icon={<IndianRupee className="h-5 w-5" />}
                tone="primary"
                loading={finLoading}
                trend={<TrendIndicator current={finStats?.revenue_this_month ?? 0} previous={finStats?.prev_month_revenue ?? 0} />}
              />
              <StatCard
                label="Cash Received"
                value={formatMoney(finStats?.cash_received_this_month ?? 0)}
                icon={<CheckCircle2 className="h-5 w-5" />}
                tone="success"
                loading={finLoading}
              />
              <StatCard
                label="Expenses"
                value={formatMoney(finStats?.expenses_this_month ?? 0)}
                icon={<Package className="h-5 w-5" />}
                tone="info"
                loading={finLoading}
              />
              <StatCard
                label="Gross Profit"
                value={formatMoney(finStats?.gross_profit_this_month ?? 0)}
                icon={<TrendingUp className="h-5 w-5" />}
                tone="success"
                loading={finLoading}
                trend={<TrendIndicator current={finStats?.gross_profit_this_month ?? 0} previous={finStats?.prev_month_profit ?? 0} />}
              />
              <StatCard
                label="Net Profit"
                value={formatMoney(finStats?.net_profit_this_month ?? 0)}
                icon={<TrendingUp className="h-5 w-5" />}
                tone={finStats && finStats.net_profit_this_month >= 0 ? "success" : "danger"}
                loading={finLoading}
              />
              <StatCard
                label="Active Customers"
                value={String(ownerStats?.active_customers ?? 0)}
                icon={<Users className="h-5 w-5" />}
                loading={ownerLoading}
              />
            </div>

            {/* Operational stats row */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Pending Payments" value={String(finStats?.pending_payments_count ?? 0)} icon={<Clock className="h-5 w-5" />} tone="warning" loading={finLoading} />
              <StatCard label="Activations Pending" value={String(finStats?.activations_pending_count ?? 0)} icon={<Clock className="h-5 w-5" />} tone="warning" loading={finLoading} />
              <StatCard label="Renewals Due Today" value={String(finStats?.renewals_due_today_count ?? 0)} icon={<CalendarClock className="h-5 w-5" />} tone="warning" loading={finLoading} />
              <StatCard label="Overdue Renewals" value={String(finStats?.overdue_renewals_count ?? 0)} icon={<AlertTriangle className="h-5 w-5" />} tone="danger" loading={finLoading} />
            </div>

            {/* Revenue chart with range selector */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-base">Revenue & Profit Trend</CardTitle>
                <Select value={chartMonths} onValueChange={setChartMonths}>
                  <SelectTrigger className="h-8 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">3 months</SelectItem>
                    <SelectItem value="6">6 months</SelectItem>
                    <SelectItem value="12">12 months</SelectItem>
                  </SelectContent>
                </Select>
              </CardHeader>
              <CardContent className="pt-0">
                <RevenueChart months={parseInt(chartMonths)} />
              </CardContent>
            </Card>

            {/* Two-column: weekly sales + category breakdown */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Sales This Week</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <WeeklySalesChart />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Revenue by Category (This Month)</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <CategoryChart />
                </CardContent>
              </Card>
            </div>
          </>
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

        {/* Recent sales & customers in tabs */}
        <Tabs defaultValue="sales">
          <TabsList>
            <TabsTrigger value="sales">Recent Sales</TabsTrigger>
            <TabsTrigger value="customers">Recent Customers</TabsTrigger>
          </TabsList>
          <TabsContent value="sales">
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
          </TabsContent>
          <TabsContent value="customers">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-base">Recent Customers</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => navigate("/customers")}>
                  View all
                </Button>
              </CardHeader>
              <CardContent className="pt-0">
                {!recentCustomers ? (
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                ) : recentCustomers.length === 0 ? (
                  <EmptyState icon={<Users className="h-5 w-5" />} title="No customers yet" description="Add your first customer to get started." />
                ) : (
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
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </PageContainer>
  );
}
