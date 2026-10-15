import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Plus, Printer, Trash2, X } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { businessToday, errMsg, fmtMoney } from "@/lib/format";
import { can, useMe } from "@/hooks/useMe";
import { EmptyRow, Field, NativeSelect, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Deduction { label: string; kind: "percent" | "amount"; value: number; amount?: number }
interface RunItem {
  name: string; pay_type: "hourly" | "salary"; hours: number; rate: number; amount: number;
  deductions: Deduction[]; time_entry_ids: string[]; gross?: number; net?: number;
}
interface PayRun {
  id: string; schedule_id: string | null; period_start: string; period_end: string; notes: string;
  items: RunItem[]; totals: { gross: number; deductions: number; net: number }; status: string;
  disclaimer: string; created_by: string; created_at: string;
}
interface Schedule { id: string; name: string; frequency: string; next_run_date: string; active: boolean }
interface TimeEntryLite { id: string; user_id: string; user_name: string; date: string; hours: number; status: string; payroll_run_id: string | null }

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "info"> = { draft: "neutral", approved: "info", posted: "success" };

const blankRow = (): RunItem => ({ name: "", pay_type: "hourly", hours: 0, rate: 0, amount: 0, deductions: [], time_entry_ids: [] });

export default function Payroll() {
  const { data: me } = useMe();
  const write = can(me, "payroll:write");
  const [showNew, setShowNew] = useState(false);
  const [detail, setDetail] = useState<PayRun | null>(null);
  const [period, setPeriod] = useState({ start: businessToday(), end: businessToday() });
  const [rows, setRows] = useState<RunItem[]>([blankRow()]);
  const [sched, setSched] = useState({ name: "", frequency: "biweekly", next_run_date: businessToday() });
  const [picked, setPicked] = useState<string[]>([]);

  const schedQ = useQuery({ queryKey: ["pay-schedules"], queryFn: () => apiGet<Schedule[]>("/payroll/schedules") });
  const runsQ = useQuery({ queryKey: ["pay-runs"], queryFn: () => apiGet<PayRun[]>("/payroll/runs") });
  const timeQ = useQuery({ queryKey: ["pay-time-entries"], queryFn: () => apiGet<TimeEntryLite[]>("/time/entries"), enabled: showNew });
  const refresh = () => { schedQ.refetch(); runsQ.refetch(); };

  const saveSched = useMutation({
    mutationFn: () => apiPost<Schedule>("/payroll/schedules", sched),
    onSuccess: () => { toast.success("Schedule saved"); setSched({ name: "", frequency: "biweekly", next_run_date: businessToday() }); schedQ.refetch(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const delSched = useMutation({
    mutationFn: (id: string) => apiDelete(`/payroll/schedules/${id}`),
    onSuccess: () => { toast.success("Schedule deleted"); schedQ.refetch(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const createRun = useMutation({
    mutationFn: () => apiPost<PayRun>("/payroll/runs", {
      period_start: period.start, period_end: period.end, items: rows.filter((r) => r.name.trim()),
    }),
    onSuccess: (r) => { toast.success(`Pay run created — net ${fmtMoney(r.totals.net)}`); setShowNew(false); setRows([blankRow()]); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const approve = useMutation({
    mutationFn: (id: string) => apiPost<PayRun>(`/payroll/runs/${id}/approve`, {}),
    onSuccess: (r) => { toast.success("Run approved"); setDetail(r); runsQ.refetch(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const post = useMutation({
    mutationFn: (id: string) => apiPost<PayRun>(`/payroll/runs/${id}/post`, {}),
    onSuccess: (r) => { toast.success("Posted to the journal"); setDetail(r); runsQ.refetch(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const delRun = useMutation({
    mutationFn: (id: string) => apiDelete(`/payroll/runs/${id}`),
    onSuccess: () => { toast.success("Draft run deleted"); setDetail(null); runsQ.refetch(); }, onError: (e) => toast.error(errMsg(e)),
  });

  const setRow = (i: number, patch: Partial<RunItem>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addDed = (i: number) => setRow(i, { deductions: [...rows[i].deductions, { label: "", kind: "percent", value: 0 }] });
  const setDed = (i: number, k: number, patch: Partial<Deduction>) =>
    setRow(i, { deductions: rows[i].deductions.map((d, j) => (j === k ? { ...d, ...patch } : d)) });

  const availTime = (timeQ.data ?? []).filter((t) => t.status === "approved" && !t.payroll_run_id);
  const addTimeRows = () => {
    const sel = availTime.filter((t) => picked.includes(t.id));
    const byUser = new Map<string, { name: string; hours: number; ids: string[] }>();
    sel.forEach((t) => {
      const g = byUser.get(t.user_id) ?? { name: t.user_name, hours: 0, ids: [] };
      g.hours += t.hours; g.ids.push(t.id); byUser.set(t.user_id, g);
    });
    const newRows = [...byUser.values()].map((g) => ({ ...blankRow(), name: g.name, pay_type: "hourly" as const, hours: Math.round(g.hours * 100) / 100, time_entry_ids: g.ids }));
    setRows((rs) => [...rs.filter((r) => r.name.trim()), ...newRows]);
    setPicked([]);
  };

  const printStub = (run: PayRun, item: RunItem) => {
    const dedRows = (item.deductions ?? [])
      .map((d) => `<tr><td>${d.label}</td><td style="text-align:right">−${fmtMoney(d.amount ?? 0)}</td></tr>`).join("");
    const w = window.open("", "_blank", "width=480,height=640");
    if (!w) { toast.error("Allow popups to print the stub"); return; }
    w.document.write(`<!DOCTYPE html><html><head><title>Pay stub — ${item.name}</title>
      <style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#111}
      table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 0;border-bottom:1px solid #eee}
      .total td{border-top:2px solid #111;font-weight:700;font-size:16px}.mono{font-family:ui-monospace,monospace}
      .disc{font-size:11px;color:#666;margin-top:16px}</style></head><body>
      <h2 style="text-align:center;margin-bottom:0">Pay Stub</h2>
      <p style="text-align:center;color:#666;font-size:12px">${run.period_start} → ${run.period_end}</p>
      <h3>${item.name}</h3>
      <table><tr><td>Gross pay</td><td class="mono" style="text-align:right">${fmtMoney(item.gross ?? 0)}</td></tr>
      ${dedRows}
      <tr class="total"><td>Net pay</td><td class="mono" style="text-align:right">${fmtMoney(item.net ?? 0)}</td></tr></table>
      <p class="disc">Estimate only — not a tax document. Deductions labeled "withholding" were not filed with any tax authority.</p>
      <script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Payroll" subtitle="Pay schedules, gross-to-net runs, printable stubs.">
        {write && <Button size="sm" onClick={() => setShowNew((s) => !s)} data-testid="payroll-new-run"><Plus className="mr-1 size-4" /> New pay run</Button>}
      </PageHeader>

      <div className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="payroll-disclaimer">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <p><strong>Payroll-lite scope:</strong> estimates only — it does <strong>not</strong> withhold or file taxes and does <strong>not</strong> run direct deposit. For compliant payroll, use a provider like Gusto or Check (partnership stub below).</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel className="p-4" data-testid="payroll-schedules">
          <div className="label-caps mb-2">Pay schedules</div>
          <div className="space-y-1 text-sm">
            {(schedQ.data ?? []).map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2">
                <span>{s.name} <span className="text-muted-foreground">· {s.frequency} · next {s.next_run_date}</span></span>
                {write && <Button size="icon-sm" variant="ghost" onClick={() => delSched.mutate(s.id)}><Trash2 className="size-3" /></Button>}
              </div>
            ))}
            {(schedQ.data ?? []).length === 0 && <p className="text-muted-foreground">No schedules yet.</p>}
          </div>
          {write && (
            <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); saveSched.mutate(); }}>
              <Field label="Name"><Input value={sched.name} onChange={(e) => setSched({ ...sched, name: e.target.value })} className="w-36" required placeholder="e.g. Barbers" /></Field>
              <Field label="Frequency">
                <NativeSelect value={sched.frequency} onChange={(e) => setSched({ ...sched, frequency: e.target.value })} className="w-32">
                  <option value="weekly">Weekly</option><option value="biweekly">Biweekly</option>
                  <option value="semimonthly">Semimonthly</option><option value="monthly">Monthly</option>
                </NativeSelect>
              </Field>
              <Field label="Next run"><Input type="date" value={sched.next_run_date} onChange={(e) => setSched({ ...sched, next_run_date: e.target.value })} className="w-40" /></Field>
              <Button size="sm" type="submit" disabled={saveSched.isPending}>Add</Button>
            </form>
          )}
        </Panel>
        <Panel className="p-4" data-testid="payroll-provider">
          <div className="label-caps mb-2">Payroll provider</div>
          <div className="grid gap-2 text-sm">
            <div className="flex items-center justify-between rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
              <span><strong>Manual</strong> <span className="text-muted-foreground">— this app (estimates only)</span></span>
              <Pill tone="success">Active</Pill>
            </div>
            {[["Gusto", "Full-service payroll: withholding, filing, direct deposit"], ["Check", "Embedded payroll API"]].map(([n, d]) => (
              <div key={n} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 opacity-70">
                <span><strong>{n}</strong> <span className="text-muted-foreground">— {d}</span></span>
                <Pill tone="neutral">Coming soon</Pill>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Partnership stub: when a provider is connected, runs here will hand off tax filing and direct deposit automatically.</p>
        </Panel>
      </div>

      {showNew && write && (
        <Panel className="p-4" data-testid="payroll-new-form">
          <div className="label-caps mb-2">New pay run</div>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <Field label="Period start"><Input type="date" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} className="w-40" /></Field>
            <Field label="Period end"><Input type="date" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} className="w-40" /></Field>
          </div>
          {availTime.length > 0 && (
            <div className="mb-3 rounded-lg bg-muted/50 p-3">
              <div className="mb-1 text-xs font-medium">Pull from approved time entries</div>
              <div className="flex flex-wrap gap-2 text-xs">
                {availTime.map((t) => (
                  <label key={t.id} className="flex items-center gap-1 rounded border border-border px-2 py-1">
                    <input type="checkbox" checked={picked.includes(t.id)} onChange={() => setPicked((p) => (p.includes(t.id) ? p.filter((x) => x !== t.id) : [...p, t.id]))} />
                    {t.user_name} · {t.date} · {t.hours}h
                  </label>
                ))}
              </div>
              <Button size="xs" variant="outline" className="mt-2" disabled={!picked.length} onClick={addTimeRows}>Add as pay rows</Button>
            </div>
          )}
          {rows.map((r, i) => (
            <div key={i} className="mb-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Name"><Input value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} className="w-36" /></Field>
                <Field label="Type">
                  <NativeSelect value={r.pay_type} onChange={(e) => setRow(i, { pay_type: e.target.value as "hourly" | "salary" })} className="w-28">
                    <option value="hourly">Hourly</option><option value="salary">Salary</option>
                  </NativeSelect>
                </Field>
                {r.pay_type === "hourly" ? (
                  <>
                    <Field label="Hours"><Input type="number" step="0.25" min={0} value={r.hours} onChange={(e) => setRow(i, { hours: Number(e.target.value) })} className="w-24 font-mono" /></Field>
                    <Field label="Rate $"><Input type="number" step="0.01" min={0} value={r.rate} onChange={(e) => setRow(i, { rate: Number(e.target.value) })} className="w-24 font-mono" /></Field>
                  </>
                ) : (
                  <Field label="Amount $"><Input type="number" step="0.01" min={0} value={r.amount} onChange={(e) => setRow(i, { amount: Number(e.target.value) })} className="w-28 font-mono" /></Field>
                )}
                <Button size="icon-sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><X className="size-3" /></Button>
              </div>
              <div className="mt-2 space-y-1">
                {r.deductions.map((d, k) => (
                  <div key={k} className="flex flex-wrap items-end gap-2 text-xs">
                    <Field label="Deduction label"><Input value={d.label} onChange={(e) => setDed(i, k, { label: e.target.value })} className="w-40" placeholder="e.g. Federal withholding (est.)" /></Field>
                    <Field label="Kind">
                      <NativeSelect value={d.kind} onChange={(e) => setDed(i, k, { kind: e.target.value as "percent" | "amount" })} className="w-24">
                        <option value="percent">%</option><option value="amount">$</option>
                      </NativeSelect>
                    </Field>
                    <Field label="Value"><Input type="number" step="0.01" min={0} value={d.value} onChange={(e) => setDed(i, k, { value: Number(e.target.value) })} className="w-24 font-mono" /></Field>
                    <Button size="icon-sm" variant="ghost" onClick={() => setRow(i, { deductions: r.deductions.filter((_, j) => j !== k) })}><X className="size-3" /></Button>
                  </div>
                ))}
                <Button size="xs" variant="ghost" onClick={() => addDed(i)}>+ deduction</Button>
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setRows((rs) => [...rs, blankRow()])}>+ employee</Button>
            <Button size="sm" onClick={() => createRun.mutate()} disabled={createRun.isPending || !rows.some((r) => r.name.trim())} data-testid="payroll-create-run">Create draft run</Button>
          </div>
        </Panel>
      )}

      <Panel className="overflow-hidden" data-testid="payroll-runs">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">Period</th><th className="px-4 py-2 text-right font-medium">Gross</th>
            <th className="px-4 py-2 text-right font-medium">Deductions</th><th className="px-4 py-2 text-right font-medium">Net</th>
            <th className="px-4 py-2 font-medium">Status</th><th className="px-4 py-2"></th>
          </tr></thead>
          <tbody>
            {(runsQ.data ?? []).map((r) => (
              <tr key={r.id} className="border-b border-border">
                <td className="px-4 py-2">{r.period_start} → {r.period_end} <span className="text-xs text-muted-foreground">({r.items.length} people)</span></td>
                <td className="px-4 py-2 text-right font-mono">{fmtMoney(r.totals.gross)}</td>
                <td className="px-4 py-2 text-right font-mono">{fmtMoney(r.totals.deductions)}</td>
                <td className="px-4 py-2 text-right font-mono font-medium">{fmtMoney(r.totals.net)}</td>
                <td className="px-4 py-2"><Pill tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Pill></td>
                <td className="px-4 py-2 text-right"><Button size="xs" variant="outline" onClick={() => setDetail(r)}>Open</Button></td>
              </tr>
            ))}
            {(runsQ.data ?? []).length === 0 && <tr><td colSpan={6}><EmptyRow>No pay runs yet.</EmptyRow></td></tr>}
          </tbody>
        </table>
      </Panel>

      {detail && (
        <Panel className="p-4" data-testid="payroll-detail">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-medium">Pay run {detail.period_start} → {detail.period_end} <Pill tone={STATUS_TONE[detail.status] ?? "neutral"}>{detail.status}</Pill></div>
            <Button size="xs" variant="ghost" onClick={() => setDetail(null)}><X className="size-3" /></Button>
          </div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-1 font-medium">Employee</th><th className="py-1 text-right font-medium">Gross</th>
              <th className="py-1 text-right font-medium">Deductions</th><th className="py-1 text-right font-medium">Net</th><th></th>
            </tr></thead>
            <tbody>
              {detail.items.map((it, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-1">{it.name} <span className="text-xs text-muted-foreground">{it.pay_type === "hourly" ? `${it.hours}h × ${fmtMoney(it.rate)}` : "salary"}</span></td>
                  <td className="py-1 text-right font-mono">{fmtMoney(it.gross ?? 0)}</td>
                  <td className="py-1 text-right font-mono">{fmtMoney((it.deductions ?? []).reduce((s, d) => s + (d.amount ?? 0), 0))}</td>
                  <td className="py-1 text-right font-mono font-medium">{fmtMoney(it.net ?? 0)}</td>
                  <td className="py-1 text-right"><Button size="xs" variant="ghost" onClick={() => printStub(detail, it)}><Printer className="mr-1 size-3" /> Stub</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex gap-2">
            {write && detail.status === "draft" && <Button size="sm" onClick={() => approve.mutate(detail.id)}>Approve run</Button>}
            {write && detail.status === "approved" && <Button size="sm" onClick={() => post.mutate(detail.id)}>Post to journal</Button>}
            {write && detail.status === "draft" && <Button size="sm" variant="ghost" onClick={() => delRun.mutate(detail.id)}>Delete draft</Button>}
          </div>
        </Panel>
      )}

    </div>
  );
}
