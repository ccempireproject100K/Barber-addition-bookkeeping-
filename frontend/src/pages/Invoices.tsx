import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Mail, Plus, RefreshCw, Trash2, Receipt, RotateCcw, Send, CreditCard } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { businessToday, errMsg, fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { queryClient } from "@/lib/queryClient";
import type { Client, Invoice, InvoiceIn, InvoiceLineIn, OverdueInvoice, PayMethod, Product, RecurringInvoice, RecurringInvoiceLine, ReminderRecord } from "@/lib/types";
import { can, useMe, useTeam } from "@/hooks/useMe";
import { EmptyRow, Field, InvoiceBadge, NativeSelect, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const today = () => businessToday();
const METHODS: PayMethod[] = ["cash", "card", "bank", "other"];
type Line = InvoiceLineIn & { kind: "service" | "product"; product_id: string | null };
type FormState = Omit<InvoiceIn, "lines"> & { lines: Line[] };
const blankLine: Line = { description: "", quantity: 1, unit_price: 0, kind: "service", product_id: null };

export default function Invoices() {
  const { data: me } = useMe();
  const { data: team = [] } = useTeam();
  const inv = !!me?.inventory_enabled;
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: () => apiGet<Product[]>("/inventory/products"), enabled: inv });
  const [open, setOpen] = useState(false);
  const [payFor, setPayFor] = useState<Invoice | null>(null);
  const [refundFor, setRefundFor] = useState<Invoice | null>(null);
  const [f, setF] = useState<FormState>({ client_name: "", date: today(), due_date: null, lines: [{ ...blankLine }], barber_id: null, notes: "", discount_amount: 0, tax_rate: 0, tip_amount: 0 });
  const { data: invoices = [] } = useQuery({ queryKey: ["invoices"], queryFn: () => apiGet<Invoice[]>("/invoices") });

  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["invoices"] }); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); };
  const create = useMutation({
    mutationFn: () => apiPost<Invoice>("/invoices", f),
    onSuccess: (i) => { toast.success(`${i.number} created`); refresh(); setOpen(false); setF({ client_name: "", date: today(), due_date: null, lines: [{ ...blankLine }], barber_id: null, notes: "", discount_amount: 0, tax_rate: 0, tip_amount: 0 }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const act = useMutation({
    mutationFn: ({ id, path, body }: { id: string; path: string; body?: unknown }) => apiPost<Invoice>(`/invoices/${id}/${path}`, body),
    onSuccess: (i) => { toast.success(`${i.number} → ${i.status}`); refresh(); setPayFor(null); setRefundFor(null); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const setLine = (i: number, patch: Partial<Line>) => setF((s) => ({ ...s, lines: s.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const onPickProduct = (i: number, pid: string) => {
    const p = products.find((x) => x.id === pid);
    setLine(i, { product_id: pid || null, description: p?.name ?? "", unit_price: p?.sell_price ?? 0 });
  };
  const sub = f.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const taxable = Math.max(sub - (f.discount_amount || 0), 0);
  const total = taxable + taxable * (f.tax_rate || 0) / 100 + (f.tip_amount || 0);

  return (
    <div>
      <PageHeader title="Invoices" subtitle="Bill clients for services and products. Issue to recognize revenue, then record payments — partial or full.">
        {can(me, "invoice:write") && <Button size="sm" onClick={() => setOpen(true)} data-testid="invoice-new-button"><Plus /> New invoice</Button>}
      </PageHeader>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {invoices.map((i) => (
          <Panel key={i.id} className="p-4" data-testid={`invoice-card-${i.number}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-mono text-xs text-muted-foreground">{i.number}</div>
                <div className="font-medium">{i.client_name}</div>
                <div className="text-xs text-muted-foreground">{fmtDate(i.date)}{i.due_date ? ` · due ${fmtDate(i.due_date)}` : ""}{i.barber_name ? ` · ${i.barber_name}` : ""}</div>
              </div>
              <InvoiceBadge status={i.status} testId={`invoice-status-${i.number}`} />
            </div>
            <div className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
              {i.lines.map((l, j) => (
                <div key={j} className="flex justify-between gap-2">
                  <span className="truncate">{l.quantity} × {l.description} {l.kind === "product" && <Pill tone="info">stock</Pill>}</span>
                  <span className="font-mono tabular-nums">{fmtMoney(l.quantity * l.unit_price)}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 space-y-0.5 border-t border-border pt-2 text-xs text-muted-foreground">
              {i.discount_amount > 0 && <Row l="Discount" v={-i.discount_amount} />}
              {i.tax_amount > 0 && <Row l={`Tax (${i.tax_rate}%)`} v={i.tax_amount} />}
              {i.tip_amount > 0 && <Row l="Tip" v={i.tip_amount} />}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
              <span className="text-xs text-muted-foreground">Total</span>
              <span className="font-heading text-lg font-semibold tabular-nums" data-testid={`invoice-total-${i.number}`}>{fmtMoney(i.total)}</span>
            </div>
            {i.amount_paid > 0 && (
              <div className="mt-1 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Paid {fmtMoney(i.amount_paid)}</span>
                <span className={`font-mono font-medium ${i.balance_due > 0 ? "text-amber-500" : "text-emerald-500"}`} data-testid={`invoice-balance-${i.number}`}>Balance {fmtMoney(i.balance_due)}</span>
              </div>
            )}
            {can(me, "invoice:write") && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {i.status === "draft" && <Button size="xs" variant="outline" onClick={() => act.mutate({ id: i.id, path: "issue" })} data-testid={`invoice-issue-${i.number}`}><Send className="size-3" /> Issue</Button>}
                {(i.status === "draft" || i.status === "sent") && <Button size="xs" onClick={() => setPayFor(i)} data-testid={`invoice-pay-${i.number}`}><CreditCard className="size-3" /> Record payment</Button>}
                {i.amount_paid > 0 && <Button size="xs" variant="outline" onClick={() => setRefundFor(i)} data-testid={`invoice-refund-${i.number}`}><RotateCcw className="size-3" /> Refund</Button>}
                {i.amount_paid === 0 && i.status !== "void" && <Button size="xs" variant="ghost" onClick={() => act.mutate({ id: i.id, path: "status", body: { status: "void" } })} data-testid={`invoice-void-${i.number}`}>Void</Button>}
              </div>
            )}
          </Panel>
        ))}
        {invoices.length === 0 && <p className="text-sm text-muted-foreground">No invoices yet.</p>}
      </div>

      <RecurringInvoicesSection writable={can(me, "invoice:write")} />
      <RemindersSection writable={can(me, "invoice:write")} />

      {/* New invoice */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl" data-testid="invoice-dialog">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogHeader><DialogTitle>New invoice</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Client" className="col-span-2"><Input required value={f.client_name} onChange={(e) => setF({ ...f, client_name: e.target.value })} data-testid="invoice-client-input" /></Field>
              <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} data-testid="invoice-date-input" /></Field>
              <Field label="Due date"><Input type="date" value={f.due_date ?? ""} onChange={(e) => setF({ ...f, due_date: e.target.value || null })} data-testid="invoice-due-input" /></Field>
              <Field label="Staff member" className="col-span-2">
                <NativeSelect value={f.barber_id ?? ""} onChange={(e) => setF({ ...f, barber_id: e.target.value || null })} data-testid="invoice-barber-select">
                  <option value="">—</option>{team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </NativeSelect>
              </Field>
            </div>
            <div className="space-y-2">
              <div className="label-caps">Lines</div>
              {f.lines.map((l, i) => (
                <div key={i} className="space-y-1.5 rounded-md border border-border p-2">
                  <div className="flex gap-2">
                    <NativeSelect value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value as "service" | "product", product_id: null })} className="w-28" data-testid={`invoice-line-kind-${i}`}>
                      <option value="service">Service</option>{inv && <option value="product">Product</option>}
                    </NativeSelect>
                    {l.kind === "product" && inv ? (
                      <NativeSelect value={l.product_id ?? ""} onChange={(e) => onPickProduct(i, e.target.value)} className="flex-1" data-testid={`invoice-line-product-${i}`}>
                        <option value="">Pick product…</option>{products.filter((p) => p.type === "retail").map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(p.sell_price)} ({p.quantity_on_hand})</option>)}
                      </NativeSelect>
                    ) : (
                      <Input required placeholder="Skin fade" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} className="flex-1" data-testid={`invoice-line-desc-${i}`} />
                    )}
                  </div>
                  <div className="grid grid-cols-[80px_110px_1fr_auto] gap-2">
                    <Input type="number" min={1} value={l.quantity} onChange={(e) => setLine(i, { quantity: Number(e.target.value) })} className="font-mono" data-testid={`invoice-line-qty-${i}`} />
                    <Input type="number" step="0.01" min={0} value={l.unit_price} onChange={(e) => setLine(i, { unit_price: Number(e.target.value) })} className="font-mono" data-testid={`invoice-line-price-${i}`} />
                    <div className="flex items-center text-sm text-muted-foreground">{fmtMoney(l.quantity * l.unit_price)}</div>
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })} data-testid={`invoice-line-remove-${i}`}><Trash2 /></Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="xs" onClick={() => setF({ ...f, lines: [...f.lines, { ...blankLine }] })} data-testid="invoice-add-line-button"><Plus /> Line</Button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Discount"><Input type="number" step="0.01" min={0} value={f.discount_amount || 0} onChange={(e) => setF({ ...f, discount_amount: Number(e.target.value) })} className="font-mono" data-testid="invoice-discount" /></Field>
              <Field label="Tax rate %"><Input type="number" step="0.01" min={0} value={f.tax_rate || 0} onChange={(e) => setF({ ...f, tax_rate: Number(e.target.value) })} className="font-mono" data-testid="invoice-tax-rate" /></Field>
              <Field label="Tip"><Input type="number" step="0.01" min={0} value={f.tip_amount || 0} onChange={(e) => setF({ ...f, tip_amount: Number(e.target.value) })} className="font-mono" data-testid="invoice-tip" /></Field>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Total (incl. tax + tip)</span>
              <span className="font-heading text-lg font-semibold tabular-nums" data-testid="invoice-total-preview">{fmtMoney(total)}</span>
            </div>
            <DialogFooter><Button type="submit" disabled={create.isPending} data-testid="invoice-save-button">Create invoice</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {payFor && <PaymentDialog invoice={payFor} onClose={() => setPayFor(null)} onSubmit={(body) => act.mutate({ id: payFor.id, path: "payments", body })} pending={act.isPending} />}
      {refundFor && <RefundDialog invoice={refundFor} onClose={() => setRefundFor(null)} onSubmit={(body) => act.mutate({ id: refundFor.id, path: "refund", body })} pending={act.isPending} />}
    </div>
  );
}

function Row({ l, v }: { l: string; v: number }) {
  return <div className="flex justify-between"><span>{l}</span><span className="font-mono tabular-nums">{fmtMoney(v)}</span></div>;
}

function PaymentDialog({ invoice, onClose, onSubmit, pending }: { invoice: Invoice; onClose: () => void; onSubmit: (b: unknown) => void; pending: boolean }) {
  const [amount, setAmount] = useState(invoice.balance_due || invoice.total);
  const [method, setMethod] = useState<PayMethod>("cash");
  const [fee, setFee] = useState(0);
  const processor = method === "card" ? "stripe" : "recorded";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="payment-dialog">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit({ amount, method, fee, processor }); }}>
          <DialogHeader><DialogTitle>Record payment · {invoice.number}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Balance due <span className="font-mono font-medium text-foreground">{fmtMoney(invoice.balance_due || invoice.total)}</span></p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount"><Input type="number" step="0.01" min={0.01} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="font-mono" data-testid="payment-amount" /></Field>
            <Field label="Method"><NativeSelect value={method} onChange={(e) => setMethod(e.target.value as PayMethod)} data-testid="payment-method">{METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</NativeSelect></Field>
            <Field label="Processing fee" className="col-span-2" hint="Recorded separately from gross revenue (DR Processing Fees).">
              <Input type="number" step="0.01" min={0} value={fee} onChange={(e) => setFee(Number(e.target.value))} className="font-mono" data-testid="payment-fee" /></Field>
          </div>
          <DialogFooter><Button type="submit" disabled={pending} data-testid="payment-submit">Record {fmtMoney(amount)}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RefundDialog({ invoice, onClose, onSubmit, pending }: { invoice: Invoice; onClose: () => void; onSubmit: (b: unknown) => void; pending: boolean }) {
  const [amount, setAmount] = useState(invoice.amount_paid);
  const [method, setMethod] = useState<PayMethod>("cash");
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="refund-dialog">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onSubmit({ amount, method, reason }); }}>
          <DialogHeader><DialogTitle>Refund · {invoice.number}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Paid so far <span className="font-mono font-medium text-foreground">{fmtMoney(invoice.amount_paid)}</span>. Returned goods go back via a stock return.</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount"><Input type="number" step="0.01" min={0.01} max={invoice.amount_paid} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="font-mono" data-testid="refund-amount" /></Field>
            <Field label="Method"><NativeSelect value={method} onChange={(e) => setMethod(e.target.value as PayMethod)} data-testid="refund-method">{METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</NativeSelect></Field>
            <Field label="Reason" className="col-span-2"><Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="refund-reason" /></Field>
          </div>
          <DialogFooter><Button type="submit" variant="destructive" disabled={pending} data-testid="refund-submit"><Receipt className="size-3" /> Refund {fmtMoney(amount)}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const blankRecLine: RecurringInvoiceLine = { description: "", quantity: 1, unit_price: 0, kind: "service", product_id: null };

function RecurringInvoicesSection({ writable }: { writable: boolean }) {
  const { data: me } = useMe();
  const inv = !!me?.inventory_enabled;
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: () => apiGet<Product[]>("/inventory/products"), enabled: inv });
  const { data: items = [] } = useQuery({ queryKey: ["recurring-invoices"], queryFn: () => apiGet<RecurringInvoice[]>("/recurring-invoices") });
  const [open, setOpen] = useState(false);
  const blank = { name: "", client_name: "", lines: [{ ...blankRecLine }], discount_amount: 0, tax_rate: 0, tip_amount: 0, day_of_month: 1, active: true, notes: "" };
  const [f, setF] = useState(blank);
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["recurring-invoices"] }); queryClient.invalidateQueries({ queryKey: ["invoices"] }); };
  const create = useMutation({
    mutationFn: () => apiPost("/recurring-invoices", f),
    onSuccess: () => { toast.success("Recurring invoice template added"); refresh(); setOpen(false); setF(blank); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const runNow = (id: string) => apiPost<{ number: string }>("/recurring-invoices/" + id + "/run", {}).then((r) => { toast.success(`Draft ${r.number} created`); refresh(); }).catch((e) => toast.error(errMsg(e)));
  const del = (id: string) => { if (window.confirm("Delete this recurring template?")) apiDelete(`/recurring-invoices/${id}`).then(refresh).catch((e) => toast.error(errMsg(e))); };
  const setLine = (i: number, patch: Partial<RecurringInvoiceLine>) => setF((s) => ({ ...s, lines: s.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const sub = f.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  return (
    <div className="mt-10">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-heading text-lg font-semibold">Recurring invoice drafts</h2>
          <p className="text-xs text-muted-foreground">Monthly templates — a draft invoice is created automatically each month. Drafts never post until you issue them.</p>
        </div>
        {writable && <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="recurring-invoice-new-button"><RefreshCw /> Add template</Button>}
      </div>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="recurring-invoices-table">
          <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Template</th><th className="px-4 py-2 font-medium">Client</th><th className="px-4 py-2 text-right font-medium">Amount</th><th className="px-4 py-2 font-medium">Day</th><th className="px-4 py-2 font-medium">Last run</th><th className="px-4 py-2"></th></tr></thead>
          <tbody>
            {items.map((r) => {
              const amt = r.lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
              return (
                <tr key={r.id} className="border-b border-border last:border-0" data-testid={`recurring-invoice-row-${r.id}`}>
                  <td className="px-4 py-2 font-medium">{r.name}</td>
                  <td className="px-4 py-2">{r.client_name}</td>
                  <td className="px-4 py-2 text-right font-mono">{fmtMoney(amt)}</td>
                  <td className="px-4 py-2">{r.day_of_month}</td>
                  <td className="px-4 py-2 text-muted-foreground">{r.last_run ?? "—"}</td>
                  <td className="px-4 py-2 text-right">{writable && <span className="flex justify-end gap-1">
                    <Button size="xs" variant="outline" onClick={() => runNow(r.id)} data-testid={`recurring-invoice-run-${r.id}`}>Create draft now</Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => del(r.id)}><Trash2 /></Button>
                  </span>}</td>
                </tr>
              );
            })}
            {items.length === 0 && <EmptyRow cols={6} text="Add a template for retainers, memberships or monthly billing — drafts post automatically." />}
          </tbody>
        </table>
      </Panel>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl" data-testid="recurring-invoice-dialog">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogHeader><DialogTitle>Recurring invoice template</DialogTitle></DialogHeader>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Template name" className="col-span-2"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Monthly retainer" data-testid="recurring-invoice-name" /></Field>
              <Field label="Day of month"><Input type="number" min={1} max={28} value={f.day_of_month} onChange={(e) => setF({ ...f, day_of_month: Number(e.target.value) })} data-testid="recurring-invoice-day" /></Field>
              <Field label="Client" className="col-span-3"><Input required value={f.client_name} onChange={(e) => setF({ ...f, client_name: e.target.value })} data-testid="recurring-invoice-client" /></Field>
            </div>
            <div className="space-y-2">
              <div className="label-caps">Lines</div>
              {f.lines.map((l, i) => (
                <div key={i} className="space-y-1.5 rounded-md border border-border p-2">
                  <div className="flex gap-2">
                    <NativeSelect value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value as "service" | "product", product_id: null })} className="w-28">
                      <option value="service">Service</option>{inv && <option value="product">Product</option>}
                    </NativeSelect>
                    {l.kind === "product" && inv ? (
                      <NativeSelect value={l.product_id ?? ""} onChange={(e) => { const p = products.find((x) => x.id === e.target.value); setLine(i, { product_id: e.target.value || null, description: p?.name ?? "", unit_price: p?.sell_price ?? 0 }); }} className="flex-1">
                        <option value="">Pick product…</option>{products.filter((p) => p.type === "retail").map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(p.sell_price)}</option>)}
                      </NativeSelect>
                    ) : (
                      <Input required placeholder="Service description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} className="flex-1" />
                    )}
                  </div>
                  <div className="grid grid-cols-[80px_110px_1fr_auto] gap-2">
                    <Input type="number" min={1} value={l.quantity} onChange={(e) => setLine(i, { quantity: Number(e.target.value) })} className="font-mono" />
                    <Input type="number" step="0.01" min={0} value={l.unit_price} onChange={(e) => setLine(i, { unit_price: Number(e.target.value) })} className="font-mono" />
                    <div className="flex items-center text-sm text-muted-foreground">{fmtMoney(l.quantity * l.unit_price)}</div>
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })}><Trash2 /></Button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="xs" onClick={() => setF({ ...f, lines: [...f.lines, { ...blankRecLine }] })}><Plus /> Line</Button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Discount"><Input type="number" step="0.01" min={0} value={f.discount_amount || 0} onChange={(e) => setF({ ...f, discount_amount: Number(e.target.value) })} className="font-mono" /></Field>
              <Field label="Tax rate %"><Input type="number" step="0.01" min={0} value={f.tax_rate || 0} onChange={(e) => setF({ ...f, tax_rate: Number(e.target.value) })} className="font-mono" /></Field>
              <Field label="Notes" className="col-span-3"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Draft total each month</span>
              <span className="font-heading text-lg font-semibold tabular-nums">{fmtMoney(sub)}</span>
            </div>
            <DialogFooter><Button type="submit" disabled={create.isPending} data-testid="recurring-invoice-save-button">Save template</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RemindersSection({ writable }: { writable: boolean }) {
  const { data: overdue = [] } = useQuery({ queryKey: ["reminders-overdue"], queryFn: () => apiGet<OverdueInvoice[]>("/reminders/overdue") });
  const { data: history = [] } = useQuery({ queryKey: ["reminders"], queryFn: () => apiGet<ReminderRecord[]>("/reminders") });
  const [target, setTarget] = useState<OverdueInvoice | null>(null);
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const openFor = async (o: OverdueInvoice) => {
    setTarget(o);
    setSubject(`Payment reminder: invoice ${o.number}`);
    setMessage(`Hi ${o.client_name},\n\nJust a friendly reminder that invoice ${o.number} for ${fmtMoney(o.balance_due)} was due on ${o.due_date ?? "receipt"} (${o.days_overdue} days ago).\n\nCould you let us know when we can expect payment? Reply to this email if anything looks off.\n\nThanks!`);
    setEmail("");
    try {
      const clients = await apiGet<Client[]>(`/clients?q=${encodeURIComponent(o.client_name)}`);
      const hit = clients.find((c) => c.email);
      if (hit?.email) setEmail(hit.email);
    } catch { /* leave blank */ }
  };
  const send = async () => {
    if (!target || !email.trim()) { toast.error("Enter the client's email address"); return; }
    try {
      const r = await apiPost<ReminderRecord>("/reminders/send", { invoice_id: target.id, to_email: email.trim(), subject, message });
      toast.success(r.status === "sent" ? `Reminder sent to ${r.to_email}` : `Saved (${r.status}${r.error ? `: ${r.error}` : ""})`);
      setTarget(null);
      queryClient.invalidateQueries({ queryKey: ["reminders"] });
    } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <div className="mt-10">
      <div className="mb-3">
        <h2 className="font-heading text-lg font-semibold">Payment reminders</h2>
        <p className="text-xs text-muted-foreground">Overdue invoices, one manual nudge at a time. Nothing sends automatically — every reminder is approved by you.</p>
      </div>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="reminders-overdue-table">
          <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Invoice</th><th className="px-4 py-2 font-medium">Client</th><th className="px-4 py-2 font-medium">Due</th><th className="px-4 py-2 text-right font-medium">Overdue</th><th className="px-4 py-2 text-right font-medium">Balance</th><th className="px-4 py-2"></th></tr></thead>
          <tbody>
            {overdue.map((o) => (
              <tr key={o.id} className="border-b border-border last:border-0" data-testid={`reminder-overdue-${o.id}`}>
                <td className="px-4 py-2 font-mono text-xs">{o.number}</td>
                <td className="px-4 py-2">{o.client_name}</td>
                <td className="px-4 py-2">{o.due_date ? fmtDate(o.due_date) : "—"}</td>
                <td className="px-4 py-2 text-right"><Pill tone={o.days_overdue > 30 ? "danger" : "warning"}>{o.days_overdue}d</Pill></td>
                <td className="px-4 py-2 text-right font-mono">{fmtMoney(o.balance_due)}</td>
                <td className="px-4 py-2 text-right">{writable && <Button size="xs" variant="outline" onClick={() => void openFor(o)} data-testid={`reminder-send-${o.id}`}><Mail className="size-3" /> Remind</Button>}</td>
              </tr>
            ))}
            {overdue.length === 0 && <EmptyRow cols={6} text="Nothing overdue — every sent invoice is paid or not yet due." />}
          </tbody>
        </table>
      </Panel>
      {history.length > 0 && (
        <Panel className="mt-4 overflow-hidden">
          <div className="border-b border-border px-4 py-2 label-caps">Sent reminders</div>
          <table className="w-full text-sm" data-testid="reminders-history-table">
            <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Sent</th><th className="px-4 py-2 font-medium">Invoice</th><th className="px-4 py-2 font-medium">To</th><th className="px-4 py-2 font-medium">Status</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 text-xs text-muted-foreground">{fmtDateTime(h.sent_at)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{h.number}</td>
                  <td className="px-4 py-2">{h.to_email}</td>
                  <td className="px-4 py-2"><Pill tone={h.status === "sent" ? "success" : h.status === "logged" ? "neutral" : "danger"}>{h.status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="sm:max-w-md" data-testid="reminder-dialog">
          <DialogHeader><DialogTitle>Remind {target?.client_name} · {target?.number}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="To"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="client@example.com" data-testid="reminder-email" /></Field>
            <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="reminder-subject" /></Field>
            <Field label="Message"><textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={8} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" data-testid="reminder-message" /></Field>
          </div>
          <DialogFooter><Button onClick={() => void send()} data-testid="reminder-send-button"><Send className="size-3" /> Send reminder</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
