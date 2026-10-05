import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ClipboardList, FileUp, Mail, PackageCheck, ShieldCheck, ShieldAlert, Pencil, Scale, Plus, Sparkles, Trash2, Truck } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { errMsg, fmtDate, fmtMoney } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { OutboxEmail, POApprovalIn, POCreate, PriceListIn, PriceListResult, POStatus, Product, PurchaseOrder, ReorderSuggestion, Supplier, SupplierIn } from "@/lib/types";
import { can, useMe } from "@/hooks/useMe";
import { EmptyRow, Field, NativeSelect, PageHeader, Panel, POBadge, Stat, UrgencyBadge } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import ReceiveDialog from "@/components/procurement/ReceiveDialog";
import Scorecards from "@/components/procurement/Scorecards";
import PriceCompare from "@/components/procurement/PriceCompare";
import AiPlan from "@/components/procurement/AiPlan";

const NEXT: Record<POStatus, POStatus[]> = { draft: ["ordered", "cancelled"], ordered: ["received", "cancelled"], partial: ["received", "cancelled"], received: [], cancelled: [] };
const LABEL: Record<POStatus, string> = { draft: "Draft", ordered: "Mark ordered", partial: "Backorder", received: "Receive all", cancelled: "Cancel" };

function Reorder() {
  const { data: me } = useMe();
  const [sel, setSel] = useState<string[]>([]);
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["reorder"], queryFn: () => apiGet<ReorderSuggestion[]>("/inventory/reorder") });
  const create = useMutation({
    mutationFn: () => apiPost<PurchaseOrder[]>("/inventory/reorder/create-pos", { product_ids: sel }),
    onSuccess: (pos) => { toast.success(pos.length ? `Created ${pos.length} draft PO(s): ${pos.map((p) => p.number).join(", ")}` : "No POs created — selected items need a supplier"); setSel([]); invalidateInventory(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const est = rows.filter((r) => sel.includes(r.product_id)).reduce((s, r) => s + r.estimated_cost, 0);
  return (
    <Panel>
      <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">Built-in rules: last 30 days of sales + use, supplier lead time, reorder point and stock already on order. No outside services.</p>
        {can(me, "po:write") && (
          <Button size="sm" disabled={!sel.length || create.isPending} onClick={() => create.mutate()} data-testid="reorder-create-pos-button">
            <ClipboardList /> Draft POs ({sel.length}) · {fmtMoney(est)}
          </Button>
        )}
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead className="w-8"><Checkbox checked={rows.length > 0 && sel.length === rows.length} onCheckedChange={(c) => setSel(c ? rows.map((r) => r.product_id) : [])} data-testid="reorder-select-all" /></TableHead>
            <TableHead className="label-caps">Product</TableHead><TableHead className="label-caps text-right">On hand</TableHead>
            <TableHead className="label-caps hidden text-right md:table-cell">Per day</TableHead><TableHead className="label-caps hidden text-right md:table-cell">Cover</TableHead>
            <TableHead className="label-caps text-right">Order</TableHead><TableHead className="label-caps hidden sm:table-cell">Supplier</TableHead><TableHead className="label-caps">Urgency</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.product_id} data-testid={`reorder-row-${r.product_id}`}>
                <TableCell><Checkbox checked={sel.includes(r.product_id)} onCheckedChange={(c) => setSel((s) => (c ? [...s, r.product_id] : s.filter((x) => x !== r.product_id)))} data-testid={`reorder-select-${r.product_id}`} /></TableCell>
                <TableCell><Link to={`/inventory/products/${r.product_id}`} className="text-sm hover:underline">{r.name}</Link>{r.incoming > 0 && <div className="text-[11px] text-muted-foreground">{r.incoming} on order</div>}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{r.quantity_on_hand}</TableCell>
                <TableCell className="hidden text-right font-mono text-xs tabular-nums md:table-cell">{r.daily_velocity}</TableCell>
                <TableCell className="hidden text-right font-mono text-xs tabular-nums md:table-cell">{r.days_of_cover === null ? "—" : `${r.days_of_cover}d`}</TableCell>
                <TableCell className="text-right font-mono font-semibold tabular-nums" data-testid={`reorder-qty-${r.product_id}`}>{r.suggested_qty}</TableCell>
                <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{r.supplier_name ?? "No supplier"}</TableCell>
                <TableCell><UrgencyBadge urgency={r.urgency} /></TableCell>
              </TableRow>
            ))}
            {!isLoading && rows.length === 0 && <EmptyRow cols={8} text="Nothing needs reordering." />}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}

function Orders() {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<POCreate>({ supplier_id: "", lines: [], expected_date: null, notes: "" });
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null);
  const { data: pos = [] } = useQuery({ queryKey: ["pos"], queryFn: () => apiGet<PurchaseOrder[]>("/inventory/purchase-orders") });
  const { data: suppliers = [] } = useQuery({ queryKey: ["suppliers"], queryFn: () => apiGet<Supplier[]>("/inventory/suppliers") });
  const { data: products = [] } = useQuery({ queryKey: ["products", ""], queryFn: () => apiGet<Product[]>("/inventory/products"), enabled: open });
  const status = useMutation({
    mutationFn: ({ id, s }: { id: string; s: POStatus }) => apiPost<PurchaseOrder>(`/inventory/purchase-orders/${id}/status`, { status: s }),
    onSuccess: (po) => { toast.success(po.status === "received" ? `${po.number} received — stock and expense posted` : `${po.number} → ${po.status}`); invalidateInventory(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/inventory/purchase-orders/${id}`),
    onSuccess: () => { toast.success("Draft deleted"); invalidateInventory(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const approval = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => apiPost<PurchaseOrder>(`/inventory/purchase-orders/${id}/approval`, { approve, note: approve ? "" : "Rejected" } satisfies POApprovalIn),
    onSuccess: (po) => { toast.success(po.status === "cancelled" ? `${po.number} rejected` : `${po.number} approved — ready to order`); invalidateInventory(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const email = useMutation({
    mutationFn: (po: PurchaseOrder) => apiPost<OutboxEmail>(`/inventory/purchase-orders/${po.id}/email`, { mark_ordered: true, message: "" }),
    onSuccess: (e) => {
      if (e.status === "sent") toast.success(`Emailed to ${e.to}`);
      else if (e.status === "logged") toast.info(`SMTP not set up — email to ${e.to} saved in Settings → outbox`);
      else toast.error(`Send failed: ${e.error}`);
      invalidateInventory();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const create = useMutation({
    mutationFn: () => apiPost<PurchaseOrder>("/inventory/purchase-orders", f),
    onSuccess: (po) => { toast.success(`${po.number} drafted`); setOpen(false); invalidateInventory(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const openPos = pos.filter((p) => p.status === "draft" || p.status === "ordered" || p.status === "partial");
  const usable = products.filter((p) => p.tracking_mode !== "serial");

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Open orders" testId="po-open-count" value={String(openPos.length)} />
        <Stat label="Committed spend" testId="po-open-value" value={fmtMoney(openPos.reduce((s, p) => s + p.total, 0))}
          sub={pos.some((p) => p.awaiting_approval) ? `${pos.filter((p) => p.awaiting_approval).length} awaiting owner approval` : undefined} />
        {can(me, "po:write") && (
          <Button className="col-span-2 h-full min-h-12 md:col-span-1" onClick={() => { setF({ supplier_id: suppliers[0]?.id ?? "", lines: [], expected_date: null, notes: "" }); setOpen(true); }} data-testid="po-new-button"><Plus /> New purchase order</Button>
        )}
      </div>
      {pos.map((po) => (
        <Panel key={po.id} className="p-4" data-testid={`po-card-${po.number}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2"><span className="font-mono text-sm font-semibold">{po.number}</span><POBadge status={po.status} testId={`po-status-${po.number}`} />
                {po.awaiting_approval && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300" data-testid={`po-awaiting-${po.number}`}><ShieldAlert className="size-3" /> Needs owner approval</span>}
                {po.approved_by && <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600" data-testid={`po-approved-${po.number}`}><ShieldCheck className="size-3" /> Approved by {po.approved_by}</span>}</div>
              <div className="text-sm">{po.supplier_name}</div>
              <div className="text-[11px] text-muted-foreground">Created {fmtDate(po.created_at)} by {po.created_by}{po.expected_date ? ` · expected ${fmtDate(po.expected_date)}` : ""}{po.received_at ? ` · received ${fmtDate(po.received_at)}` : ""}{po.emailed_at ? ` · emailed ${fmtDate(po.emailed_at)}` : ""}</div>
            </div>
            <div className="font-heading text-lg font-semibold tabular-nums">{fmtMoney(po.total)}</div>
          </div>
          <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            {po.lines.map((l) => <div key={l.product_id}>{l.quantity} × {l.name} @ {fmtMoney(l.unit_cost)}{l.received_qty > 0 && <span className={l.received_qty >= l.quantity ? "text-emerald-600" : "text-amber-600"}> · {l.received_qty}/{l.quantity} in{l.received_qty < l.quantity && po.status === "partial" ? ` · ${l.quantity - l.received_qty} on backorder` : ""}</span>}</div>)}
          </div>
          {can(me, "po:write") && (NEXT[po.status].length > 0) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {po.awaiting_approval && can(me, "po:approve") && (
                <>
                  <Button size="xs" onClick={() => approval.mutate({ id: po.id, approve: true })} disabled={approval.isPending} data-testid={`po-approve-${po.number}`}><ShieldCheck /> Approve</Button>
                  <Button size="xs" variant="ghost" onClick={() => approval.mutate({ id: po.id, approve: false })} disabled={approval.isPending} data-testid={`po-reject-${po.number}`}>Reject</Button>
                </>
              )}
              {NEXT[po.status].filter((s) => !(po.awaiting_approval && s === "ordered")).map((s) => (
                <Button key={s} size="xs" variant={s === "cancelled" ? "ghost" : "default"} onClick={() => status.mutate({ id: po.id, s })} disabled={status.isPending} data-testid={`po-${s}-${po.number}`}>{LABEL[s]}</Button>
              ))}
              {(po.status === "ordered" || po.status === "partial") && (
                <Button size="xs" variant="outline" onClick={() => setReceiving(po)} data-testid={`po-receive-some-${po.number}`}><PackageCheck /> Receive some</Button>
              )}
              {(po.status === "draft" || po.status === "ordered" || po.status === "partial") && !po.awaiting_approval && (
                <Button size="xs" variant="outline" onClick={() => email.mutate(po)} disabled={email.isPending} data-testid={`po-email-${po.number}`}><Mail /> Email supplier</Button>
              )}
              {po.status === "draft" && can(me, "po:delete") && <Button size="xs" variant="ghost" onClick={() => del.mutate(po.id)} data-testid={`po-delete-${po.number}`}><Trash2 /> Delete</Button>}
            </div>
          )}
        </Panel>
      ))}
      <ReceiveDialog po={receiving} onClose={() => setReceiving(null)} />
      {pos.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No purchase orders yet. Draft them from Reorder suggestions in one click.</p>}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg" data-testid="po-dialog">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogHeader><DialogTitle>New purchase order</DialogTitle><DialogDescription>Receiving it later posts a restock movement per line and one expense.</DialogDescription></DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Supplier">
                <NativeSelect required value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })} data-testid="po-supplier-select">
                  <option value="">Choose…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Expected"><Input type="date" value={f.expected_date ?? ""} onChange={(e) => setF({ ...f, expected_date: e.target.value || null })} data-testid="po-expected-input" /></Field>
            </div>
            <div className="space-y-2">
              <div className="label-caps">Lines</div>
              {f.lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_60px_80px_auto] gap-2">
                  <NativeSelect value={l.product_id} onChange={(e) => { const p = usable.find((x) => x.id === e.target.value); setF({ ...f, lines: f.lines.map((x, j) => (j === i ? { ...x, product_id: e.target.value, unit_cost: p?.unit_cost ?? 0 } : x)) }); }} data-testid={`po-line-product-${i}`}>
                    <option value="">Product…</option>{usable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </NativeSelect>
                  <Input type="number" min={1} value={l.quantity} onChange={(e) => setF({ ...f, lines: f.lines.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)) })} className="font-mono" data-testid={`po-line-qty-${i}`} />
                  <Input type="number" step="0.01" min={0} value={l.unit_cost} onChange={(e) => setF({ ...f, lines: f.lines.map((x, j) => (j === i ? { ...x, unit_cost: Number(e.target.value) } : x)) })} className="font-mono" data-testid={`po-line-cost-${i}`} />
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })} data-testid={`po-line-remove-${i}`}><Trash2 /></Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="xs" onClick={() => setF({ ...f, lines: [...f.lines, { product_id: "", quantity: 1, unit_cost: 0 }] })} data-testid="po-add-line-button"><Plus /> Line</Button>
            </div>
            <Field label="Notes"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} data-testid="po-notes-input" /></Field>
            <DialogFooter>
              <span className="mr-auto self-center font-mono text-sm" data-testid="po-dialog-total">{fmtMoney(f.lines.reduce((s, l) => s + l.quantity * l.unit_cost, 0))}</span>
              <Button type="submit" disabled={!f.supplier_id || !f.lines.length || f.lines.some((l) => !l.product_id) || create.isPending} data-testid="po-save-button">Create draft</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const blankSup: SupplierIn = { name: "", contact_name: "", email: "", phone: "", lead_time_days: 7, notes: "" };

function Suppliers() {
  const { data: me } = useMe();
  const [edit, setEdit] = useState<Supplier | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<SupplierIn>(blankSup);
  const { data: rows = [] } = useQuery({ queryKey: ["suppliers"], queryFn: () => apiGet<Supplier[]>("/inventory/suppliers") });
  const save = useMutation({
    mutationFn: () => (edit ? apiPut<Supplier>(`/inventory/suppliers/${edit.id}`, f) : apiPost<Supplier>("/inventory/suppliers", f)),
    onSuccess: () => { toast.success("Supplier saved"); setOpen(false); invalidateInventory(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const upload = useMutation({
    mutationFn: ({ id, csv }: { id: string; csv: string }) => apiPost<PriceListResult>(`/inventory/suppliers/${id}/price-list`, { csv } satisfies PriceListIn),
    onSuccess: (r) => {
      toast.success(`Price list loaded: ${r.matched} product(s) matched${r.unmatched.length ? `, ${r.unmatched.length} row(s) skipped` : ""} — see the Prices tab`);
      if (r.unmatched.length) toast.info(r.unmatched.slice(0, 3).map((u) => `Row ${u.row}: ${u.error}`).join(" · "), { duration: 8000 });
      invalidateInventory();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/inventory/suppliers/${id}`),
    onSuccess: () => { toast.success("Supplier removed"); invalidateInventory(); }, onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="space-y-3">
      {can(me, "supplier:write") && <Button size="sm" onClick={() => { setEdit(null); setF(blankSup); setOpen(true); }} data-testid="supplier-new-button"><Plus /> New supplier</Button>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((s) => (
          <Panel key={s.id} className="p-4" data-testid={`supplier-card-${s.id}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-muted-foreground">{s.contact_name}{s.phone ? ` · ${s.phone}` : ""}</div>
                {s.email && <a href={`mailto:${s.email}`} className="text-xs text-primary hover:underline">{s.email}</a>}
              </div>
              {can(me, "supplier:write") && (
                <div className="flex">
                  <Button variant="ghost" size="icon-sm" onClick={() => { setEdit(s); setF({ name: s.name, contact_name: s.contact_name, email: s.email, phone: s.phone, lead_time_days: s.lead_time_days, notes: s.notes }); setOpen(true); }} data-testid={`supplier-edit-${s.id}`}><Pencil /></Button>
                  {can(me, "supplier:delete") && <Button variant="ghost" size="icon-sm" onClick={() => { if (confirm(`Remove ${s.name}?`)) del.mutate(s.id); }} data-testid={`supplier-delete-${s.id}`}><Trash2 /></Button>}
                </div>
              )}
            </div>
            <div className="mt-3 flex gap-4 font-mono text-xs text-muted-foreground">
              <span>{s.lead_time_days}d lead</span><span>{s.product_count} products</span><span>{s.open_po_count} open POs</span>
            </div>
            {can(me, "supplier:write") && (
              <label className="mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs transition-colors duration-150 hover:bg-muted" data-testid={`supplier-pricelist-${s.id}`}>
                <FileUp className="size-3.5" /> Upload price list (CSV)
                <input type="file" accept=".csv,text/csv" className="sr-only" data-testid={`supplier-pricelist-input-${s.id}`}
                  onChange={async (e) => { const f = e.target.files?.[0]; if (f) upload.mutate({ id: s.id, csv: await f.text() }); e.target.value = ""; }} />
              </label>
            )}
          </Panel>
        ))}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="supplier-dialog">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <DialogHeader><DialogTitle>{edit ? "Edit supplier" : "New supplier"}</DialogTitle></DialogHeader>
            <Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="supplier-name-input" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Contact"><Input value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} data-testid="supplier-contact-input" /></Field>
              <Field label="Lead time (days)"><Input type="number" min={0} value={f.lead_time_days} onChange={(e) => setF({ ...f, lead_time_days: Number(e.target.value) })} data-testid="supplier-lead-input" /></Field>
              <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} data-testid="supplier-email-input" /></Field>
              <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} data-testid="supplier-phone-input" /></Field>
            </div>
            <DialogFooter><Button type="submit" disabled={save.isPending} data-testid="supplier-save-button">Save</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Procurement() {
  return (
    <div>
      <PageHeader eyebrow="Procurement add-on" title="Buy smarter" subtitle="Reorder suggestions → draft purchase orders → receive into stock with the expense posted for you." />
      <Tabs defaultValue="reorder">
        <TabsList className="mb-4 flex-wrap h-auto">
          <TabsTrigger value="reorder" data-testid="procurement-tab-reorder"><Sparkles /> Reorder</TabsTrigger>
          <TabsTrigger value="orders" data-testid="procurement-tab-orders"><ClipboardList /> Purchase orders</TabsTrigger>
          <TabsTrigger value="prices" data-testid="procurement-tab-prices"><Scale /> Prices</TabsTrigger>
          <TabsTrigger value="suppliers" data-testid="procurement-tab-suppliers"><Truck /> Suppliers</TabsTrigger>
        </TabsList>
        <TabsContent value="reorder" className="space-y-4"><AiPlan /><Reorder /></TabsContent>
        <TabsContent value="prices"><PriceCompare /></TabsContent>
        <TabsContent value="orders"><Orders /></TabsContent>
        <TabsContent value="suppliers" className="space-y-4"><Scorecards /><Suppliers /></TabsContent>
      </Tabs>
    </div>
  );
}
