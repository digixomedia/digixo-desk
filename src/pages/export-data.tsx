import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { PageContainer, PageHeader, EmptyState } from "@/components/ui-shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Download, FileSpreadsheet, Database } from "lucide-react";

type DataType = "sales" | "customers" | "renewals" | "payments" | "products";
type RangeKey = "7d" | "30d" | "90d" | "ytd" | "all";

const DATA_OPTIONS: { key: DataType; label: string }[] = [
  { key: "sales", label: "Sales" },
  { key: "customers", label: "Customers" },
  { key: "renewals", label: "Renewals" },
  { key: "payments", label: "Payments" },
  { key: "products", label: "Products" },
];

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

function escapeCsv(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCsv(headers: string[], rows: (string | number | boolean | null)[][]): string {
  const headerLine = headers.map(escapeCsv).join(",");
  const dataLines = rows.map((row) => row.map(escapeCsv).join(","));
  return [headerLine, ...dataLines].join("\n");
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function ExportDataPage() {
  const [dataType, setDataType] = useState<DataType>("sales");
  const [range, setRange] = useState<RangeKey>("30d");
  const [exporting, setExporting] = useState(false);

  const startDate = getStartDate(range);

  const { data: preview, isLoading } = useQuery({
    queryKey: ["export-preview", dataType, range],
    queryFn: async () => {
      const start = startDate;

      if (dataType === "sales") {
        let q = supabase
          .from("sales")
          .select("sale_number, sale_date, product_name_snapshot, plan_name_snapshot, final_selling_price, cost_price_snapshot, payment_status, fulfilment_status, payment_method")
          .order("sale_date", { ascending: false })
          .limit(100);
        if (start) q = q.gte("sale_date", start);
        const { data, error } = await q;
        if (error) throw error;
        return {
          headers: ["Sale #", "Date", "Product", "Plan", "Selling Price", "Cost", "Payment Status", "Fulfilment", "Method"],
          rows: (data ?? []).map((s: Record<string, unknown>) => [
            s.sale_number as string,
            s.sale_date as string,
            s.product_name_snapshot as string,
            s.plan_name_snapshot as string,
            s.final_selling_price as number,
            s.cost_price_snapshot as number,
            s.payment_status as string,
            s.fulfilment_status as string,
            s.payment_method as string,
          ]),
          count: data?.length ?? 0,
        };
      }

      if (dataType === "customers") {
        const { data, error } = await supabase
          .from("customers")
          .select("name, phone_display, phone_normalized, email, customer_type, acquisition_source, created_at")
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) throw error;
        return {
          headers: ["Name", "Phone (Display)", "Phone (Normalized)", "Email", "Type", "Source", "Created"],
          rows: (data ?? []).map((c: Record<string, unknown>) => [
            c.name as string,
            c.phone_display as string,
            c.phone_normalized as string,
            c.email as string,
            c.customer_type as string,
            c.acquisition_source as string,
            c.created_at as string,
          ]),
          count: data?.length ?? 0,
        };
      }

      if (dataType === "renewals") {
        let q = supabase
          .from("renewals")
          .select("due_date, status, snoozed_until, reminded_at, renewed_at, note, customer:customers(name, phone_display)")
          .order("due_date", { ascending: false })
          .limit(100);
        if (start) q = q.gte("due_date", start);
        const { data, error } = await q;
        if (error) throw error;
        return {
          headers: ["Due Date", "Status", "Snoozed Until", "Reminded At", "Renewed At", "Note", "Customer", "Phone"],
          rows: (data ?? []).map((r: Record<string, unknown>) => {
            const customer = r.customer as Record<string, unknown> | null;
            return [
              r.due_date as string,
              r.status as string,
              r.snoozed_until as string,
              r.reminded_at as string,
              r.renewed_at as string,
              r.note as string,
              customer?.name as string,
              customer?.phone_display as string,
            ];
          }),
          count: data?.length ?? 0,
        };
      }

      if (dataType === "payments") {
        let q = supabase
          .from("payments")
          .select("amount, payment_method, transaction_reference, payment_date, status, sale_id")
          .order("payment_date", { ascending: false })
          .limit(100);
        if (start) q = q.gte("payment_date", start);
        const { data, error } = await q;
        if (error) throw error;
        return {
          headers: ["Amount", "Method", "Reference", "Date", "Status", "Sale ID"],
          rows: (data ?? []).map((p: Record<string, unknown>) => [
            p.amount as number,
            p.payment_method as string,
            p.transaction_reference as string,
            p.payment_date as string,
            p.status as string,
            p.sale_id as string,
          ]),
          count: data?.length ?? 0,
        };
      }

      // products
      const { data, error } = await supabase
        .from("product_plans")
        .select("plan_name, default_cost_price, default_selling_price, optional_list_price, low_stock_threshold, is_active, product:products(name)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return {
        headers: ["Product", "Plan", "Cost Price", "Selling Price", "List Price", "Low Stock Threshold", "Active"],
        rows: (data ?? []).map((p: Record<string, unknown>) => {
          const product = p.product as Record<string, unknown> | null;
          return [
            product?.name as string,
            p.plan_name as string,
            p.default_cost_price as number,
            p.default_selling_price as number,
            p.optional_list_price as number,
            p.low_stock_threshold as number,
            p.is_active as boolean,
          ];
        }),
        count: data?.length ?? 0,
      };
    },
  });

  const handleExport = () => {
    if (!preview || preview.count === 0) {
      toast.error("Nothing to export");
      return;
    }

    setExporting(true);
    try {
      const csv = rowsToCsv(preview.headers, preview.rows as (string | number | boolean | null)[][]);
      const dateStr = new Date().toISOString().slice(0, 10);
      downloadCsv(`${dataType}-export-${dateStr}.csv`, csv);
      toast.success(`Exported ${preview.count} ${dataType}`);
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Export Data"
          description="Download your records as a spreadsheet-friendly CSV file"
        />

        {/* Export controls */}
        <Card>
          <CardContent className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">Data type</label>
                <Select value={dataType} onValueChange={(v) => setDataType(v as DataType)}>
                  <SelectTrigger className="w-full sm:w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DATA_OPTIONS.map((opt) => (
                      <SelectItem key={opt.key} value={opt.key}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">Date range</label>
                <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
                  <SelectTrigger className="w-full sm:w-48">
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
              </div>
              <div className="flex-1" />
              <div className="flex items-end">
                <Button
                  className="gap-1.5"
                  onClick={handleExport}
                  disabled={exporting || !preview || preview.count === 0}
                >
                  <Download className="h-4 w-4" />
                  Export CSV
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              <Database className="h-4 w-4 shrink-0" />
              {isLoading ? (
                <Skeleton className="h-4 w-32" />
              ) : (
                <span>
                  {preview?.count ?? 0} record{preview?.count === 1 ? "" : "s"} ready to export
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Preview */}
        <Card>
          <CardContent className="p-4">
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : !preview || preview.count === 0 ? (
              <EmptyState
                icon={<FileSpreadsheet className="h-5 w-5" />}
                title="No records to preview"
                description="Try a different data type or widen the date range."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      {preview.headers.map((h) => (
                        <th key={h} className="py-2 pr-3 font-medium whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 20).map((row, i) => (
                      <tr key={i} className="border-b last:border-0">
                        {row.map((cell, j) => (
                          <td key={j} className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                            {cell === null || cell === undefined || cell === ""
                              ? "—"
                              : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.count > 20 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Showing 20 of {preview.count} records. Export all to see the full data.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
