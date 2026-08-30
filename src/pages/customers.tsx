import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { PageContainer, PageHeader, EmptyState, StatusBadge } from "@/components/ui-shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Plus, Users, Search } from "lucide-react";
import { normalizePhone, formatDate } from "@/lib/format";
import type { Customer, CustomerType, AcquisitionSource, Profile } from "@/lib/types";

export function CustomersPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);

  // Form state
  const [fName, setFName] = useState("");
  const [fPhone, setFPhone] = useState("");
  const [fEmail, setFEmail] = useState("");
  const [fType, setFType] = useState<CustomerType>("retail");
  const [fSource, setFSource] = useState<AcquisitionSource>("WhatsApp");
  const [fNote, setFNote] = useState("");

  const { data: profiles } = useQuery({
    queryKey: ["profiles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("*");
      if (error) throw error;
      return data as Profile[];
    },
  });

  const { data: customers, isLoading } = useQuery({
    queryKey: ["customers", search, typeFilter],
    queryFn: async () => {
      let q = supabase
        .from("customers")
        .select("*")
        .is("archived_at", null)
        .order("created_at", { ascending: false });

      if (typeFilter !== "all") {
        q = q.eq("customer_type", typeFilter);
      }

      const { data, error } = await q;
      if (error) throw error;
      let result = data as Customer[];

      // Client-side search by name or phone (normalised)
      if (search.trim()) {
        const norm = normalizePhone(search);
        const lower = search.toLowerCase();
        result = result.filter(
          (c) =>
            (c.name?.toLowerCase().includes(lower) ?? false) ||
            c.phone_normalized.includes(norm) ||
            (c.phone_display?.includes(search) ?? false)
        );
      }

      return result;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const norm = normalizePhone(fPhone);
      if (!norm) throw new Error("Invalid phone number");

      // Check for existing
      const { data: existing } = await supabase
        .from("customers")
        .select("id")
        .eq("phone_normalized", norm)
        .maybeSingle();

      if (existing) {
        throw new Error("A customer with this phone number already exists.");
      }

      const { error } = await supabase.from("customers").insert({
        name: fName.trim() || null,
        phone_normalized: norm,
        phone_display: fPhone.trim(),
        email: fEmail.trim() || null,
        customer_type: fType,
        acquisition_source: fSource,
        internal_note: fNote.trim() || null,
        created_by: profile?.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setCreateOpen(false);
      resetForm();
      toast.success("Customer created");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetForm = () => {
    setFName("");
    setFPhone("");
    setFEmail("");
    setFType("retail");
    setFSource("WhatsApp");
    setFNote("");
  };

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Customers"
          description="Search and manage your customer base"
          actions={
            <Button size="sm" onClick={() => { setCreateOpen(true); resetForm(); }}>
              <Plus className="mr-1.5 h-4 w-4" /> New Customer
            </Button>
          }
        />

        {/* Filters */}
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or phone…"
              className="pl-9"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-full sm:w-40"><SelectValue placeholder="Type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="retail">Retail</SelectItem>
              <SelectItem value="reseller">Reseller</SelectItem>
              <SelectItem value="business">Business</SelectItem>
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
        ) : !customers || customers.length === 0 ? (
          <EmptyState
            icon={<Users className="h-5 w-5" />}
            title="No customers found"
            description="Create your first customer or adjust your search."
            action={
              <Button size="sm" className="mt-2" onClick={() => { setCreateOpen(true); resetForm(); }}>
                <Plus className="mr-1.5 h-4 w-4" /> New Customer
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {customers.map((c) => {
              const assigned = profiles?.find((p) => p.id === c.assigned_to);
              return (
                <Card key={c.id} className="cursor-pointer transition-colors hover:bg-muted/30">
                  <CardContent className="flex items-center justify-between p-3" onClick={() => navigate(`/customers/${c.id}`)}>
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                        {(c.name ?? "?")[0]?.toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium">{c.name ?? "Unnamed"}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.phone_display ?? c.phone_normalized}
                          {c.email ? ` · ${c.email}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="hidden text-right sm:block">
                        <p className="text-xs text-muted-foreground">Added {formatDate(c.created_at)}</p>
                        {assigned && <p className="text-xs text-muted-foreground">Assigned: {assigned.full_name}</p>}
                      </div>
                      <StatusBadge status={c.customer_type} />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Customer</DialogTitle>
            <DialogDescription>Add a new customer. Duplicate phone numbers are prevented.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => { e.preventDefault(); createMutation.mutate(); }}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="c-name">Name</Label>
              <Input id="c-name" value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Optional" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="c-phone">Phone Number</Label>
              <Input id="c-phone" value={fPhone} onChange={(e) => setFPhone(e.target.value)} placeholder="e.g. 9876543210" required autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="c-email">Email</Label>
              <Input id="c-email" type="email" value={fEmail} onChange={(e) => setFEmail(e.target.value)} placeholder="Optional" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="c-type">Customer Type</Label>
                <Select value={fType} onValueChange={(v) => setFType(v as CustomerType)}>
                  <SelectTrigger id="c-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="retail">Retail</SelectItem>
                    <SelectItem value="reseller">Reseller</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="c-source">Source</Label>
                <Select value={fSource} onValueChange={(v) => setFSource(v as AcquisitionSource)}>
                  <SelectTrigger id="c-source"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WhatsApp">WhatsApp</SelectItem>
                    <SelectItem value="Telegram">Telegram</SelectItem>
                    <SelectItem value="Website">Website</SelectItem>
                    <SelectItem value="Referral">Referral</SelectItem>
                    <SelectItem value="Reseller">Reseller</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="c-note">Internal Note</Label>
              <Input id="c-note" value={fNote} onChange={(e) => setFNote(e.target.value)} placeholder="Optional" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending}>Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
