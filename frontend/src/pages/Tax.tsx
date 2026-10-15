import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, FileCheck2, Plus, Send, Trash2, X } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { errMsg, fmtMoney } from "@/lib/format";
import { can, useMe } from "@/hooks/useMe";
import { EmptyRow, Field, NativeSelect, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Contractor {
  id: string; name: string; email: string; phone: string; business_name: string; entity_type: string;
  tax_id_last4: string; address: { street: string; city: string; state: string; zip: string };
  w9_received: boolean; w9_received_date: string | null; year_total: number; needs_1099: boolean;
  efile: { submission_id?: string; record_id?: string; status?: string; year?: number; amount?: number; sandbox?: boolean };
}
interface Summary {
  year: number; threshold: number; contractors: Contractor[]; required_count: number;
  reportable_total: number; missing_w9: string[];
}

const ENTITY_LABEL: Record<string, string> = {
  individual: "Individual", sole_prop: "Sole proprietor", llc: "LLC", c_corp: "C corp",
  s_corp: "S corp", partnership: "Partnership", trust: "Trust",
};

const blank = { name: "", email: "", phone: "", business_name: "", entity_type: "individual", tax_id: "", street: "", city: "", state: "", zip: "" };

export default function Tax() {
  const { data: me } = useMe();
  const write = can(me, "tax:write");
  const year = new Date().getFullYear();
  const [showNew, setShowNew] = useState(false);
  const [f, setF] = useState(blank);
  const [payFor, setPayFor] = useState<Contractor | null>(null);
  const [pay, setPay] = useState({ date: new Date().toISOString().slice(0, 10), amount: "", description: "" });

  const sumQ = useQuery({ queryKey: ["tax-summary", year], queryFn: () => apiGet<Summary>(`/tax/summary?year=${year}`) });
  const tbQ = useQuery({ queryKey: ["tb-status"], queryFn: () => apiGet<{ configured: boolean; sandbox: boolean }>("/tax/taxbandits/status") });
  const refresh = () => sumQ.refetch();

  const save = useMutation({
    mutationFn: () => apiPost<Contractor>("/tax/contractors", {
      name: f.name, email: f.email, phone: f.phone, business_name: f.business_name,
      entity_type: f.entity_type, tax_id: f.tax_id,
      address: { street: f.street, city: f.city, state: f.state, zip: f.zip },
    }),
    onSuccess: () => { toast.success("Contractor added"); setF(blank); setShowNew(false); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/tax/contractors/${id}`),
    onSuccess: () => { toast.success("Contractor removed"); refresh(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const w9 = useMutation({
    mutationFn: (c: Contractor) => apiPost<Contractor>(`/tax/contractors/${c.id}/w9`, { received: !c.w9_received }),
    onSuccess: () => { toast.success("W-9 status updated"); refresh(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const addPay = useMutation({
    mutationFn: () => apiPost(`/tax/contractors/${payFor!.id}/payments`,
      { date: pay.date, amount: Number(pay.amount), description: pay.description }),
    onSuccess: () => { toast.success("Payment recorded"); setPayFor(null); setPay({ date: new Date().toISOString().slice(0, 10), amount: "", description: "" }); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const efile = useMutation({
    mutationFn: (c: Contractor) => apiPost<{ note: string }>(`/tax/efile-1099/${c.id}?year=${year}`, {}),
    onSuccess: (r) => { toast.success(r.note); refresh(); tbQ.refetch(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const s = sumQ.data;

  return (
    <div className="space-y-4">
      <PageHeader title={`Tax & 1099s — ${year}`} subtitle="Contractor tracking, W-9 status, and 1099-NEC e-filing via TaxBandits.">
        {write && <Button size="sm" onClick={() => setShowNew((x) => !x)} data-testid="tax-new-contractor"><Plus className="mr-1 size-4" /> Add contractor</Button>}
      </PageHeader>

      {!tbQ.data?.configured && (
        <div className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="tax-tb-banner">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <p><strong>TaxBandits not connected.</strong> Tracking and year summaries work now; e-filing lights up once
            API keys are added. See <code>TAXBANDITS_SETUP.md</code> in the repo. No IRS filing is ever done in-house.</p>
        </div>
      )}
      {tbQ.data?.configured && tbQ.data.sandbox && (
        <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 p-3 text-sm">
          TaxBandits connected in <strong>sandbox</strong> mode — no real filings. Flip <code>TAXBANDITS_SANDBOX=false</code> to go live.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Panel className="p-3"><div className="label-caps">Need 1099-NEC</div><div className="text-2xl font-semibold">{s?.required_count ?? "—"}</div><div className="text-xs text-muted-foreground">≥ {fmtMoney(s?.threshold ?? 600)}</div></Panel>
        <Panel className="p-3"><div className="label-caps">Reportable total</div><div className="text-2xl font-semibold font-mono">{fmtMoney(s?.reportable_total ?? 0)}</div></Panel>
        <Panel className="p-3"><div className="label-caps">Missing W-9</div><div className="text-2xl font-semibold">{s?.missing_w9.length ?? "—"}</div>{(s?.missing_w9.length ?? 0) > 0 && <div className="text-xs text-amber-600">{s!.missing_w9.join(", ")}</div>}</Panel>
        <Panel className="p-3"><div className="label-caps">Contractors</div><div className="text-2xl font-semibold">{s?.contractors.length ?? "—"}</div></Panel>
      </div>

      {showNew && write && (
        <Panel className="p-4" data-testid="tax-new-form">
          <div className="label-caps mb-2">New contractor</div>
          <form className="grid grid-cols-2 gap-2 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
            <Field label="Business name"><Input value={f.business_name} onChange={(e) => setF({ ...f, business_name: e.target.value })} /></Field>
            <Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="Entity type">
              <NativeSelect value={f.entity_type} onChange={(e) => setF({ ...f, entity_type: e.target.value })}>
                {Object.entries(ENTITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </NativeSelect>
            </Field>
            <Field label="SSN / EIN"><Input value={f.tax_id} onChange={(e) => setF({ ...f, tax_id: e.target.value })} placeholder="Stored securely" /></Field>
            <Field label="Street"><Input value={f.street} onChange={(e) => setF({ ...f, street: e.target.value })} /></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="City"><Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
              <Field label="State"><Input value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} /></Field>
              <Field label="ZIP"><Input value={f.zip} onChange={(e) => setF({ ...f, zip: e.target.value })} /></Field>
            </div>
            <div className="col-span-2 flex gap-2 md:col-span-4">
              <Button size="sm" type="submit" disabled={save.isPending}>Add</Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setShowNew(false)}>Cancel</Button>
            </div>
          </form>
        </Panel>
      )}

      <Panel className="overflow-hidden" data-testid="tax-table">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">Contractor</th><th className="px-4 py-2 text-right font-medium">Paid {year}</th>
            <th className="px-4 py-2 font-medium">W-9</th><th className="px-4 py-2 font-medium">1099-NEC</th>
            <th className="px-4 py-2 font-medium">E-file</th><th className="px-4 py-2"></th>
          </tr></thead>
          <tbody>
            {(s?.contractors ?? []).map((c) => (
              <tr key={c.id} className="border-b border-border/50" data-testid={`tax-row-${c.id}`}>
                <td className="px-4 py-2">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{ENTITY_LABEL[c.entity_type]}{c.business_name ? ` · ${c.business_name}` : ""}{c.tax_id_last4 ? ` · •••${c.tax_id_last4}` : ""}</div>
                </td>
                <td className="px-4 py-2 text-right font-mono">{fmtMoney(c.year_total)}</td>
                <td className="px-4 py-2">
                  {write
                    ? <button onClick={() => w9.mutate(c)} className="cursor-pointer" title="Toggle W-9 received" data-testid={`tax-w9-${c.id}`}><Pill tone={c.w9_received ? "success" : "warning"}>{c.w9_received ? "Received" : "Missing"}</Pill></button>
                    : <Pill tone={c.w9_received ? "success" : "warning"}>{c.w9_received ? "Received" : "Missing"}</Pill>}
                </td>
                <td className="px-4 py-2">{c.needs_1099 ? <Pill tone="info">Required</Pill> : <span className="text-xs text-muted-foreground">—</span>}</td>
                <td className="px-4 py-2 text-xs">
                  {c.efile?.submission_id
                    ? <span className="text-muted-foreground">{c.efile.status}{c.efile.sandbox ? " (sandbox)" : ""}</span>
                    : <span className="text-muted-foreground">Not filed</span>}
                </td>
                <td className="px-4 py-2 text-right">
                  {write && (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="outline" onClick={() => setPayFor(c)} data-testid={`tax-pay-${c.id}`}>Record payment</Button>
                      {c.needs_1099 && !c.efile?.submission_id && (
                        <Button size="xs" onClick={() => efile.mutate(c)} disabled={efile.isPending || !tbQ.data?.configured} title={tbQ.data?.configured ? "Create 1099-NEC draft in TaxBandits" : "Connect TaxBandits first"} data-testid={`tax-efile-${c.id}`}>
                          <Send className="mr-1 size-3" /> E-file
                        </Button>
                      )}
                      <Button size="icon-sm" variant="ghost" onClick={() => del.mutate(c.id)}><Trash2 className="size-3" /></Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {(s?.contractors ?? []).length === 0 && <tr><td colSpan={6}><EmptyRow>No contractors yet.</EmptyRow></td></tr>}
          </tbody>
        </table>
      </Panel>

      {payFor && (
        <Panel className="p-4" data-testid="tax-pay-form">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-medium">Record payment to {payFor.name}</div>
            <Button size="xs" variant="ghost" onClick={() => setPayFor(null)}><X className="size-3" /></Button>
          </div>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); addPay.mutate(); }}>
            <Field label="Date"><Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} className="w-40" /></Field>
            <Field label="Amount $"><Input type="number" step="0.01" min={0.01} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} className="w-32 font-mono" required /></Field>
            <Field label="Description"><Input value={pay.description} onChange={(e) => setPay({ ...pay, description: e.target.value })} className="w-56" placeholder="e.g. March bookkeeping" /></Field>
            <Button size="sm" type="submit" disabled={addPay.isPending}>Record</Button>
          </form>
        </Panel>
      )}

      <p className="flex items-start gap-1 text-xs text-muted-foreground">
        <FileCheck2 className="mt-0.5 size-3 shrink-0" />
        1099-NEC is required for non-corporate contractors paid ≥ $600 in the year. E-filing creates a draft in
        TaxBandits — you review and transmit there. This app never files with the IRS directly.
      </p>
    </div>
  );
}
