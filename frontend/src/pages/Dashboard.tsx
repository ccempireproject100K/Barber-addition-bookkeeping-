import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Hourglass, ShoppingBag, Truck } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiGet } from "@/lib/api";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { Dashboard as DashboardT, ExpiringLot, InventoryReport, ReorderSuggestion } from "@/lib/types";
import { useMe } from "@/hooks/useMe";
import { PageHeader, Panel, Pill, Stat, UrgencyBadge } from "@/components/Common";
import { buttonVariants } from "@/components/ui/button";
import InsightsCard from "@/components/InsightsCard";
import ApprovalsCard from "@/components/procurement/ApprovalsCard";
import { cn } from "@/lib/utils";

const tooltipStyle = { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 };

export default function Dashboard() {
  const { data: me } = useMe();
  const inv = !!me?.inventory_enabled;
  const { data: d } = useQuery({ queryKey: ["dashboard"], queryFn: () => apiGet<DashboardT>("/dashboard") });
  const { data: reorder = [] } = useQuery({ queryKey: ["reorder"], queryFn: () => apiGet<ReorderSuggestion[]>("/inventory/reorder"), enabled: inv });
  const { data: rep } = useQuery({ queryKey: ["inv-report", "", ""], queryFn: () => apiGet<InventoryReport>("/inventory/reports"), enabled: inv && !!me?.permissions.includes("report:read") });
  const expiring: ExpiringLot[] = rep?.expiring_lots ?? [];
  const w = d?.inventory;

  return (
    <div>
      <PageHeader eyebrow={me?.tenant_name} title="Today at the shop" subtitle="Money in, money out, and what's on the shelf.">
        {inv && (
          <Link to="/inventory/sell" className={buttonVariants({ size: "sm" })} data-testid="dashboard-quick-sell-link"><ShoppingBag /> Quick sell</Link>
        )}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Income this month" testId="stat-income-month" value={d ? fmtMoney(d.income_month) : "—"} />
        <Stat label="Expenses this month" testId="stat-expenses-month" value={d ? fmtMoney(d.expenses_month) : "—"} />
        <Stat label="Net this month" testId="stat-net-month" value={d ? fmtMoney(d.net_month) : "—"} tone={d && d.net_month < 0 ? "text-red-500" : undefined} />
        <Stat label="Unpaid invoices" testId="stat-outstanding" value={d ? fmtMoney(d.outstanding_invoices) : "—"} />
      </div>

      {w && (
        <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="inventory-widget">
          <Stat label="Retail sales (month)" testId="stat-retail-sales" value={fmtMoney(w.retail_sales_month)} sub={`${fmtMoney(w.retail_profit_month)} gross profit`} />
          <Stat label="Stock value at cost" testId="stat-stock-value" value={fmtMoney(w.stock_value)} />
          <Link to="/inventory?status=low" data-testid="stat-low-stock-link"><Stat label="Low / out of stock" testId="stat-low-stock" value={String(w.low_stock_count)} tone={w.low_stock_count ? "text-amber-500" : undefined} sub="Tap to see products" /></Link>
          <Link to="/inventory?expiring=1" data-testid="stat-expiring-link"><Stat label="Expiring lots" testId="stat-expiring" value={String(w.expiring_count)} tone={w.expiring_count ? "text-red-500" : undefined} sub="Within warning window" /></Link>
        </div>
      )}

      {inv && me?.permissions.includes("po:approve") && <ApprovalsCard />}
      {me?.ai_enabled && me.permissions.includes("report:read") && <InsightsCard />}

      <div className="mt-3 grid gap-3 xl:grid-cols-3">
        <Panel className="p-4 md:p-5 xl:col-span-2" data-testid="money-trend-chart">
          <h3 className="text-base font-semibold">Last 30 days</h3>
          <div className="mt-4 h-60">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={d?.trend ?? []} margin={{ left: -12, right: 4, top: 4 }}>
                <defs>
                  <linearGradient id="gInc" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} /><stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} /></linearGradient>
                  <linearGradient id="gExp" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.3} /><stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtMoney(v)} />
                <Area type="monotone" dataKey="income" name="Income" stroke="var(--chart-2)" fill="url(#gInc)" strokeWidth={2} />
                <Area type="monotone" dataKey="expenses" name="Expenses" stroke="var(--chart-1)" fill="url(#gExp)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel className="p-4 md:p-5" data-testid="recent-transactions">
          <div className="flex items-baseline justify-between">
            <h3 className="text-base font-semibold">Recent money</h3>
            <Link to="/money" className="text-xs text-primary hover:underline" data-testid="recent-transactions-view-all">All</Link>
          </div>
          <div className="mt-2 divide-y divide-border">
            {(d?.recent_transactions ?? []).map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm">{t.description || t.category}</div>
                  <div className="text-[11px] text-muted-foreground">{fmtDate(t.date)} · {t.category}{t.source === "inventory" ? " · stock" : ""}</div>
                </div>
                <span className={cn("font-mono text-sm tabular-nums", t.kind === "income" ? "text-emerald-600 dark:text-emerald-400" : "text-red-500")}>
                  {t.kind === "income" ? "+" : "−"}{fmtMoney(t.amount)}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {inv && (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <Panel className="p-4 md:p-5" data-testid="reorder-widget">
            <div className="flex items-baseline justify-between">
              <h3 className="flex items-center gap-2 text-base font-semibold"><Truck className="size-4" /> Reorder soon</h3>
              <Link to="/procurement" className="flex items-center gap-1 text-xs text-primary hover:underline" data-testid="reorder-widget-view-all">Procurement <ArrowRight className="size-3" /></Link>
            </div>
            <div className="mt-2 divide-y divide-border">
              {reorder.slice(0, 6).map((s) => (
                <Link key={s.product_id} to={`/inventory/products/${s.product_id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-muted/40" data-testid={`reorder-widget-row-${s.product_id}`}>
                  <div className="min-w-0">
                    <div className="truncate text-sm">{s.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{s.quantity_on_hand} left · order {s.suggested_qty} · {s.days_of_cover === null ? "no recent sales" : `${s.days_of_cover}d cover`}</div>
                  </div>
                  <UrgencyBadge urgency={s.urgency} />
                </Link>
              ))}
              {reorder.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Shelves look healthy.</p>}
            </div>
          </Panel>
          <Panel className="p-4 md:p-5" data-testid="expiring-widget">
            <h3 className="flex items-center gap-2 text-base font-semibold"><Hourglass className="size-4" /> Expiring soon</h3>
            <div className="mt-2 divide-y divide-border">
              {expiring.slice(0, 6).map((l) => (
                <Link key={l.lot_id} to={`/inventory/products/${l.product_id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-muted/40" data-testid={`expiring-row-${l.lot_number}`}>
                  <div className="min-w-0">
                    <div className="truncate text-sm">{l.product_name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">Lot {l.lot_number} · {l.quantity_on_hand} units · {fmtDate(l.expiry_date)}</div>
                  </div>
                  <Pill tone={l.days_left < 0 ? "danger" : "warning"} dot>{l.days_left < 0 ? `Expired ${-l.days_left}d` : `${l.days_left}d left`}</Pill>
                </Link>
              ))}
              {expiring.length === 0 && (
                <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><AlertTriangle className="size-4" /> Nothing expiring in the warning window.</p>
              )}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
