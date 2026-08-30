import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  PlusCircle,
  ShoppingCart,
  Users,
  Tag,
  Package,
  FlaskConical,
  LogOut,
  Bell,
  Search,
  Menu,
  Moon,
  Sun,
  RefreshCw,
  BarChart3,
  Download,
  RotateCcw,
  KeyRound,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

interface NavItem {
  label: string;
  to: string;
  icon: ReactNode;
  ownerOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", to: "/", icon: <LayoutDashboard className="h-4 w-4" /> },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "New Sale", to: "/sales/new", icon: <PlusCircle className="h-4 w-4" /> },
      { label: "Sales", to: "/sales", icon: <ShoppingCart className="h-4 w-4" /> },
      { label: "Renewals", to: "/renewals", icon: <RefreshCw className="h-4 w-4" /> },
      { label: "Customers", to: "/customers", icon: <Users className="h-4 w-4" /> },
    ],
  },
  {
    label: "Catalog",
    items: [
      { label: "Products & Plans", to: "/products", icon: <Package className="h-4 w-4" /> },
      { label: "Categories", to: "/categories", icon: <Tag className="h-4 w-4" /> },
    ],
  },
  {
    label: "Finance",
    items: [
      { label: "Financial Reports", to: "/finance/reports", icon: <BarChart3 className="h-4 w-4" /> },
      { label: "Refunds", to: "/finance/refunds", icon: <RotateCcw className="h-4 w-4" /> },
      { label: "Export Data", to: "/finance/export", icon: <Download className="h-4 w-4" /> },
    ],
  },
  {
    label: "Tools",
    items: [
      { label: "Demo Data", to: "/demo", icon: <FlaskConical className="h-4 w-4" /> },
      { label: "Integrations", to: "/integrations", icon: <KeyRound className="h-4 w-4" />, ownerOnly: true },
    ],
  },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const { isOwner } = useAuth();

  return (
    <nav className="flex flex-col gap-4 px-3 py-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          <p className="px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {group.label}
          </p>
          {group.items
            .filter((item) => !item.ownerOnly || isOwner)
            .map((item) => {
              const active =
                item.to === "/"
                  ? location.pathname === "/"
                  : location.pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                  )}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}
        </div>
      ))}
    </nav>
  );
}

function UserMenu() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2">
          <Avatar className="h-7 w-7">
            <AvatarFallback className="bg-primary/10 text-primary text-xs">
              {initials(profile?.full_name)}
            </AvatarFallback>
          </Avatar>
          <div className="hidden flex-col items-start sm:flex">
            <span className="text-sm font-medium leading-tight">
              {profile?.full_name ?? "User"}
            </span>
            <span className="text-xs capitalize text-muted-foreground">
              {profile?.role ?? ""}
            </span>
          </div>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="flex flex-col">
          <span>{profile?.full_name}</span>
          <span className="text-xs font-normal capitalize text-muted-foreground">
            {profile?.role}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            void signOut();
            navigate("/login");
          }}
          className="text-destructive focus:text-destructive"
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      title="Toggle theme"
    >
      <Sun className="h-4 w-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
      <Moon className="absolute h-4 w-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
    </Button>
  );
}

function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (query.trim()) {
          navigate(`/customers?q=${encodeURIComponent(query.trim())}`);
        }
      }}
      className="relative hidden md:block"
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search customer or phone…"
        className="w-64 pl-9"
      />
    </form>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
            DX
          </div>
          <span className="text-base font-semibold tracking-tight text-sidebar-foreground">
            DigiXO Desk
          </span>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <NavLinks />
        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-4">
          {/* Mobile menu */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex h-14 items-center gap-2 border-b px-5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
                  DX
                </div>
                <span className="text-base font-semibold">DigiXO Desk</span>
              </div>
              <NavLinks onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>

          <GlobalSearch />

          <div className="flex-1" />

          {/* Quick New Sale */}
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => navigate("/sales/new")}
          >
            <PlusCircle className="h-4 w-4" />
            <span className="hidden sm:inline">New Sale</span>
          </Button>

          {/* Notification (prepared for future) */}
          <Button variant="ghost" size="icon" className="relative">
            <Bell className="h-4 w-4" />
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary/60" />
          </Button>

          <ThemeToggle />

          <UserMenu />
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          {children}
        </main>
      </div>
    </div>
  );
}
