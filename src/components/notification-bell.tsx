import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Bell, Clock, AlertTriangle, CalendarClock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface NotificationCounts {
  pending_payments: number;
  activations_pending: number;
  overdue_renewals: number;
  renewals_due_today: number;
}

export function NotificationBell() {
  const { isOwner } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const { data: stats, isLoading } = useQuery({
    queryKey: ["notification-counts"],
    queryFn: async () => {
      const rpc = isOwner ? "owner_dashboard_stats" : "manager_dashboard_stats";
      const { data, error } = await supabase.rpc(rpc);
      if (error) throw error;
      return data as NotificationCounts;
    },
    refetchInterval: 60_000,
  });

  const total =
    (stats?.pending_payments ?? 0) +
    (stats?.activations_pending ?? 0) +
    (stats?.overdue_renewals ?? 0) +
    (stats?.renewals_due_today ?? 0);

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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-4 w-4" />
          {total > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
              {total > 9 ? "9+" : total}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b px-4 py-3">
          <p className="text-sm font-semibold">Notifications</p>
          <p className="text-xs text-muted-foreground">
            {total > 0 ? `${total} item${total > 1 ? "s" : ""} need attention` : "You're all caught up"}
          </p>
        </div>
        <div className="flex flex-col">
          {isLoading ? (
            <div className="p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="mt-2 h-8 w-full" />
            </div>
          ) : total === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No pending items
            </div>
          ) : (
            items
              .filter((item) => item.count > 0)
              .map((item) => (
                <button
                  key={item.label}
                  onClick={() => {
                    navigate(item.path);
                    setOpen(false);
                  }}
                  className="flex items-center gap-3 border-b px-4 py-3 text-left last:border-0 hover:bg-muted/50"
                >
                  <item.icon className={`h-4 w-4 ${item.tone}`} />
                  <span className="flex-1 text-sm">{item.label}</span>
                  <span className="text-sm font-semibold">{item.count}</span>
                </button>
              ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
