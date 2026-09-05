import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { PageContainer, PageHeader, EmptyState, StatusBadge } from "@/components/ui-shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { toast } from "sonner";
import { Plus, Package, Pencil, Archive, ArchiveRestore, Trash2, ChevronRight, History, EyeOff } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/format";
import type { Product, ProductPlan, Category, ProductPriceHistory, PurchaseType } from "@/lib/types";
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

export function ProductsPage() {
  const { profile, isOwner } = useAuth();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [planPanel, setPlanPanel] = useState<Product | null>(null);
  const [priceHistoryFor, setPriceHistoryFor] = useState<ProductPlan | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [description, setDescription] = useState("");
  const [supplier, setSupplier] = useState("");

  // Plan form
  const [planEditing, setPlanEditing] = useState<ProductPlan | null>(null);
  const [planName, setPlanName] = useState("");
  const [planPurchaseType, setPlanPurchaseType] = useState<PurchaseType>("one_time");
  const [planDuration, setPlanDuration] = useState<string>("");
  const [planWarranty, setPlanWarranty] = useState<string>("");
  const [planCost, setPlanCost] = useState<string>("");
  const [planSelling, setPlanSelling] = useState<string>("");
  const [planListPrice, setPlanListPrice] = useState<string>("");
  const [planStock, setPlanStock] = useState<string>("");
  const [planActive, setPlanActive] = useState(true);

  const { data: products, isLoading } = useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*, category:categories(*)")
        .order("name");
      if (error) throw error;
      return data as Product[];
    },
  });

  const { data: categories } = useQuery({
    queryKey: ["categories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("categories")
        .select("*")
        .is("archived_at", null)
        .order("name");
      if (error) throw error;
      return data as Category[];
    },
  });

  const { data: plans } = useQuery({
    queryKey: ["plans", planPanel?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_plans")
        .select("*")
        .eq("product_id", planPanel!.id)
        .order("created_at");
      if (error) throw error;
      return data as ProductPlan[];
    },
    enabled: !!planPanel,
  });

  const { data: priceHistory } = useQuery({
    queryKey: ["price-history", priceHistoryFor?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_price_history")
        .select("*")
        .eq("product_plan_id", priceHistoryFor!.id)
        .order("effective_at", { ascending: false });
      if (error) throw error;
      return data as ProductPriceHistory[];
    },
    enabled: !!priceHistoryFor,
  });

  const createProduct = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("products").insert({
        name: name.trim(),
        category_id: categoryId || null,
        description: description.trim() || null,
        supplier_name: supplier.trim() || null,
        created_by: profile?.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setCreateOpen(false);
      resetForm();
      toast.success("Product created");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateProduct = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("products")
        .update({
          name: name.trim(),
          category_id: categoryId || null,
          description: description.trim() || null,
          supplier_name: supplier.trim() || null,
        })
        .eq("id", editing!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setEditing(null);
      toast.success("Product updated");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const archiveProduct = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("archive_record", { p_table: "products", p_record_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Product archived");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const restoreProduct = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("restore_record", { p_table: "products", p_record_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      toast.success("Product restored");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const hardDeleteProduct = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("hard_delete_record", { p_table: "products", p_record_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setDeleteTarget(null);
      toast.success("Product permanently deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const savePlan = useMutation({
    mutationFn: async () => {
      const payload = {
        product_id: planPanel!.id,
        plan_name: planName.trim(),
        purchase_type: planPurchaseType,
        duration_days: planDuration ? parseInt(planDuration) : null,
        warranty_days: planWarranty ? parseInt(planWarranty) : null,
        default_cost_price: parseFloat(planCost) || 0,
        default_selling_price: parseFloat(planSelling) || 0,
        optional_list_price: planListPrice ? parseFloat(planListPrice) : null,
        optional_stock_count: planStock ? parseInt(planStock) : null,
        is_active: planActive,
        created_by: profile?.id,
      };

      if (planEditing) {
        // Update plan — also record price history if prices changed
        if (isOwner && (planEditing.default_cost_price !== parseFloat(planCost) || planEditing.default_selling_price !== parseFloat(planSelling))) {
          const { error: histError } = await supabase.from("product_price_history").insert({
            product_plan_id: planEditing.id,
            previous_cost_price: planEditing.default_cost_price,
            new_cost_price: parseFloat(planCost) || 0,
            previous_selling_price: planEditing.default_selling_price,
            new_selling_price: parseFloat(planSelling) || 0,
            changed_by: profile?.id,
          });
          if (histError) throw histError;
        }
        const { error } = await supabase
          .from("product_plans")
          .update({
            plan_name: planName.trim(),
            purchase_type: planPurchaseType,
            duration_days: planDuration ? parseInt(planDuration) : null,
            warranty_days: planWarranty ? parseInt(planWarranty) : null,
            default_cost_price: parseFloat(planCost) || 0,
            default_selling_price: parseFloat(planSelling) || 0,
            optional_list_price: planListPrice ? parseFloat(planListPrice) : null,
            optional_stock_count: planStock ? parseInt(planStock) : null,
            is_active: planActive,
          })
          .eq("id", planEditing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("product_plans").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans", planPanel?.id] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      setPlanEditing(null);
      resetPlanForm();
      toast.success(planEditing ? "Plan updated" : "Plan created");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetForm = () => {
    setName("");
    setCategoryId("");
    setDescription("");
    setSupplier("");
  };

  const resetPlanForm = () => {
    setPlanName("");
    setPlanPurchaseType("one_time");
    setPlanDuration("");
    setPlanWarranty("");
    setPlanCost("");
    setPlanSelling("");
    setPlanListPrice("");
    setPlanStock("");
    setPlanActive(true);
  };

  const openEdit = (p: Product) => {
    setEditing(p);
    setName(p.name);
    setCategoryId(p.category_id ?? "");
    setDescription(p.description ?? "");
    setSupplier(p.supplier_name ?? "");
  };

  const openEditPlan = (plan: ProductPlan) => {
    setPlanEditing(plan);
    setPlanName(plan.plan_name);
    setPlanPurchaseType(plan.purchase_type);
    setPlanDuration(plan.duration_days?.toString() ?? "");
    setPlanWarranty(plan.warranty_days?.toString() ?? "");
    setPlanCost(plan.default_cost_price.toString());
    setPlanSelling(plan.default_selling_price.toString());
    setPlanListPrice(plan.optional_list_price?.toString() ?? "");
    setPlanStock(plan.optional_stock_count?.toString() ?? "");
    setPlanActive(plan.is_active);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) updateProduct.mutate();
    else createProduct.mutate();
  };

  const handlePlanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    savePlan.mutate();
  };

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Products & Plans"
          description="Manage your product catalog with multiple plans per product"
          actions={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? <EyeOff className="mr-1.5 h-4 w-4" /> : <Archive className="mr-1.5 h-4 w-4" />}
                {showArchived ? "Active" : "Archived"}
              </Button>
              <Button size="sm" onClick={() => { setCreateOpen(true); resetForm(); }}>
                <Plus className="mr-1.5 h-4 w-4" /> New Product
              </Button>
            </div>
          }
        />

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : !products || products.length === 0 ? (
          <EmptyState
            icon={<Package className="h-5 w-5" />}
            title="No products yet"
            description="Create your first product and add plans to it."
            action={
              <Button size="sm" className="mt-2" onClick={() => { setCreateOpen(true); resetForm(); }}>
                <Plus className="mr-1.5 h-4 w-4" /> New Product
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {products.map((p) => (
              <Card key={p.id} className={p.archived_at ? "opacity-50" : ""}>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    {p.category && (
                      <div
                        className="h-10 w-10 shrink-0 rounded-lg"
                        style={{ backgroundColor: p.category.colour + "20", border: `2px solid ${p.category.colour}` }}
                      />
                    )}
                    {!p.category && (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <Package className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{p.name}</p>
                        {!p.is_active && !p.archived_at && (
                          <StatusBadge status="inactive" label="inactive" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {p.category?.name ?? "Uncategorised"}
                        {p.supplier_name ? ` · ${p.supplier_name}` : ""}
                        {p.archived_at ? " · Archived" : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {!p.archived_at && !showArchived && (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => { setPlanPanel(p); resetPlanForm(); setPlanEditing(null); }}>
                          Plans <ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => archiveProduct.mutate(p.id)}>
                          <Archive className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                    {p.archived_at && showArchived && (
                      <>
                        <Button variant="ghost" size="icon" title="Restore" onClick={() => restoreProduct.mutate(p.id)}>
                          <ArchiveRestore className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Delete permanently" onClick={() => setDeleteTarget(p)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create/Edit product dialog */}
      <Dialog open={createOpen || !!editing} onOpenChange={(open) => { if (!open) { setCreateOpen(false); setEditing(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Product" : "New Product"}</DialogTitle>
            <DialogDescription>{editing ? "Update product details." : "Create a new product in your catalog."}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="prod-name">Product Name</Label>
              <Input id="prod-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="prod-category">Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="prod-category"><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {categories?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="prod-supplier">Supplier Name</Label>
              <Input id="prod-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Optional" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="prod-desc">Description</Label>
              <Textarea id="prod-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setCreateOpen(false); setEditing(null); }}>Cancel</Button>
              <Button type="submit" disabled={createProduct.isPending || updateProduct.isPending}>
                {editing ? "Save" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Plans slide-over */}
      <Sheet open={!!planPanel} onOpenChange={(open) => { if (!open) { setPlanPanel(null); setPlanEditing(null); } }}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{planPanel?.name} — Plans</SheetTitle>
            <SheetDescription>Add and manage plans for this product.</SheetDescription>
          </SheetHeader>

          {/* Plans list */}
          <div className="mt-4 flex flex-col gap-2">
            {plans?.map((plan) => (
              <div key={plan.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{plan.plan_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {plan.purchase_type === "recurring" ? "Recurring" : "One-time"}
                      {plan.duration_days ? ` · ${plan.duration_days} days` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" onClick={() => setPriceHistoryFor(plan)}>
                      <History className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => openEditPlan(plan)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex gap-4 text-xs">
                  <span className="text-muted-foreground">Cost: <span className="font-medium text-foreground">{formatMoney(plan.default_cost_price)}</span></span>
                  <span className="text-muted-foreground">Selling: <span className="font-medium text-foreground">{formatMoney(plan.default_selling_price)}</span></span>
                  {!plan.is_active && <StatusBadge status="inactive" label="inactive" />}
                </div>
              </div>
            ))}
            {(!plans || plans.length === 0) && (
              <p className="py-4 text-center text-sm text-muted-foreground">No plans yet. Add one below.</p>
            )}
          </div>

          {/* Plan form */}
          <form onSubmit={handlePlanSubmit} className="mt-4 flex flex-col gap-3 rounded-lg border p-4">
            <p className="text-sm font-medium">{planEditing ? "Edit Plan" : "Add Plan"}</p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="plan-name">Plan Name</Label>
              <Input id="plan-name" value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="e.g. 1 Year, 3 Months" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="plan-type">Purchase Type</Label>
                <Select value={planPurchaseType} onValueChange={(v) => setPlanPurchaseType(v as PurchaseType)}>
                  <SelectTrigger id="plan-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one_time">One-time</SelectItem>
                    <SelectItem value="recurring">Recurring</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="plan-duration">Duration (days)</Label>
                <Input id="plan-duration" type="number" min={0} value={planDuration} onChange={(e) => setPlanDuration(e.target.value)} placeholder="e.g. 365" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="plan-cost">Default Cost Price</Label>
                <Input id="plan-cost" type="number" min={0} step="0.01" value={planCost} onChange={(e) => setPlanCost(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="plan-selling">Default Selling Price</Label>
                <Input id="plan-selling" type="number" min={0} step="0.01" value={planSelling} onChange={(e) => setPlanSelling(e.target.value)} required />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="plan-list">List Price (optional)</Label>
                <Input id="plan-list" type="number" min={0} step="0.01" value={planListPrice} onChange={(e) => setPlanListPrice(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="plan-stock">Stock Count (optional)</Label>
                <Input id="plan-stock" type="number" min={0} value={planStock} onChange={(e) => setPlanStock(e.target.value)} />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="plan-warranty">Warranty (days)</Label>
              <Input id="plan-warranty" type="number" min={0} value={planWarranty} onChange={(e) => setPlanWarranty(e.target.value)} placeholder="Optional" />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="plan-active" checked={planActive} onCheckedChange={setPlanActive} />
              <Label htmlFor="plan-active">Active</Label>
            </div>
            {planEditing && isOwner && (
              <p className="text-xs text-muted-foreground">
                Changing default prices will record a price history entry. Existing sales are not affected.
              </p>
            )}
            <SheetFooter className="flex-row gap-2">
              <Button type="button" variant="outline" onClick={() => { setPlanEditing(null); resetPlanForm(); }}>Cancel</Button>
              <Button type="submit" disabled={savePlan.isPending}>{planEditing ? "Save" : "Add Plan"}</Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      {/* Price history dialog */}
      <Dialog open={!!priceHistoryFor} onOpenChange={(open) => !open && setPriceHistoryFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Price History — {priceHistoryFor?.plan_name}</DialogTitle>
            <DialogDescription>Chronological log of default price changes.</DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto">
            {priceHistory && priceHistory.length > 0 ? (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="text-left">
                    <th className="pb-2 pr-3 font-medium">Date</th>
                    <th className="pb-2 pr-3 font-medium">Prev Cost</th>
                    <th className="pb-2 pr-3 font-medium">New Cost</th>
                    <th className="pb-2 pr-3 font-medium">Prev Selling</th>
                    <th className="pb-2 font-medium">New Selling</th>
                  </tr>
                </thead>
                <tbody>
                  {priceHistory.map((h) => (
                    <tr key={h.id} className="border-t">
                      <td className="py-2 pr-3 text-muted-foreground">{formatDate(h.effective_at)}</td>
                      <td className="py-2 pr-3">{formatMoney(h.previous_cost_price)}</td>
                      <td className="py-2 pr-3 font-medium">{formatMoney(h.new_cost_price)}</td>
                      <td className="py-2 pr-3">{formatMoney(h.previous_selling_price)}</td>
                      <td className="py-2 font-medium">{formatMoney(h.new_selling_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">No price changes recorded.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Hard delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Permanently delete product?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. "{deleteTarget?.name}" and all its plans will be permanently removed. This only works if no sales reference this product. If they do, archive instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && hardDeleteProduct.mutate(deleteTarget.id)}
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
