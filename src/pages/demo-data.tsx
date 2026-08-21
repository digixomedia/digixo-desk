import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { PageContainer, PageHeader } from "@/components/ui-shared";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Database, Trash2, FlaskConical, Loader2 } from "lucide-react";

export function DemoDataPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [loadOpen, setLoadOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const loadDemo = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not authenticated");
      const uid = profile.id;

      // 1. Create demo categories
      const { data: cats, error: catErr } = await supabase
        .from("categories")
        .upsert(
          [
            { name: "AI Tools", colour: "#6366f1", created_by: uid },
            { name: "Streaming", colour: "#10b981", created_by: uid },
            { name: "Productivity", colour: "#f59e0b", created_by: uid },
          ],
          { onConflict: "name" }
        )
        .select();
      if (catErr) throw catErr;

      const aiCat = cats?.find((c) => c.name === "AI Tools");
      const streamCat = cats?.find((c) => c.name === "Streaming");
      const prodCat = cats?.find((c) => c.name === "Productivity");

      // 2. Create demo products
      const { data: prods, error: prodErr } = await supabase
        .from("products")
        .insert([
          { name: "Gemini AI Pro", category_id: aiCat?.id ?? null, supplier_name: "Google", created_by: uid },
          { name: "ChatGPT Plus", category_id: aiCat?.id ?? null, supplier_name: "OpenAI", created_by: uid },
          { name: "Netflix Premium", category_id: streamCat?.id ?? null, supplier_name: "Netflix", created_by: uid },
          { name: "Notion Plus", category_id: prodCat?.id ?? null, supplier_name: "Notion", created_by: uid },
        ])
        .select();
      if (prodErr) throw prodErr;

      const gemini = prods?.[0];
      const chatgpt = prods?.[1];
      const netflix = prods?.[2];
      const notion = prods?.[3];

      // 3. Create demo plans
      const { data: plans, error: planErr } = await supabase
        .from("product_plans")
        .insert([
          { product_id: gemini.id, plan_name: "3 Months", purchase_type: "recurring", duration_days: 90, warranty_days: 90, default_cost_price: 300, default_selling_price: 600, created_by: uid },
          { product_id: gemini.id, plan_name: "1 Year", purchase_type: "recurring", duration_days: 365, warranty_days: 365, default_cost_price: 900, default_selling_price: 1800, created_by: uid },
          { product_id: chatgpt.id, plan_name: "1 Month", purchase_type: "recurring", duration_days: 30, warranty_days: 30, default_cost_price: 150, default_selling_price: 350, created_by: uid },
          { product_id: netflix.id, plan_name: "1 Month", purchase_type: "recurring", duration_days: 30, default_cost_price: 400, default_selling_price: 700, created_by: uid },
          { product_id: notion.id, plan_name: "Lifetime", purchase_type: "one_time", duration_days: null, warranty_days: 365, default_cost_price: 500, default_selling_price: 1200, created_by: uid },
        ])
        .select();
      if (planErr) throw planErr;

      const gemini3m = plans?.[0];
      const gemini1y = plans?.[1];
      const chatgpt1m = plans?.[2];
      const netflix1m = plans?.[3];
      const notionLife = plans?.[4];

      // 4. Create demo customers
      const { data: custs, error: custErr } = await supabase
        .from("customers")
        .upsert(
          [
            { name: "Rahul Sharma", phone_normalized: "9876543210", phone_display: "9876543210", email: "rahul@example.com", customer_type: "retail", acquisition_source: "WhatsApp", created_by: uid },
            { name: "Priya Patel", phone_normalized: "9876501234", phone_display: "9876501234", email: "priya@example.com", customer_type: "reseller", acquisition_source: "Telegram", created_by: uid },
            { name: "Amit Kumar", phone_normalized: "9123456789", phone_display: "9123456789", customer_type: "business", acquisition_source: "Website", created_by: uid },
            { name: "Sneha Reddy", phone_normalized: "9988776655", phone_display: "9988776655", customer_type: "retail", acquisition_source: "Referral", created_by: uid },
          ],
          { onConflict: "phone_normalized" }
        )
        .select();
      if (custErr) throw custErr;

      const rahul = custs?.[0];
      const priya = custs?.[1];
      const amit = custs?.[2];
      const sneha = custs?.[3];

      // 5. Create demo sales via create_sale RPC
      const today = new Date().toISOString().slice(0, 10);
      const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
      const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);

      const sales = [
        // Rahul — full payment, recurring 3 months
        { customer_id: rahul.id, product_plan_id: gemini3m.id, final_selling_price: 600, cost_price: 300, amount_received: 600, payment_method: "UPI", payment_status: "paid", fulfilment_status: "activated", sale_date: today },
        // Priya — partial payment, recurring 1 year
        { customer_id: priya.id, product_plan_id: gemini1y.id, final_selling_price: 1800, cost_price: 900, amount_received: 1000, payment_method: "Bank Transfer", payment_status: "partial", fulfilment_status: "activation_pending", sale_date: tenDaysAgo },
        // Amit — one-time lifetime, paid
        { customer_id: amit.id, product_plan_id: notionLife.id, final_selling_price: 1200, cost_price: 500, amount_received: 1200, payment_method: "UPI", payment_status: "paid", fulfilment_status: "completed", sale_date: fortyDaysAgo },
        // Sneha — pending payment, recurring 1 month
        { customer_id: sneha.id, product_plan_id: chatgpt1m.id, final_selling_price: 350, cost_price: 150, amount_received: 0, payment_status: "pending", fulfilment_status: "payment_confirmation", sale_date: tenDaysAgo },
        // Rahul — second sale, Netflix
        { customer_id: rahul.id, product_plan_id: netflix1m.id, final_selling_price: 700, cost_price: 400, amount_received: 700, payment_method: "Cash", payment_status: "paid", fulfilment_status: "activated", sale_date: fortyDaysAgo },
      ];

      for (const s of sales) {
        const { error } = await supabase.rpc("create_sale", {
          p_payload: {
            ...s,
            payment_fee: 0,
            is_custom: false,
            sale_date: s.sale_date,
          },
        });
        if (error) throw error;
      }

      // 6. Mark demo records
      await supabase.from("sales").update({ is_demo: true }).in("customer_id", [rahul.id, priya.id, amit.id, sneha.id]);
      await supabase.from("payments").update({ is_demo: true }).in(
        "sale_id",
        (await supabase.from("sales").select("id").eq("is_demo", true)).data?.map((r) => r.id) ?? []
      );
      await supabase.from("subscriptions").update({ is_demo: true }).in("customer_id", [rahul.id, priya.id, amit.id, sneha.id]);
      await supabase.from("renewals").update({ is_demo: true }).in("customer_id", [rahul.id, priya.id, amit.id, sneha.id]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
      setLoadOpen(false);
      toast.success("Demo data loaded successfully");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeDemo = useMutation({
    mutationFn: async () => {
      // Delete only demo-marked records, in dependency order
      const { error: rErr } = await supabase.from("renewals").delete().eq("is_demo", true);
      if (rErr) throw rErr;
      const { error: sErr } = await supabase.from("subscriptions").delete().eq("is_demo", true);
      if (sErr) throw sErr;
      const { error: pErr } = await supabase.from("payments").delete().eq("is_demo", true);
      if (pErr) throw pErr;
      const { error: saleErr } = await supabase.from("sales").delete().eq("is_demo", true);
      if (saleErr) throw saleErr;
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
      setRemoveOpen(false);
      toast.success("Demo data removed");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader title="Demo Data" description="Load or remove labelled demo data for testing" />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="h-4 w-4 text-primary" /> Load Demo Data
              </CardTitle>
              <CardDescription>
                Creates several products, plans, customers, and sales (including partial payments and renewals). All demo records are clearly marked and can be safely removed without affecting real data.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => setLoadOpen(true)} disabled={loadDemo.isPending}>
                {loadDemo.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}
                Load Demo Dataset
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Trash2 className="h-4 w-4 text-destructive" /> Remove Demo Data
              </CardTitle>
              <CardDescription>
                Deletes only records explicitly marked as demo data. Real customer and sales data is never touched.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" onClick={() => setRemoveOpen(true)} disabled={removeDemo.isPending}>
                {removeDemo.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Remove Demo Data
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Load confirmation */}
      <AlertDialog open={loadOpen} onOpenChange={setLoadOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Load demo data?</AlertDialogTitle>
            <AlertDialogDescription>
              This will create demo products, customers, and sales in your database. All records will be marked as demo and can be safely removed later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => loadDemo.mutate()}>
              Load Demo Data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove confirmation */}
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove demo data?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all records marked as demo data. Real data is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeDemo.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
