import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  LayoutDashboard,
  PlusCircle,
  ShoppingCart,
  Users,
  RefreshCw,
  Package,
  Tag,
  BarChart3,
  RotateCcw,
  Download,
  FlaskConical,
  KeyRound,
  Settings,
  Search,
  User,
  Receipt,
} from "lucide-react";
import type { Customer, Sale } from "@/lib/types";

const NAV_ITEMS = [
  { label: "Dashboard", to: "/", icon: LayoutDashboard, hint: "Go to dashboard" },
  { label: "New Sale", to: "/sales/new", icon: PlusCircle, hint: "Create a new sale" },
  { label: "Sales", to: "/sales", icon: ShoppingCart, hint: "View all sales" },
  { label: "Renewals", to: "/renewals", icon: RefreshCw, hint: "Manage renewals" },
  { label: "Customers", to: "/customers", icon: Users, hint: "View all customers" },
  { label: "Products & Plans", to: "/products", icon: Package, hint: "Manage products" },
  { label: "Categories", to: "/categories", icon: Tag, hint: "Manage categories" },
  { label: "Financial Reports", to: "/finance/reports", icon: BarChart3, hint: "View reports" },
  { label: "Refunds", to: "/finance/refunds", icon: RotateCcw, hint: "Manage refunds" },
  { label: "Export Data", to: "/finance/export", icon: Download, hint: "Export data" },
  { label: "Demo Data", to: "/demo", icon: FlaskConical, hint: "Manage demo data" },
  { label: "Integrations", to: "/integrations", icon: KeyRound, hint: "API keys" },
  { label: "Settings", to: "/settings", icon: Settings, hint: "User preferences" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim() || q.trim().length < 2) {
      setCustomers([]);
      setSales([]);
      return;
    }
    const lower = q.toLowerCase();
    const [custRes, saleRes] = await Promise.all([
      supabase
        .from("customers")
        .select("*")
        .or(`name.ilike.%${lower}%,phone_normalized.ilike.%${lower.replace(/\s/g, "")}%`)
        .limit(5),
      supabase
        .from("sales")
        .select("*, customer:customers(*)")
        .or(`sale_number.ilike.%${lower}%`)
        .order("sale_date", { ascending: false })
        .limit(5),
    ]);
    if (!custRes.error) setCustomers(custRes.data as Customer[]);
    if (!saleRes.error) setSales(saleRes.data as Sale[]);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => doSearch(search), 250);
    return () => clearTimeout(t);
  }, [search, doSearch]);

  const go = (path: string) => {
    navigate(path);
    setOpen(false);
    setSearch("");
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch("");
      }}
    >
      <CommandInput
        placeholder="Search pages, customers, sales…"
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {!search.trim() && (
          <>
            <CommandGroup heading="Quick Actions">
              <CommandItem onSelect={() => go("/sales/new")}>
                <PlusCircle className="h-4 w-4" />
                <span>New Sale</span>
                <span className="ml-auto text-xs text-muted-foreground">N</span>
              </CommandItem>
              <CommandItem onSelect={() => go("/customers")}>
                <Users className="h-4 w-4" />
                <span>Customers</span>
              </CommandItem>
              <CommandItem onSelect={() => go("/sales")}>
                <ShoppingCart className="h-4 w-4" />
                <span>Sales</span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Navigate">
              {NAV_ITEMS.map((item) => (
                <CommandItem key={item.to} onSelect={() => go(item.to)}>
                  <item.icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {search.trim() && customers.length > 0 && (
          <CommandGroup heading="Customers">
            {customers.map((c) => (
              <CommandItem
                key={c.id}
                onSelect={() => go(`/customers/${c.id}`)}
              >
                <User className="h-4 w-4" />
                <span>{c.name ?? "Unnamed"}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {c.phone_display ?? c.phone_normalized}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {search.trim() && sales.length > 0 && (
          <CommandGroup heading="Sales">
            {sales.map((s) => (
              <CommandItem
                key={s.id}
                onSelect={() => go(`/sales?id=${s.id}`)}
              >
                <Receipt className="h-4 w-4" />
                <span>{s.sale_number}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {s.customer?.name ?? "Unnamed"}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {search.trim() && customers.length === 0 && sales.length === 0 && (
          <CommandGroup heading="Search">
            <CommandItem onSelect={() => go(`/customers?q=${encodeURIComponent(search)}`)}>
              <Search className="h-4 w-4" />
              <span>Search customers for "{search}"</span>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
