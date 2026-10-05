import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, FileCheck2, ArrowRightLeft, Check, X } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { businessToday, errMsg, fmtDate, fmtMoney } from "@/lib/format";
import { queryClient } from "@/lib/queryClient";
import type { Estimate, InvoiceIn, InvoiceLineIn, Product } from "@/lib/types";
import { can, useMe, useTeam } from "@/hooks/useMe";
import { Field, NativeSelect, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const today = () => businessToday();
type Line = InvoiceLineIn & { kind: "service" | "product"; product_id: string | null };
type FormState = Omit<InvoiceIn, "lines"> & { lines: Line[] };
const blankLine: Line = { description: "", quantity: 1, unit_price: 0, kind: "service", product_id: null };
const blankForm = (): FormState => ({ client_name: "", date: today(), due_date: null, lines: [{ ...blankLine }], barber_id: null, notes: "", discount_amount: 0, tax_rate: 0, tip_amount: 0 });

const TONE: Record<string, "neutral" | "info" | "success" | "warning"> = { draft: "neutral", sent: "info", accepted: "success", declined: "warning", converted: "success" };

export default function Estimates() {
  const { data: me } = useMe();
  const { data: team = [] } = useTeam();
  const inv = !!me?.inventory_enabled;
  const writable = can(me, "invoice:write");
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: () => apiGet<Product[]>("/inventory/products"), enabled: inv });
  const { data: estimates = [] } = useQuery({ queryKey: ["estimates"], queryFn: () => apiGet<Estimate[]>("/estimates") });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<FormState>(blankForm());

  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["estimates"] }); queryClient.invalidateQueries({ queryKey: ["invoices"] }); };
  const create = useMutation({
    mutationFn: () => apiPost<Estimate>("/estimates", f),
    onSuccess: (e) => { toast.success(`${e.number} created`); refresh(); setOpen(false); setF(blankForm()); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const act = useMutation({
    mutationFn: ({ id, path, body }: { id: string; path: string; body?: unknown }) => apiPost(`/estimates/${id}/${path}`, body),
    onSuccess: (_d, v) => { toast.success(v.path === "convert" ? "Converted to a draft invoice" : "Updated"); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({ mutationFn: (id: string) => apiDelete(`/estimates/${id}`), onSuccess: () => { toast.success("Deleted"); refresh(); }, onError: (e) => toast.error(errMsg(e)) });

  const setLine = (i: number, patch: Partial<Line>) => setF((s) => ({ ...s, lines: s.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const onPickProduct = (i: number, pid: string) => { const p = products.find((x) => x.id === pid); setLine(i, { product_id: pid || null, description: p?.name ?? "", unit_price: p?.sell_price ?? 0 }); };
  const sub = f.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const taxable = Math.max(sub - (f.discount_amount || 0), 0);
  const total = taxable + taxable * (f.tax_rate || 0) / 100 + (f.tip_amount || 0);

  return (
    <div>
      <PageHeader title="Estimates" subtitle="Send clients a quote. When they accept, convert it to an invoice in one click — nothing hits your books until that invoice is issued.">
        {writable && <Button size="sm" onClick={() => setOpen(true)} data-testid="estimate-new-button"><Plus /> New estimate</Button>}
      </PageHeader>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {estimates.map((e) => (
          <Panel key={e.id} className="p-4" data-testid={`estimate-card-${e.number}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-mono text-xs text-muted-foreground">{e.number}</div>
                <div className="font-medium">{e.client_name}</div>
                <div className="text-xs text-muted-foreground">{fmtDate(e.date)}{e.valid_until ? ` · valid to ${fmtDate(e.valid_until)}` : ""}</div>
              </div>
              <Pill tone={TONE[e.status]} testId={`estimate-status-${e.number}`}>{e.status}</Pill>
            </div>
            <div className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
              {e.lines.map((l, j) => <div key={j} className="flex justify-between gap-2"><span className="truncate">{l.quantity} × {l.description}</span><span className="font-mono tabular-nums">{fmtMoney(l.quantity * l.unit_price)}</span></div>)}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
              <span className="text-xs text-muted-foreground">Total</span>
              <span className="font-heading text-lg font-semibold tabular-nums" data-testid={`estimate-total-${e.number}`}>{fmtMoney(e.total)}</span>
            </div>
            {e.converted_invoice_number && <p className="mt-1 text-xs text-emerald-500">Converted → {e.converted_invoice_number}</p>}
            {writable && e.status !== "converted" && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {e.status === "draft" && <Button size="xs" variant="outline" onClick={() => act.mutate({ id: e.id, path: "status", body: { status: "sent" } })} data-testid={`estimate-send-${e.number}`}>Mark sent</Button>}
                {e.status !== "accepted" && e.status !== "declined" && <Button size="xs" variant="outline" onClick={() => act.mutate({ id: e.id, path: "status", body: { status: "accepted" } })} data-testid={`estimate-accept-${e.number}`}><Check className="size-3" /> Accept</Button>}
                <Button size="xs" onClick={() => act.mutate({ id: e.id, path: "convert" })} data-testid={`estimate-convert-${e.number}`}><ArrowRightLeft className="size-3" /> Convert to invoice</Button>
                {e.status !== "declined" && <Button size="xs" variant="ghost" onClick={() => act.mutate({ id: e.id, path: "status", body: { status: "declined" } })} data-testid={`estimate-decline-${e.number}`}><X className="size-3" /> Decline</Button>}
                <Button size="icon-sm" variant="ghost" onClick={() => del.mutate(e.id)} data-testid={`estimate-delete-${e.number}`}><Trash2 /></Button>
              </div>
            )}
          </Panel>
        ))}
        {estimates.length === 0 && <p className="text-sm text-muted-foreground">No estimates yet. Create a quote to send a client.</p>}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl" data-testid="estimate-dialog">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogHeader><DialogTitle>New estimate</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Client" className="col-span-2"><Input required value={f.client_name} onChange={(e) => setF({ ...f, client_name: e.target.value })} data-testid="estimate-client-input" /></Field>
              <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} data-testid="estimate-date-input" /></Field>
              <Field label="Valid until"><Input type="date" value={f.due_date ?? ""} onChange={(e) => setF({ ...f, due_date: e.target.value || null })} data-testid="estimate-valid-input" /></Field>
              <Field label="Barber" className="col-span-2"><NativeSelect value={f.barber_id ?? ""} onChange={(e) => setF({ ...f, barber_id: e.target.value || null })} data-testid="estimate-barber-select"><option value="">—</option>{team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</NativeSelect></Field>
            </div>
            <div className="space-y-2">
              <div className="label-caps">Lines</div>
              {f.lines.map((l, i) => (
                <div key={i} className="space-y-1.5 rounded-md border border-border p-2">
                  <div className="flex gap-2">
                    <NativeSelect value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value as "service" | "product", product_id: null })} className="w-28" data-testid={`estimate-line-kind-${i}`}><option value="service">Service</option>{inv && <option value="product">Product</option>}</NativeSelect>
                    {l.kind === "product" && inv ? (
                      <NativeSelect value={l.product_id ?? ""} onChange={(e) => onPickProduct(i, e.target.value)} className="flex-1" data-testid={`estimate-line-product-${i}`}><option value="">Pick product…</option>{products.filter((p) => p.type === "retail").map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(p.sell_price)}</option>)}</NativeSelect>
                    ) : (
                      <Input required placeholder="Skin fade" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} className="flex-1" data-testid={`estimate-line-desc-${i}`} />
                    )}
                  </div>
                  <div className="grid grid-cols-[80px_110px_1fr_auto] gap-2">
                    <Input type="number" min={1} value={l.quantity} onChange={(e) => setLine(i, { quantity: Number(e.target.value) })} className="font-mono" data-testid={`estimate-line-qty-${i}`} />
                    <Input type="number" step="0.01" min={0} value={l.unit_price} onChange={(e) => setLine(i, { unit_price: Number(e.target.value) })} className="font-mono" data-testid={`estimate-line-price-${i}`} />
                    <div className="flex items-center text-sm text-muted-foreground">{fmtMoney(l.quantity * l.unit_price)}</div>
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })}><Trash2 /></Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="xs" onClick={() => setF({ ...f, lines: [...f.lines, { ...blankLine }] })} data-testid="estimate-add-line-button"><Plus /> Line</Button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Discount"><Input type="number" step="0.01" min={0} value={f.discount_amount || 0} onChange={(e) => setF({ ...f, discount_amount: Number(e.target.value) })} className="font-mono" data-testid="estimate-discount" /></Field>
              <Field label="Tax rate %"><Input type="number" step="0.01" min={0} value={f.tax_rate || 0} onChange={(e) => setF({ ...f, tax_rate: Number(e.target.value) })} className="font-mono" data-testid="estimate-tax-rate" /></Field>
              <Field label="Tip"><Input type="number" step="0.01" min={0} value={f.tip_amount || 0} onChange={(e) => setF({ ...f, tip_amount: Number(e.target.value) })} className="font-mono" data-testid="estimate-tip" /></Field>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Quote total</span>
              <span className="font-heading text-lg font-semibold tabular-nums" data-testid="estimate-total-preview">{fmtMoney(total)}</span>
            </div>
            <DialogFooter><Button type="submit" disabled={create.isPending} data-testid="estimate-save-button"><FileCheck2 className="size-3" /> Create estimate</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
