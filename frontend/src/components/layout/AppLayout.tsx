import { useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  LayoutDashboard, Wallet, FileText, Package, ShoppingBag, ArrowLeftRight, BarChart3, Truck, Users, Settings as SettingsIcon,
  LogOut, Menu, Sun, Moon, Scissors, ScanLine, ClipboardCheck, Barcode, Contact, Gamepad2, Banknote, ScrollText, Scale, ReceiptText,
} from "lucide-react";
import { useMe } from "@/hooks/useMe";
import { ApiError, apiGet } from "@/lib/api";
import { configureFormats, errMsg } from "@/lib/format";
import { endSession } from "@/lib/session";
import type { Alerts, BarcodeLookup } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import Scanner from "@/components/Scanner";
import ProductDialog from "@/components/ProductDialog";
import MusicPlayer from "@/components/MusicPlayer";
import Assistant from "@/components/Assistant";

interface NavDef { to: string; label: string; icon: React.ComponentType<{ className?: string }>; id: string; inv?: boolean; badge?: boolean; approvals?: boolean; perm?: string }
const SECTIONS: { title: string; items: NavDef[] }[] = [
  { title: "Ledger", items: [
    { to: "/", label: "Dashboard", icon: LayoutDashboard, id: "dashboard" },
    { to: "/money", label: "Money & P&L", icon: Wallet, id: "money", perm: "txn:read" },
    { to: "/invoices", label: "Invoices", icon: FileText, id: "invoices", perm: "invoice:read" },
    { to: "/expenses", label: "Expenses", icon: ReceiptText, id: "expenses", perm: "txn:read" },
    { to: "/books", label: "Books & reports", icon: Scale, id: "books", perm: "report:read" },
    { to: "/cash-close", label: "Cash close", icon: Banknote, id: "cash-close", perm: "cashclose:read|cashclose:write" },
    { to: "/audit", label: "Audit & exports", icon: ScrollText, id: "audit", perm: "audit:read" },
  ] },
  { title: "Inventory", items: [
    { to: "/inventory", label: "Products", icon: Package, id: "inventory", inv: true, badge: true },
    { to: "/inventory/sell", label: "Quick sell", icon: ShoppingBag, id: "quick-sell", inv: true, perm: "stock:write" },
    { to: "/clients", label: "Clients", icon: Contact, id: "clients", inv: true, perm: "client:read" },
    { to: "/inventory/count", label: "Stock count", icon: ClipboardCheck, id: "stock-count", inv: true, perm: "stock:adjust" },
    { to: "/inventory/labels", label: "Barcode labels", icon: Barcode, id: "labels", inv: true, perm: "stock:write" },
    { to: "/inventory/movements", label: "Stock ledger", icon: ArrowLeftRight, id: "movements", inv: true },
    { to: "/inventory/reports", label: "Inventory reports", icon: BarChart3, id: "reports", inv: true },
  ] },
  { title: "Procurement", items: [
    { to: "/procurement", label: "Procurement", icon: Truck, id: "procurement", inv: true, approvals: true, perm: "po:read" },
  ] },
  { title: "Shop", items: [
    { to: "/team", label: "Team & commission", icon: Users, id: "team" },
    { to: "/settings", label: "Settings", icon: SettingsIcon, id: "settings", perm: "settings:read" },
  ] },
];

/** Keyboard-wedge scanners type fast and end with Enter; catch that anywhere outside a text field. */
export function useWedge(enabled: boolean, onCode: (c: string) => void) {
  const buf = useRef({ s: "", t: 0 });
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]")) return;
      const now = Date.now();
      if (now - buf.current.t > 60) buf.current.s = "";
      buf.current.t = now;
      if (e.key === "Enter") {
        if (buf.current.s.length >= 6) onCode(buf.current.s);
        buf.current.s = "";
      } else if (e.key.length === 1) buf.current.s += e.key;
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [enabled, onCode]);
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle("dark");
  try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch { /* ignore */ }
}

export default function AppLayout() {
  const { data: me, error, isLoading } = useMe();
  configureFormats(me);
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [, force] = useState(0);
  const inv = !!me?.inventory_enabled;
  const { data: alerts } = useQuery({ queryKey: ["alerts"], queryFn: () => apiGet<Alerts>("/inventory/alerts"), enabled: inv, refetchInterval: 60_000 });

  const lookup = async (code: string) => {
    setScanOpen(false);
    try {
      const r = await apiGet<BarcodeLookup>(`/inventory/products/barcode/${encodeURIComponent(code)}`);
      if (r.found && r.product) nav(`/inventory/products/${r.product.id}`);
      else { toast.info(`No product with code ${code} — create it now`); setNewCode(code); }
    } catch (e) { toast.error(errMsg(e)); }
  };
  useWedge(inv && loc.pathname !== "/inventory/count", (c) => void lookup(c));

  if (error instanceof ApiError && error.status === 401) return <Navigate to="/login" replace />;

  const sidebar = (
    <div className="flex h-full flex-col gap-6 py-5">
      <div className="flex items-center gap-2.5 px-4">
        <div className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground"><Scissors className="size-4" /></div>
        <div className="leading-tight">
          <div className="font-heading text-base font-semibold tracking-tight">Barber's Ledger</div>
          <div className="label-caps !text-[9px]">Books + stock</div>
        </div>
      </div>
      <nav className="flex flex-col gap-4 overflow-y-auto px-2">
        {SECTIONS.map((sec) => {
          const items = sec.items.filter((i) => (!i.inv || inv) && (!i.perm || i.perm.split("|").some((x) => me?.permissions.includes(x))));
          if (!items.length) return null;
          return (
            <div key={sec.title}>
              <div className="label-caps px-3 pb-1.5 !text-[9px]">{sec.title}</div>
              {items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === "/" || n.to === "/inventory"} onClick={() => setOpen(false)} data-testid={`nav-${n.id}`}
                  className={({ isActive }) => cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-150",
                    isActive ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-[inset_2px_0_0_var(--primary)]"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
                  <n.icon className="size-4 shrink-0" />
                  <span className="flex-1">{n.label}</span>
                  {n.approvals && !!alerts?.pending_approvals && (
                    <span data-testid="approval-alert-badge" title="Orders waiting for your approval" className="rounded-full bg-red-500 px-1.5 py-px font-mono text-[10px] font-semibold text-white">{alerts.pending_approvals}</span>
                  )}
                  {n.badge && !!alerts?.badge && (
                    <span data-testid="inventory-alert-badge" className="rounded-full bg-amber-500 px-1.5 py-px font-mono text-[10px] font-semibold text-white">{alerts.badge}</span>
                  )}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
      {inv && me && (
        <a href={`/play/${me.tenant_id}`} target="_blank" rel="noreferrer" data-testid="nav-game" className="mx-2 flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-foreground">
          <Gamepad2 className="size-4" /> Waiting-room game ↗
        </a>
      )}
      <div className="mt-auto px-3">
        <div className="rounded-lg border border-border bg-background/50 p-3">
          <div className="label-caps !text-[9px]">Workspace</div>
          <div data-testid="sidebar-tenant-name" className="mt-1 truncate text-sm font-medium">{me?.tenant_name ?? (isLoading ? "…" : "—")}</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-sidebar-border bg-sidebar lg:block">{sidebar}</aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-64 bg-sidebar p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur-xl md:px-8">
          <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setOpen(true)} data-testid="mobile-menu-button"><Menu /></Button>
          {inv && (
            <Button size="sm" onClick={() => setScanOpen(true)} data-testid="header-scan-button"><ScanLine /> Scan</Button>
          )}
          {me?.ai_enabled && me.permissions.includes("report:read") && <Assistant />}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" onClick={() => { toggleTheme(); force((x) => x + 1); }} data-testid="theme-toggle-button" aria-label="Toggle theme">
              <Sun className="hidden dark:block" /><Moon className="dark:hidden" />
            </Button>
            <div className="hidden text-right leading-tight sm:block">
              <div data-testid="topbar-user-name" className="text-sm font-medium">{me?.name ?? ""}</div>
              <div data-testid="topbar-user-role" className="label-caps !text-[9px]">{me?.role === "admin" ? "owner" : "barber"}</div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => endSession()} data-testid="logout-button" aria-label="Sign out"><LogOut /></Button>
          </div>
        </header>
        <main className="max-w-[1500px] p-3 sm:p-4 md:p-8">
          <Outlet />
        </main>
      </div>

      <Dialog open={scanOpen} onOpenChange={setScanOpen}>
        <DialogContent className="sm:max-w-md" data-testid="scan-dialog">
          <DialogHeader>
            <DialogTitle>Scan a product</DialogTitle>
            <DialogDescription>Point the camera at a barcode, or use a USB/Bluetooth scanner.</DialogDescription>
          </DialogHeader>
          {scanOpen && <Scanner onCode={(c) => void lookup(c)} />}
        </DialogContent>
      </Dialog>
      {inv && <MusicPlayer />}
      <ProductDialog open={newCode !== null} onOpenChange={(o) => !o && setNewCode(null)} initialBarcode={newCode ?? ""}
        onSaved={(p) => nav(`/inventory/products/${p.id}`)} />
    </div>
  );
}

/** Route guard: with the add-on off, inventory pages don't exist. */
export function InventoryGate({ children }: { children: React.ReactNode }) {
  const { data: me } = useMe();
  if (me && !me.inventory_enabled) return <Navigate to="/" replace />;
  if (!me) return null;
  return <>{children}</>;
}
