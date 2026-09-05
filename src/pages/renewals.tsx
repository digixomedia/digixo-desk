import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { PageContainer, PageHeader, EmptyState, StatusBadge } from "@/components/ui-shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Search,
  RefreshCw,
  CalendarClock,
  CheckCircle2,
  Clock,
  XCircle,
  Trash2,
} from "lucide-react";
import { formatDate } from "@/lib/format";
import type { Renewal, Customer, Subscription, ProductPlan, Product } from "@/lib/types";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { currentIstDate } from "@/lib/data-safety";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const PENDING_STATUSES = [
  "pending",
  "reminded",
  "interested",
  "awaiting_payment",
  "snoozed",
  "no_response",
];

type RenewalWithRelations = Renewal & {
  customer: Customer | null;
  subscription: (Subscription & {
    product_plan: (ProductPlan & { product: Product | null }) | null;
  }) | null;
};

type FilterTab = "all" | "overdue" | "today" | "next7" | "next30" | "future";

function daysOverdue(dueDate: string): number {
  const due = new Date(dueDate + "T00:00:00Z");
  const today = new Date(currentIstDate() + "T00:00:00Z");
  return Math.floor((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDaysOverdue(days: number): string {
  if (days === 0) return "Due today";
  if (days > 0) return `${days} day${days === 1 ? "" : "s"} overdue`;
  return `In ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`;
}

function buildWhatsAppUrl(
  phone: string,
  countryCode: string,
  customerName: string | null,
  productName: string | null,
  dueDate: string,
): string {
  const fullPhone = `${countryCode}${phone}`.replace(/[^0-9]/g, "");
  const name = customerName ?? "there";
  const product = productName ?? "your product";
  const message = `Hi ${name}, your ${product} renewal is pending (due on ${formatDate(
    dueDate,
  )}). Please renew to continue the service.`;
  return `https://wa.me/${fullPhone}?text=${encodeURIComponent(message)}`;
}

export function RenewalsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const requestedFilter = searchParams.get("filter") as FilterTab | null;
  const [filter, setFilter] = useState<FilterTab>(requestedFilter && ["all","overdue","today","next7","next30","future"].includes(requestedFilter) ? requestedFilter : "all");
  const [snoozeTarget, setSnoozeTarget] = useState<RenewalWithRelations | null>(null);
  const [snoozeDays, setSnoozeDays] = useState("7");
  const [notRenewingTarget, setNotRenewingTarget] = useState<RenewalWithRelations | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RenewalWithRelations | null>(null);

  const { data: renewals, isLoading } = useQuery({
    queryKey: ["renewals", debouncedSearch],
    queryFn: async () => {
      let customerIds: string[] | null = null;
      if (debouncedSearch.trim()) {
        const { data: matches, error: searchError } = await supabase.rpc("search_customer_ids", { p_search: debouncedSearch.trim() });
        if (searchError) throw searchError;
        customerIds = Array.isArray(matches) ? matches.map(row => typeof row === "string" ? row : (row as { id?: string }).id).filter((id): id is string => Boolean(id)) : [];
      }
      let q = supabase
        .from("renewals")
        .select(
          "*, customer:customers(*), subscription:subscriptions(*, product_plan:product_plans(*, product:products(*)))",
        )
        .in("status", PENDING_STATUSES)
        .eq("is_demo", false)
        .or(`status.neq.snoozed,snoozed_until.is.null,snoozed_until.lte.${currentIstDate()}`)
        .order("due_date", { ascending: true })
        .limit(200);

      if (customerIds) q = q.in("customer_id", customerIds.length ? customerIds : ["00000000-0000-0000-0000-000000000000"]);

      const { data, error } = await q;
      if (error) throw error;
      return data as RenewalWithRelations[];
    },
  });

  const allRenewals = renewals ?? [];
  const counts = {
    all: allRenewals.length,
    overdue: allRenewals.filter((r) => daysOverdue(r.due_date) > 0).length,
    today: allRenewals.filter((r) => daysOverdue(r.due_date) === 0).length,
    next7: allRenewals.filter((r) => { const d = daysOverdue(r.due_date); return d < 0 && d >= -7; }).length,
    next30: allRenewals.filter((r) => { const d = daysOverdue(r.due_date); return d < 0 && d >= -30; }).length,
    future: allRenewals.filter((r) => daysOverdue(r.due_date) < -30).length,
  };

  const filteredRenewals = allRenewals.filter((r) => {
    const days = daysOverdue(r.due_date);
    if (filter === "overdue") return days > 0;
    if (filter === "today") return days === 0;
    if (filter === "next7") return days < 0 && days >= -7;
    if (filter === "next30") return days < 0 && days >= -30;
    if (filter === "future") return days < -30;
    return true;
  });

  const confirmContactMutation = useMutation({
    mutationFn: async (renewalId: string) => {
      const { error } = await supabase
        .from("renewals")
        .update({
          status: "reminded",
          reminded_at: new Date().toISOString(),
        })
        .eq("id", renewalId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["renewals"] });
      toast.success("Marked as reminded");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const snoozeMutation = useMutation({
    mutationFn: async ({ renewalId, days }: { renewalId: string; days: number }) => {
      const snoozedUntil = new Date();
      snoozedUntil.setDate(snoozedUntil.getDate() + days);
      const { error } = await supabase
        .from("renewals")
        .update({
          status: "snoozed",
          snoozed_until: snoozedUntil.toISOString().slice(0, 10),
        })
        .eq("id", renewalId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["renewals"] });
      toast.success("Renewal snoozed");
      setSnoozeTarget(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const notRenewingMutation = useMutation({
    mutationFn: async (renewalId: string) => {
      const { error } = await supabase
        .from("renewals")
        .update({ status: "not_renewing" })
        .eq("id", renewalId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["renewals"] });
      toast.success("Marked as not renewing");
      setNotRenewingTarget(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteRenewalMutation = useMutation({
    mutationFn: async (renewalId: string) => {
      const { error } = await supabase.rpc("hard_delete_record", { p_table: "renewals", p_record_id: renewalId });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["renewals"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-financial-stats"] });
      setDeleteTarget(null);
      toast.success("Renewal deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleRemind = (renewal: RenewalWithRelations) => {
    if (renewal.customer?.do_not_message) {
      toast.error("This customer has opted out of messages");
      return;
    }
    const phone = renewal.customer?.phone_normalized ?? "";
    const countryCode = renewal.customer?.phone_country_code ?? "91";
    const customerName = renewal.customer?.name ?? null;
    const productName =
      renewal.subscription?.product_plan?.product?.name ??
      renewal.subscription?.product_plan?.plan_name ??
      null;

    if (!phone) {
      toast.error("No phone number on file for this customer");
      return;
    }

    const url = buildWhatsAppUrl(
      phone,
      countryCode,
      customerName,
      productName,
      renewal.due_date,
    );
    window.open(url, "_blank");
    void supabase.from("renewals").update({ reminder_opened_at: new Date().toISOString() }).eq("id", renewal.id).then(({ error }) => {
      if (error) toast.error("WhatsApp opened, but the chat-open timestamp could not be saved");
      else queryClient.invalidateQueries({ queryKey: ["renewals"] });
    });
  };

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "overdue", label: "Overdue", count: counts.overdue },
    { key: "today", label: "Due Today", count: counts.today },
    { key: "next7", label: "Next 7 Days", count: counts.next7 },
    { key: "next30", label: "Next 30 Days", count: counts.next30 },
    { key: "future", label: "Future", count: counts.future },
  ];

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Renewals"
          description="Pending follow-ups — opening WhatsApp and confirming contact are tracked separately"
        />

        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by customer name or phone…"
            className="pl-9"
          />
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            {
              label: "Total Pending",
              value: counts.all,
              tone: "text-muted-foreground bg-muted/50",
              icon: <CalendarClock className="h-5 w-5" />,
            },
            {
              label: "Overdue",
              value: counts.overdue,
              tone: "text-destructive bg-destructive/10",
              icon: <XCircle className="h-5 w-5" />,
            },
            {
              label: "Due Today",
              value: counts.today,
              tone: "text-warning bg-warning/10",
              icon: <Clock className="h-5 w-5" />,
            },
            {
              label: "Next 7 Days",
              value: counts.next7,
              tone: "text-info bg-info/10",
              icon: <CalendarClock className="h-5 w-5" />,
            },
            {
              label: "Next 30 Days",
              value: counts.next30,
              tone: "text-info bg-info/10",
              icon: <CalendarClock className="h-5 w-5" />,
            },
            {
              label: "Future",
              value: counts.future,
              tone: "text-muted-foreground bg-muted/50",
              icon: <CalendarClock className="h-5 w-5" />,
            },
          ].map((card) => (
            <Card key={card.label}>
              <CardContent className="flex items-center gap-3 p-4">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${card.tone}`}>
                  {card.icon}
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{card.label}</p>
                  <p className="text-lg font-semibold tracking-tight">{card.value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filter tabs */}
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === tab.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-muted/50"
              }`}
            >
              {tab.label}
              <span
                className={`rounded-full px-1.5 py-0.5 text-xs ${
                  filter === tab.key
                    ? "bg-primary-foreground/20"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        {/* List */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : filteredRenewals.length === 0 ? (
          <EmptyState
            icon={<CalendarClock className="h-5 w-5" />}
            title="No renewals in this view"
            description="Try a different filter or clear your search."
          />
        ) : (
          <>
            {/* Desktop table */}
            <Card className="hidden lg:block">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 px-3 font-medium">Customer</th>
                      <th className="py-2 px-3 font-medium">Phone</th>
                      <th className="py-2 px-3 font-medium">Product / Plan</th>
                      <th className="py-2 px-3 font-medium">Due Date</th>
                      <th className="py-2 px-3 font-medium">Status</th>
                      <th className="py-2 px-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRenewals.map((r) => {
                      const days = daysOverdue(r.due_date);
                      const overdueClass = days > 0 ? "text-destructive" : "";
                      return (
                        <tr
                          key={r.id}
                          className="border-b last:border-0 hover:bg-muted/40"
                        >
                          <td className="py-2 px-3 font-medium">
                            {r.customer?.name ?? "Unnamed"}
                          </td>
                          <td className="py-2 px-3 text-muted-foreground">
                            {r.customer?.phone_display ??
                              r.customer?.phone_normalized ??
                              "—"}
                          </td>
                          <td className="py-2 px-3">
                            {r.subscription?.product_plan?.product?.name ?? "—"}
                            <span className="text-muted-foreground">
                              {r.subscription?.product_plan?.plan_name
                                ? ` · ${r.subscription.product_plan.plan_name}`
                                : ""}
                            </span>
                          </td>
                          <td className={`py-2 px-3 ${overdueClass}`}>
                            {formatDate(r.due_date)}
                            <span className="ml-1 text-xs text-muted-foreground">
                              ({formatDaysOverdue(days)})
                            </span>
                          </td>
                          <td className="py-2 px-3">
                            <StatusBadge status={r.status} />
                          </td>
                          <td className="py-2 px-3">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5"
                                onClick={() => handleRemind(r)}
                                disabled={Boolean(r.customer?.do_not_message)}
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                                Remind
                              </Button>
                              {r.reminder_opened_at && !r.reminded_at && (
                                <Button size="sm" variant="outline" onClick={() => confirmContactMutation.mutate(r.id)} disabled={confirmContactMutation.isPending}>
                                  Confirm Contact
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5 border-success/30 text-success hover:bg-success/10"
                                onClick={() => navigate(`/sales/new?renewal=${r.id}`)}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Renewed
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5"
                                onClick={() => {
                                  setSnoozeTarget(r);
                                  setSnoozeDays("7");
                                }}
                              >
                                <Clock className="h-3.5 w-3.5" />
                                Snooze
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10"
                                onClick={() => setNotRenewingTarget(r)}
                              >
                                <XCircle className="h-3.5 w-3.5" />
                                Not Renewing
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="gap-1.5 text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteTarget(r)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Mobile cards */}
            <div className="flex flex-col gap-2 lg:hidden">
              {filteredRenewals.map((r) => {
                const days = daysOverdue(r.due_date);
                return (
                  <Card key={r.id}>
                    <CardContent className="p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {r.customer?.name ?? "Unnamed"}
                        </span>
                        <StatusBadge status={r.status} />
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {r.customer?.phone_display ??
                          r.customer?.phone_normalized ??
                          "—"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {r.subscription?.product_plan?.product?.name ?? "—"}
                        {r.subscription?.product_plan?.plan_name
                          ? ` · ${r.subscription.product_plan.plan_name}`
                          : ""}
                      </p>
                      <div className="mt-1.5">
                        <span
                          className={`text-sm ${days > 0 ? "text-destructive font-medium" : ""}`}
                        >
                          {formatDate(r.due_date)}
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({formatDaysOverdue(days)})
                          </span>
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={() => handleRemind(r)}
                          disabled={Boolean(r.customer?.do_not_message)}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Remind
                        </Button>
                        {r.reminder_opened_at && !r.reminded_at && (
                          <Button size="sm" variant="outline" onClick={() => confirmContactMutation.mutate(r.id)} disabled={confirmContactMutation.isPending}>
                            Confirm Contact
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 border-success/30 text-success hover:bg-success/10"
                          onClick={() => navigate(`/sales/new?renewal=${r.id}`)}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Renewed
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={() => {
                            setSnoozeTarget(r);
                            setSnoozeDays("7");
                          }}
                        >
                          <Clock className="h-3.5 w-3.5" />
                          Snooze
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10"
                          onClick={() => setNotRenewingTarget(r)}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Not Renewing
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1.5 text-destructive hover:bg-destructive/10"
                          onClick={() => setDeleteTarget(r)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Snooze dialog */}
      <Dialog open={!!snoozeTarget} onOpenChange={(open) => !open && setSnoozeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Snooze renewal</DialogTitle>
            <DialogDescription>
              Postpone this renewal reminder. The renewal will reappear after the snooze period ends.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Snooze for</label>
            <Select value={snoozeDays} onValueChange={setSnoozeDays}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="3">3 days</SelectItem>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="14">14 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSnoozeTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                snoozeTarget &&
                snoozeMutation.mutate({
                  renewalId: snoozeTarget.id,
                  days: parseInt(snoozeDays, 10),
                })
              }
              disabled={snoozeMutation.isPending}
            >
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Not Renewing confirmation */}
      <Dialog open={!!notRenewingTarget} onOpenChange={(open) => !open && setNotRenewingTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as not renewing?</DialogTitle>
            <DialogDescription>
              This will remove the renewal from the pending list and record that the customer
              chose not to renew. This can be changed later if needed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNotRenewingTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                notRenewingTarget && notRenewingMutation.mutate(notRenewingTarget.id)
              }
              disabled={notRenewingMutation.isPending}
            >
              Mark as Not Renewing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete renewal confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete renewal record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the renewal for {deleteTarget?.customer?.name ?? "this customer"}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteRenewalMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
