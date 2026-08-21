import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {children}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
      {icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {icon}
        </div>
      )}
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-warning/10 text-warning border-warning/20",
  partial: "bg-info/10 text-info border-info/20",
  paid: "bg-success/10 text-success border-success/20",
  refunded: "bg-destructive/10 text-destructive border-destructive/20",
  partially_refunded: "bg-warning/10 text-warning border-warning/20",
  cancelled: "bg-muted text-muted-foreground border-border",
  active: "bg-success/10 text-success border-success/20",
  due: "bg-warning/10 text-warning border-warning/20",
  overdue: "bg-destructive/10 text-destructive border-destructive/20",
  renewed: "bg-info/10 text-info border-info/20",
  lapsed: "bg-destructive/10 text-destructive border-destructive/20",
  payment_confirmation: "bg-muted text-muted-foreground border-border",
  activation_pending: "bg-warning/10 text-warning border-warning/20",
  processing: "bg-info/10 text-info border-info/20",
  activated: "bg-success/10 text-success border-success/20",
  replacement_required: "bg-destructive/10 text-destructive border-destructive/20",
  completed: "bg-success/10 text-success border-success/20",
  new: "bg-info/10 text-info border-info/20",
  interested: "bg-primary/10 text-primary border-primary/20",
  won: "bg-success/10 text-success border-success/20",
  lost: "bg-destructive/10 text-destructive border-destructive/20",
  follow_up: "bg-warning/10 text-warning border-warning/20",
  follow_up_later: "bg-warning/10 text-warning border-warning/20",
  awaiting_payment: "bg-warning/10 text-warning border-warning/20",
  reminded: "bg-info/10 text-info border-info/20",
  snoozed: "bg-muted text-muted-foreground border-border",
  no_response: "bg-muted text-muted-foreground border-border",
  not_renewing: "bg-destructive/10 text-destructive border-destructive/20",
  open: "bg-warning/10 text-warning border-warning/20",
  in_progress: "bg-info/10 text-info border-info/20",
  resolved: "bg-success/10 text-success border-success/20",
  closed: "bg-muted text-muted-foreground border-border",
};

export function StatusBadge({
  status,
  label,
}: {
  status: string;
  label?: string;
}) {
  const style = STATUS_STYLES[status] ?? "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium capitalize",
        style
      )}
    >
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}
