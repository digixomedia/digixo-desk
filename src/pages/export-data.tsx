import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { PageContainer, PageHeader, EmptyState, RetryableError } from "@/components/ui-shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Download, FileSpreadsheet, Database } from "lucide-react";
import { collectCompletePages, dateRangeStart, rowsToCsv } from "@/lib/data-safety";

type DataType = "sales" | "customers" | "renewals" | "payments" | "products";
type RangeKey = "7d" | "30d" | "90d" | "ytd" | "all";
type Cell = string | number | boolean | null;
type ExportTable = { headers: string[]; rows: Cell[][]; total: number };

const PREVIEW_LIMIT = 100;
const EXPORT_PAGE_SIZE = 500;
const DATA_OPTIONS: { key: DataType; label: string }[] = [
  { key: "sales", label: "Sales" }, { key: "customers", label: "Customers" },
  { key: "renewals", label: "Renewals" }, { key: "payments", label: "Payments" },
  { key: "products", label: "Products & Plans" },
];
const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" }, { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" }, { key: "ytd", label: "Year to date" },
  { key: "all", label: "All time" },
];

function hasDateFilter(type: DataType) { return type === "sales" || type === "renewals" || type === "payments"; }

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

async function fetchPage(type: DataType, startDate: string | null, from: number, to: number, withCount: boolean): Promise<ExportTable> {
  const count = withCount ? "exact" as const : undefined;
  if (type === "sales") {
    let q = supabase.from("sales").select("id, sale_number, sale_date, customer_id, product_plan_id, product_name_snapshot, plan_name_snapshot, final_selling_price, cost_price_snapshot, payment_fee, refund_amount, replacement_cost, payment_status, fulfilment_status, payment_method, transaction_reference, archived_at", { count })
      .eq("is_demo", false).order("sale_date", { ascending: false }).order("id", { ascending: true }).range(from, to);
    if (startDate) q = q.gte("sale_date", startDate);
    const { data, error, count: total } = await q; if (error) throw error;
    return { headers: ["ID","Sale #","Date","Customer ID","Plan ID","Product","Plan","Selling Price","Cost","Payment Fee","Refund Total","Replacement Cost","Payment Status","Fulfilment","Method","Transaction Reference","Archived At"], rows: (data ?? []).map(s => [s.id,s.sale_number,s.sale_date,s.customer_id,s.product_plan_id,s.product_name_snapshot,s.plan_name_snapshot,s.final_selling_price,s.cost_price_snapshot,s.payment_fee,s.refund_amount,s.replacement_cost,s.payment_status,s.fulfilment_status,s.payment_method,s.transaction_reference,s.archived_at]), total: total ?? 0 };
  }
  if (type === "customers") {
    const { data, error, count: total } = await supabase.from("customers").select("id, name, phone_display, phone_normalized, email, customer_type, acquisition_source, marketing_allowed, do_not_message, created_at, archived_at", { count }).order("created_at", { ascending: false }).order("id", { ascending: true }).range(from,to); if (error) throw error;
    return { headers: ["ID","Name","Phone (Display)","Phone (Normalized)","Email","Type","Source","Marketing Allowed","Do Not Message","Created","Archived At"], rows: (data ?? []).map(c => [c.id,c.name,c.phone_display,c.phone_normalized,c.email,c.customer_type,c.acquisition_source,c.marketing_allowed,c.do_not_message,c.created_at,c.archived_at]), total: total ?? 0 };
  }
  if (type === "renewals") {
    let q = supabase.from("renewals").select("id, subscription_id, customer_id, due_date, status, snoozed_until, reminder_opened_at, reminded_at, renewed_at, linked_new_sale_id, note, archived_at", { count }).eq("is_demo", false).order("due_date", { ascending: false }).order("id", { ascending: true }).range(from,to); if (startDate) q=q.gte("due_date",startDate);
    const { data,error,count:total }=await q;if(error)throw error;
    return { headers:["ID","Subscription ID","Customer ID","Due Date","Status","Snoozed Until","Chat Opened At","Contact Confirmed At","Renewed At","Linked Sale ID","Note","Archived At"], rows:(data??[]).map(r=>[r.id,r.subscription_id,r.customer_id,r.due_date,r.status,r.snoozed_until,r.reminder_opened_at,r.reminded_at,r.renewed_at,r.linked_new_sale_id,r.note,r.archived_at]), total:total??0 };
  }
  if (type === "payments") {
    let q=supabase.from("payments").select("id, sale_id, amount, payment_method, transaction_reference, payment_date, status, note, created_at",{count}).eq("is_demo", false).order("payment_date",{ascending:false}).order("id",{ascending:true}).range(from,to);if(startDate)q=q.gte("payment_date",startDate);
    const {data,error,count:total}=await q;if(error)throw error;
    return {headers:["ID","Sale ID","Amount","Method","Reference","Payment Date","Status","Note","Created"],rows:(data??[]).map(p=>[p.id,p.sale_id,p.amount,p.payment_method,p.transaction_reference,p.payment_date,p.status,p.note,p.created_at]),total:total??0};
  }
  const {data,error,count:total}=await supabase.from("product_plans").select("id, product_id, plan_name, purchase_type, duration_days, warranty_days, default_cost_price, default_selling_price, optional_list_price, optional_stock_count, low_stock_threshold, is_active, archived_at, product:products(name)",{count}).order("created_at",{ascending:false}).order("id",{ascending:true}).range(from,to);if(error)throw error;
  return {headers:["Plan ID","Product ID","Product","Plan","Purchase Type","Duration Days","Warranty Days","Cost Price","Selling Price","List Price","Stock","Low Stock Threshold","Active","Archived At"],rows:(data??[]).map(p=>{const product=p.product as {name?:string}|null;return[p.id,p.product_id,product?.name??null,p.plan_name,p.purchase_type,p.duration_days,p.warranty_days,p.default_cost_price,p.default_selling_price,p.optional_list_price,p.optional_stock_count,p.low_stock_threshold,p.is_active,p.archived_at]}),total:total??0};
}

async function fetchAll(type: DataType, startDate: string | null): Promise<ExportTable> {
  let headers: string[] = [];
  const result = await collectCompletePages(EXPORT_PAGE_SIZE, async (offset, withCount) => {
    const page = await fetchPage(type, startDate, offset, offset + EXPORT_PAGE_SIZE - 1, withCount);
    headers = page.headers;
    return { rows: page.rows, total: page.total };
  }, (row) => String(row[0] ?? ""));
  return { headers, rows: result.rows, total: result.total };
}

export function ExportDataPage() {
  const [dataType,setDataType]=useState<DataType>("sales"); const [range,setRange]=useState<RangeKey>("30d"); const [exporting,setExporting]=useState(false);
  const startDate=hasDateFilter(dataType)?dateRangeStart(range):null;
  const {data:preview,isLoading,isError,refetch}=useQuery({queryKey:["export-preview",dataType,startDate],queryFn:()=>fetchPage(dataType,startDate,0,PREVIEW_LIMIT-1,true)});
  const handleExport=async()=>{setExporting(true);try{const all=await fetchAll(dataType,startDate);if(all.total===0)throw new Error("Nothing to export");downloadCsv(`${dataType}-export-${new Date().toISOString().slice(0,10)}.csv`,rowsToCsv(all.headers,all.rows));toast.success(`Exported all ${all.total} matching ${dataType} records`);}catch(error){toast.error(error instanceof Error?error.message:"Export failed");}finally{setExporting(false);}};
  return <PageContainer><div className="flex flex-col gap-6">
    <PageHeader title="Export Data" description="Download complete, spreadsheet-safe CSV datasets" />
    {isError && (
      <RetryableError
        message="The export preview and matching total could not be loaded."
        onRetry={() => void refetch()}
      />
    )}
    <Card><CardContent className="flex flex-col gap-4 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex flex-col gap-1.5"><label className="text-xs font-medium text-muted-foreground">Data type</label><Select value={dataType} onValueChange={v=>setDataType(v as DataType)}><SelectTrigger className="w-full sm:w-48"><SelectValue/></SelectTrigger><SelectContent>{DATA_OPTIONS.map(o=><SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}</SelectContent></Select></div>
      {hasDateFilter(dataType)?<div className="flex flex-col gap-1.5"><label className="text-xs font-medium text-muted-foreground">Date range</label><Select value={range} onValueChange={v=>setRange(v as RangeKey)}><SelectTrigger className="w-full sm:w-48"><SelectValue/></SelectTrigger><SelectContent>{RANGE_OPTIONS.map(o=><SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}</SelectContent></Select></div>:<p className="pb-2 text-xs text-muted-foreground">Date range does not apply to this dataset.</p>}
      <div className="flex-1"/><Button className="gap-1.5" onClick={()=>void handleExport()} disabled={exporting||!preview||preview.total===0}><Download className="h-4 w-4"/>{exporting?"Exporting all pages…":"Export CSV"}</Button>
    </div><div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"><Database className="h-4 w-4"/>{isLoading?<Skeleton className="h-4 w-40"/>:<span>{preview?.total??0} matching records · {preview?.rows.length??0} loaded for preview</span>}</div></CardContent></Card>
    <Card><CardContent className="p-4">{isLoading?<div className="space-y-2">{Array.from({length:6}).map((_,i)=><Skeleton key={i} className="h-8"/>)}</div>:!preview||preview.total===0?<EmptyState icon={<FileSpreadsheet className="h-5 w-5"/>} title="No matching records" description="Try a different dataset or date range."/>:<div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-xs text-muted-foreground">{preview.headers.map(h=><th key={h} className="whitespace-nowrap py-2 pr-3 font-medium">{h}</th>)}</tr></thead><tbody>{preview.rows.slice(0,20).map((row,i)=><tr key={i} className="border-b last:border-0">{row.map((cell,j)=><td key={j} className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{cell===null||cell===""?"—":String(cell)}</td>)}</tr>)}</tbody></table>{preview.total>20&&<p className="mt-2 text-xs text-muted-foreground">Showing 20 preview rows. Export retrieves all {preview.total} matching records in verified pages.</p>}</div>}</CardContent></Card>
  </div></PageContainer>;
}
