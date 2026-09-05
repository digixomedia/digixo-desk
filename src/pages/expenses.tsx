import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { PageContainer, PageHeader, EmptyState } from "@/components/ui-shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { toast } from "sonner";
import { Plus, Receipt, Pencil, Trash2, IndianRupee } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/format";
import type { Expense } from "@/lib/types";

const CATEGORIES = [
  "Product Cost",
  "Software",
  "Marketing",
  "Operations",
  "Salary",
  "Rent",
  "Utilities",
  "Travel",
  "Other",
];

export function ExpensesPage() {
  const { isOwner } = useAuth();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const [fDate, setFDate] = useState(new Date().toISOString().slice(0, 10));
  const [fCategory, setFCategory] = useState(CATEGORIES[0]);
  const [fAmount, setFAmount] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [fMethod, setFMethod] = useState("");
  const [fReference, setFReference] = useState("");

  const { data: expenses, isLoading } = useQuery({
    queryKey: ["expenses", categoryFilter],
    queryFn: async () => {
      let q = supabase
        .from("expenses")
        .select("*")
        .is("archived_at", null)
        .order("expense_date", { ascending: false });

      if (categoryFilter !== "all") {
        q = q.eq("category", categoryFilter);
      }

      const { data, error } = await q;
      if (error) throw error;
      return data as Expense[];
    },
    enabled: isOwner,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const amount = parseFloat(fAmount);
      if (!amount || amount <= 0) throw new Error("Enter a valid amount");
      const { error } = await supabase.from("expenses").insert({
        expense_date: fDate,
        category: fCategory,
        amount,
        description: fDescription.trim() || null,
        payment_method: fMethod || null,
        reference: fReference.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-financial-stats"] });
      setCreateOpen(false);
      resetForm();
      toast.success("Expense added");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      const amount = parseFloat(fAmount);
      if (!amount || amount <= 0) throw new Error("Enter a valid amount");
      const { error } = await supabase
        .from("expenses")
        .update({
          expense_date: fDate,
          category: fCategory,
          amount,
          description: fDescription.trim() || null,
          payment_method: fMethod || null,
          reference: fReference.trim() || null,
        })
        .eq("id", editing!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-financial-stats"] });
      setEditing(null);
      toast.success("Expense updated");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("hard_delete_record", {
        p_table: "expenses",
        p_record_id: id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-financial-stats"] });
      setDeleteTarget(null);
      toast.success("Expense deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetForm = () => {
    setFDate(new Date().toISOString().slice(0, 10));
    setFCategory(CATEGORIES[0]);
    setFAmount("");
    setFDescription("");
    setFMethod("");
    setFReference("");
  };

  const openEdit = (e: Expense) => {
    setEditing(e);
    setFDate(e.expense_date);
    setFCategory(e.category);
    setFAmount(e.amount.toString());
    setFDescription(e.description ?? "");
    setFMethod(e.payment_method ?? "");
    setFReference(e.reference ?? "");
  };

  const handleSubmit = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (editing) updateMutation.mutate();
    else createMutation.mutate();
  };

  const totalAmount = expenses?.reduce((sum, e) => sum + e.amount, 0) ?? 0;

  if (!isOwner) {
    return (
      <PageContainer>
        <EmptyState
          icon={<Receipt className="h-5 w-5" />}
          title="Owner access required"
          description="Only the owner can view and manage expenses."
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Expenses"
          description="Track business expenses to calculate net profit accurately"
          actions={
            <Button size="sm" onClick={() => { setCreateOpen(true); resetForm(); }}>
              <Plus className="mr-1.5 h-4 w-4" /> Add Expense
            </Button>
          }
        />

        {/* Summary + filter */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-4 py-3">
            <IndianRupee className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Total:</span>
            <span className="text-sm font-semibold">{formatMoney(totalAmount)}</span>
            <span className="ml-2 text-xs text-muted-foreground">({expenses?.length ?? 0} records)</span>
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-full sm:w-48"><SelectValue placeholder="All Categories" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* List */}
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : !expenses || expenses.length === 0 ? (
          <EmptyState
            icon={<Receipt className="h-5 w-5" />}
            title="No expenses recorded"
            description="Add your first expense to start tracking net profit."
            action={
              <Button size="sm" className="mt-2" onClick={() => { setCreateOpen(true); resetForm(); }}>
                <Plus className="mr-1.5 h-4 w-4" /> Add Expense
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {expenses.map((e) => (
              <Card key={e.id}>
                <CardContent className="flex items-center justify-between p-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
                      <Receipt className="h-5 w-5 text-destructive" />
                    </div>
                    <div>
                      <p className="font-medium">{e.category}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(e.expense_date)}
                        {e.description ? ` · ${e.description}` : ""}
                        {e.payment_method ? ` · ${e.payment_method}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-destructive">{formatMoney(e.amount)}</span>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(e)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(e)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create/Edit dialog */}
      <Dialog open={createOpen || !!editing} onOpenChange={(open) => { if (!open) { setCreateOpen(false); setEditing(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Expense" : "Add Expense"}</DialogTitle>
            <DialogDescription>
              {editing ? "Update expense details." : "Record a new business expense."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="exp-date">Date</Label>
                <Input id="exp-date" type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="exp-category">Category</Label>
                <Select value={fCategory} onValueChange={setFCategory}>
                  <SelectTrigger id="exp-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="exp-amount">Amount</Label>
              <Input id="exp-amount" type="number" min={0} step="0.01" value={fAmount} onChange={(e) => setFAmount(e.target.value)} placeholder="0.00" required autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="exp-desc">Description</Label>
              <Textarea id="exp-desc" value={fDescription} onChange={(e) => setFDescription(e.target.value)} rows={2} placeholder="Optional" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="exp-method">Payment Method</Label>
                <Select value={fMethod} onValueChange={setFMethod}>
                  <SelectTrigger id="exp-method"><SelectValue placeholder="Optional" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UPI">UPI</SelectItem>
                    <SelectItem value="Bank Transfer">Bank Transfer</SelectItem>
                    <SelectItem value="Cash">Cash</SelectItem>
                    <SelectItem value="Card">Card</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="exp-ref">Reference</Label>
                <Input id="exp-ref" value={fReference} onChange={(e) => setFReference(e.target.value)} placeholder="Optional" />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setCreateOpen(false); setEditing(null); }}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                {editing ? "Save" : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete expense?</AlertDialogTitle>
            <AlertDialogDescription>
              This expense of {formatMoney(deleteTarget?.amount ?? 0)} for {deleteTarget?.category} will be permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
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
