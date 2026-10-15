import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock, Play, Square, Plus } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { businessToday, errMsg } from "@/lib/format";
import { can, useMe } from "@/hooks/useMe";
import { EmptyRow, Field, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface TimeEntry {
  id: string; user_id: string; user_name: string; date: string;
  clock_in: string | null; clock_out: string | null; hours: number;
  client_name: string; note: string; billable: boolean; status: string;
  invoice_id: string | null; approved_by: string | null; created_at: string;
}
interface TimeSummary {
  total_hours: number; unbilled_hours: number;
  by_staff: { name: string; hours: number; billable: number }[];
  by_client: { client: string; hours: number }[];
}

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "info"> = {
  open: "info", logged: "warning", approved: "success", billed: "success", void: "neutral",
};

function elapsedSince(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

export default function Time() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [invClient, setInvClient] = useState("");
  const [invRate, setInvRate] = useState("");
  const [m, setM] = useState({ date: businessToday(), hours: "", client_name: "", note: "", billable: true });

  const entriesQ = useQuery({ queryKey: ["time-entries"], queryFn: () => apiGet<TimeEntry[]>("/time/entries") });
  const summaryQ = useQuery({ queryKey: ["time-summary"], queryFn: () => apiGet<TimeSummary>("/time/summary") });
  const entries = entriesQ.data ?? [];
  const open = entries.find((e) => e.status === "open" && e.user_id === me?.user_id);
  const canApprove = can(me, "time:approve");
  const canWrite = can(me, "time:write");

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, [open?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => { entriesQ.refetch(); summaryQ.refetch(); };

  const clockIn = useMutation({
    mutationFn: () => apiPost<TimeEntry>("/time/clock-in", {}),
    onSuccess: () => { toast.success("Clocked in"); refresh(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const clockOut = useMutation({
    mutationFn: () => apiPost<TimeEntry>("/time/clock-out", {}),
    onSuccess: (e) => { toast.success(`Clocked out — ${e.hours}h logged`); refresh(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const addManual = useMutation({
    mutationFn: () => apiPost<TimeEntry>("/time/entries", { ...m, hours: Number(m.hours) }),
    onSuccess: () => { toast.success("Time logged"); setM({ date: businessToday(), hours: "", client_name: "", note: "", billable: true }); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const approve = useMutation({
    mutationFn: (id: string) => apiPost(`/time/entries/${id}/approve`, {}),
    onSuccess: () => { toast.success("Approved"); refresh(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const voidEntry = useMutation({
    mutationFn: (id: string) => apiDelete(`/time/entries/${id}`),
    onSuccess: () => { toast.success("Entry voided"); refresh(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const toInvoice = useMutation({
    mutationFn: () => apiPost<{ invoice_id: string; number: string; entries: number }>("/time/to-invoice",
      { entry_ids: selected, client_name: invClient, rate: Number(invRate) }),
    onSuccess: (r) => { toast.success(`Invoice ${r.number} created from ${r.entries} entries`); setSelected([]); setInvClient(""); setInvRate(""); refresh(); void qc.invalidateQueries({ queryKey: ["invoices"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const toggleSel = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const billable = entries.filter((e) => e.status === "approved" && e.billable && !e.invoice_id);

  return (
    <div className="space-y-4">
      <PageHeader title="Time tracking" subtitle="Clock in/out, log hours, approve timesheets, and bill time to invoices." />

      <div className="grid gap-4 md:grid-cols-3">
        <Panel className="p-4" data-testid="time-clock-card">
          <div className="label-caps mb-2">Time clock</div>
          {open ? (
            <div className="space-y-2">
              <div className="text-2xl font-semibold tabular-nums" data-testid="time-elapsed">{elapsedSince(open.clock_in!)}<span className="hidden">{tick}</span></div>
              <div className="text-xs text-muted-foreground">Clocked in{open.client_name ? ` · ${open.client_name}` : ""}</div>
              <Button onClick={() => clockOut.mutate()} disabled={clockOut.isPending} data-testid="time-clock-out"><Square className="mr-1 size-4" /> Clock out</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">You're clocked out.</p>
              <Button onClick={() => clockIn.mutate()} disabled={!canWrite || clockIn.isPending} data-testid="time-clock-in"><Play className="mr-1 size-4" /> Clock in</Button>
            </div>
          )}
        </Panel>
        <Panel className="p-4">
          <div className="label-caps mb-2">Hours</div>
          <div className="text-2xl font-semibold tabular-nums" data-testid="time-total">{summaryQ.data?.total_hours ?? "—"}h</div>
          <div className="text-xs text-muted-foreground">total logged · {summaryQ.data?.unbilled_hours ?? "—"}h unbilled</div>
        </Panel>
        <Panel className="p-4">
          <div className="label-caps mb-2">By client</div>
          <div className="space-y-1 text-sm">
            {(summaryQ.data?.by_client ?? []).slice(0, 5).map((c) => (
              <div key={c.client} className="flex justify-between"><span className="truncate">{c.client}</span><span className="font-mono">{c.hours}h</span></div>
            ))}
            {(summaryQ.data?.by_client ?? []).length === 0 && <span className="text-muted-foreground">No hours yet.</span>}
          </div>
        </Panel>
      </div>

      {canWrite && (
        <Panel className="p-4" data-testid="time-manual">
          <div className="label-caps mb-2">Log time manually</div>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); addManual.mutate(); }}>
            <Field label="Date"><Input type="date" value={m.date} onChange={(e) => setM({ ...m, date: e.target.value })} className="w-40" /></Field>
            <Field label="Hours"><Input type="number" step="0.25" min="0.25" max="24" value={m.hours} onChange={(e) => setM({ ...m, hours: e.target.value })} className="w-24 font-mono" required /></Field>
            <Field label="Client"><Input value={m.client_name} onChange={(e) => setM({ ...m, client_name: e.target.value })} className="w-44" placeholder="Optional" /></Field>
            <Field label="Note"><Input value={m.note} onChange={(e) => setM({ ...m, note: e.target.value })} className="w-56" placeholder="Optional" /></Field>
            <Button type="submit" size="sm" disabled={addManual.isPending}><Plus className="mr-1 size-3" /> Log</Button>
          </form>
        </Panel>
      )}

      {billable.length > 0 && can(me, "invoice:write") && (
        <Panel className="p-4" data-testid="time-to-invoice">
          <div className="label-caps mb-2">Bill approved time ({selected.length} selected)</div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Client"><Input value={invClient} onChange={(e) => setInvClient(e.target.value)} className="w-44" placeholder="Client name" /></Field>
            <Field label="Hourly rate $"><Input type="number" step="0.01" min="0.01" value={invRate} onChange={(e) => setInvRate(e.target.value)} className="w-28 font-mono" /></Field>
            <Button size="sm" disabled={!selected.length || !invClient.trim() || !Number(invRate)} onClick={() => toInvoice.mutate()}>Create draft invoice</Button>
          </div>
        </Panel>
      )}

      <Panel className="overflow-hidden" data-testid="time-table-panel">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-4 py-2"></th><th className="px-4 py-2 font-medium">Date</th><th className="px-4 py-2 font-medium">Who</th>
            <th className="px-4 py-2 font-medium">Client</th><th className="px-4 py-2 text-right font-medium">Hours</th>
            <th className="px-4 py-2 font-medium">Status</th><th className="px-4 py-2 font-medium">Actions</th>
          </tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-border" data-testid={`time-row-${e.id}`}>
                <td className="px-4 py-2">{e.status === "approved" && e.billable && !e.invoice_id && can(me, "invoice:write") && (
                  <input type="checkbox" checked={selected.includes(e.id)} onChange={() => toggleSel(e.id)} aria-label="Select for invoice" />)}</td>
                <td className="px-4 py-2 whitespace-nowrap">{e.date}</td>
                <td className="px-4 py-2">{e.user_name}</td>
                <td className="px-4 py-2">{e.client_name || <span className="text-muted-foreground">—</span>}</td>
                <td className="px-4 py-2 text-right font-mono">{e.status === "open" ? elapsedSince(e.clock_in!) : `${e.hours}h`}</td>
                <td className="px-4 py-2"><Pill tone={STATUS_TONE[e.status] ?? "neutral"}>{e.status}</Pill></td>
                <td className="px-4 py-2">
                  <div className="flex gap-1">
                    {e.status === "logged" && canApprove && <Button size="xs" variant="outline" onClick={() => approve.mutate(e.id)}>Approve</Button>}
                    {["logged", "approved"].includes(e.status) && <Button size="xs" variant="ghost" onClick={() => voidEntry.mutate(e.id)}>Void</Button>}
                  </div>
                </td>
              </tr>
            ))}
            {entries.length === 0 && <tr><td colSpan={7}><EmptyRow>No time entries yet.</EmptyRow></td></tr>}
          </tbody>
        </table>
      </Panel>
      <p className="flex items-center gap-1 text-xs text-muted-foreground"><Clock className="size-3" /> Edits are logged immutably in the audit trail — voided entries are kept, never deleted.</p>
    </div>
  );
}
