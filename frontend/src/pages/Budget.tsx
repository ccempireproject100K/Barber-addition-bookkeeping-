import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Plus, Trash2, TrendingUp } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { businessToday, errMsg, fmtMoney } from "@/lib/format";
import { can, useMe } from "@/hooks/useMe";
import { EmptyRow, Field, PageHeader, Panel } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface BudgetRow { id?: string; category: string; budgeted: number; actual: number; remaining: number; pct_used: number }
interface BudgetData { period: string; rows: BudgetRow[]; totals: { budgeted: number; actual: number; remaining: number } }
interface ForecastPoint { date: string; inflow: number; outflow: number; cash: number }
interface Forecast {
  start_date: string; days: number; start_cash: number; end_cash: number; min_cash: number; min_cash_date: string;
  avg_daily_inflow: number; avg_daily_outflow: number;
  scheduled: { ar: number; bills: number; recurring_inflow: number; recurring_outflow: number };
  points: ForecastPoint[]; assumptions: string[];
}

function VarianceBar({ pct }: { pct: number }) {
  const w = Math.min(pct, 100);
  const tone = pct > 100 ? "bg-red-500" : pct > 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" title={`${pct}% used`}>
      <div className={`h-full ${tone}`} style={{ width: `${w}%` }} />
    </div>
  );
}

export default function Budget() {
  const { data: me } = useMe();
  const write = can(me, "budget:write");
  const [period, setPeriod] = useState(businessToday().slice(0, 7));
  const [days, setDays] = useState(90);
  const [form, setForm] = useState({ category: "", amount: "" });

  const budgetQ = useQuery({ queryKey: ["budget", period], queryFn: () => apiGet<BudgetData>(`/budget?period=${period}`) });
  const catsQ = useQuery({ queryKey: ["budget-cats"], queryFn: () => apiGet<string[]>("/budget/categories") });
  const fcQ = useQuery({ queryKey: ["forecast", days], queryFn: () => apiGet<Forecast>(`/budget/forecast?days=${days}`) });

  const save = useMutation({
    mutationFn: () => apiPost("/budget", { period, category: form.category.trim(), amount: Number(form.amount) }),
    onSuccess: () => { toast.success("Budget saved"); setForm({ category: "", amount: "" }); budgetQ.refetch(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/budget/${id}`),
    onSuccess: () => { toast.success("Budget removed"); budgetQ.refetch(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const copy = useMutation({
    mutationFn: () => {
      const [y, m] = period.split("-").map(Number);
      const prev = new Date(y, m - 2, 1);
      const from = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
      return apiPost<{ copied: number }>("/budget/copy", { from_period: from, to_period: period });
    },
    onSuccess: (r) => { toast.success(`Copied ${r.copied} budgets`); budgetQ.refetch(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const rows = budgetQ.data?.rows ?? [];
  const fc = fcQ.data;
  const chartData = (fc?.points ?? []).filter((_, i) => i % Math.max(1, Math.floor((fc?.points.length ?? 1) / 90)) === 0);

  return (
    <div className="space-y-4">
      <PageHeader title="Budgets & cash forecast" subtitle="Monthly spending budgets with variance, plus a 30/60/90-day cash projection.">
        <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" data-testid="budget-period" />
      </PageHeader>

      <Panel className="p-4" data-testid="budget-table">
        <div className="mb-2 flex items-center justify-between">
          <div className="label-caps">Budgets — {period}</div>
          {write && <Button size="xs" variant="outline" onClick={() => copy.mutate()} disabled={copy.isPending}><Copy className="mr-1 size-3" /> Copy last month</Button>}
        </div>
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-2 font-medium">Category</th><th className="py-2 text-right font-medium">Budgeted</th>
            <th className="py-2 text-right font-medium">Actual</th><th className="py-2 text-right font-medium">Remaining</th>
            <th className="py-2 font-medium">Used</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category} className="border-b border-border/50" data-testid={`budget-row-${r.category}`}>
                <td className="py-2">{r.category}{!r.budgeted && r.actual > 0 && <span className="ml-1 text-xs text-amber-600">(no budget)</span>}</td>
                <td className="py-2 text-right font-mono">{fmtMoney(r.budgeted)}</td>
                <td className={`py-2 text-right font-mono ${r.pct_used > 100 ? "text-red-500 font-medium" : ""}`}>{fmtMoney(r.actual)}</td>
                <td className={`py-2 text-right font-mono ${r.remaining < 0 ? "text-red-500" : ""}`}>{fmtMoney(r.remaining)}</td>
                <td className="py-2"><div className="flex items-center gap-2"><VarianceBar pct={r.pct_used} /><span className="text-xs text-muted-foreground">{r.pct_used}%</span></div></td>
                <td className="py-2 text-right">{write && r.id && <Button size="icon-sm" variant="ghost" onClick={() => del.mutate(r.id!)}><Trash2 className="size-3" /></Button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6}><EmptyRow>No budgets or spending for this month yet.</EmptyRow></td></tr>}
          </tbody>
          {rows.length > 0 && (
            <tfoot><tr className="font-medium">
              <td className="py-2">Total</td>
              <td className="py-2 text-right font-mono">{fmtMoney(budgetQ.data!.totals.budgeted)}</td>
              <td className="py-2 text-right font-mono">{fmtMoney(budgetQ.data!.totals.actual)}</td>
              <td className="py-2 text-right font-mono">{fmtMoney(budgetQ.data!.totals.remaining)}</td>
              <td colSpan={2} />
            </tr></tfoot>
          )}
        </table>
        {write && (
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label="Category">
              <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-44" list="budget-cat-list" placeholder="e.g. Supplies" required />
              <datalist id="budget-cat-list">{(catsQ.data ?? []).map((c) => <option key={c} value={c} />)}</datalist>
            </Field>
            <Field label="Amount $"><Input type="number" step="0.01" min={0} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="w-32 font-mono" required /></Field>
            <Button size="sm" type="submit" disabled={save.isPending}><Plus className="mr-1 size-3" /> Set budget</Button>
          </form>
        )}
      </Panel>

      <Panel className="p-4" data-testid="forecast-panel">
        <div className="mb-2 flex items-center justify-between">
          <div className="label-caps flex items-center gap-1"><TrendingUp className="size-3" /> Cash forecast</div>
          <div className="flex gap-1">
            {[30, 60, 90].map((d) => (
              <Button key={d} size="xs" variant={days === d ? "default" : "outline"} onClick={() => setDays(d)}>{d}d</Button>
            ))}
          </div>
        </div>
        {fc && (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <div className="rounded-lg bg-muted/50 p-2"><div className="text-xs text-muted-foreground">Cash today</div><div className="font-mono font-medium">{fmtMoney(fc.start_cash)}</div></div>
              <div className="rounded-lg bg-muted/50 p-2"><div className="text-xs text-muted-foreground">Projected in {days}d</div><div className="font-mono font-medium">{fmtMoney(fc.end_cash)}</div></div>
              <div className="rounded-lg bg-muted/50 p-2"><div className="text-xs text-muted-foreground">Lowest point</div><div className="font-mono font-medium">{fmtMoney(fc.min_cash)} <span className="text-xs">({fc.min_cash_date})</span></div></div>
              <div className="rounded-lg bg-muted/50 p-2"><div className="text-xs text-muted-foreground">Scheduled AR / bills</div><div className="font-mono font-medium text-emerald-600">+{fmtMoney(fc.scheduled.ar)}</div><div className="font-mono text-xs text-red-500">−{fmtMoney(fc.scheduled.bills)}</div></div>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={30} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => fmtMoney(v).replace(/\.00$/, "")} width={70} />
                  <Tooltip formatter={(v: number) => fmtMoney(Number(v))} labelFormatter={(l) => `Date: ${l}`} />
                  <Area type="monotone" dataKey="cash" name="Projected cash" stroke="#10b981" fill="#10b981" fillOpacity={0.2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">Assumptions</div>
              <ul className="list-disc pl-4">{fc.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
              <p className="mt-1">Baseline: {fmtMoney(fc.avg_daily_inflow)}/day in, {fmtMoney(fc.avg_daily_outflow)}/day out (trailing 90d). Recurring: +{fmtMoney(fc.scheduled.recurring_inflow)} in, −{fmtMoney(fc.scheduled.recurring_outflow)} out.</p>
            </div>
          </>
        )}
        {fcQ.isLoading && <p className="text-sm text-muted-foreground">Projecting…</p>}
      </Panel>
    </div>
  );
}
