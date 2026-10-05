import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, Paperclip, Store, Sparkles, FileText, RefreshCw } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { businessToday, errMsg, fmtDate, fmtMoney } from "@/lib/format";
import { queryClient } from "@/lib/queryClient";
import type { Bill, ExpenseIn, ExpenseRow, PayMethod, Recurring, ReceiptScan, Vendor, VendorIn } from "@/lib/types";
import { can, useMe } from "@/hooks/useMe";
import { EmptyRow, Field, NativeSelect, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const METHODS: PayMethod[] = ["cash", "card", "bank", "other"];

export default function Expenses() {
  const { data: me } = useMe();
  const writable = can(me, "txn:write");
  const [open, setOpen] = useState(false);
  const [vopen, setVopen] = useState(false);
  const blank: ExpenseIn = { date: businessToday(), category: "Rent", amount: 0, description: "", vendor_id: null, payment_method: "bank", receipt_url: null, receipt_name: "" };
  const [f, setF] = useState<ExpenseIn>(blank);
  const [vf, setVf] = useState<VendorIn>({ name: "", contact_name: "", email: "", phone: "", notes: "" });

  const { data: expenses = [] } = useQuery({ queryKey: ["expenses"], queryFn: () => apiGet<ExpenseRow[]>("/expenses") });
  const { data: vendors = [] } = useQuery({ queryKey: ["vendors"], queryFn: () => apiGet<Vendor[]>("/vendors") });
  const { data: categories = [] } = useQuery({ queryKey: ["expense-categories"], queryFn: () => apiGet<string[]>("/expense-categories") });

  const invalidate = () => { queryClient.invalidateQueries({ queryKey: ["expenses"] }); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); };

  const create = useMutation({
    mutationFn: () => apiPost<ExpenseRow>("/expenses", f),
    onSuccess: () => { toast.success("Expense recorded"); invalidate(); setOpen(false); setF(blank); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const createVendor = useMutation({
    mutationFn: () => apiPost<Vendor>("/vendors", vf),
    onSuccess: () => { toast.success("Vendor added"); queryClient.invalidateQueries({ queryKey: ["vendors"] }); setVopen(false); setVf({ name: "", contact_name: "", email: "", phone: "", notes: "" }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/expenses/${id}`),
    onSuccess: () => { toast.success("Expense reversed"); invalidate(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const onReceipt = (file?: File) => {
    if (!file) return;
    if (file.size > 400_000) { toast.error("Receipt too large (max ~400 KB)"); return; }
    const r = new FileReader();
    r.onload = () => setF((s) => ({ ...s, receipt_url: String(r.result), receipt_name: file.name }));
    r.readAsDataURL(file);
  };

  const [scanning, setScanning] = useState(false);
  const onScan = (file?: File) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = async () => {
      setScanning(true);
      try {
        const d = await apiPost<ReceiptScan>("/expenses/scan-receipt", { image: String(r.result) });
        setF((s) => ({ ...s, category: d.category || s.category, amount: d.amount || s.amount, date: d.date || s.date,
          description: d.description || (d.vendor ? `${d.vendor}` : s.description), receipt_url: String(r.result), receipt_name: file.name }));
        toast.success("Receipt read — check the details and save");
      } catch (e) { toast.error(errMsg(e)); } finally { setScanning(false); }
    };
    r.readAsDataURL(file);
  };

  const total = expenses.filter((e) => !e.reversal_of).reduce((s, e) => s + (e.reversed_by ? 0 : e.amount), 0);

  return (
    <div>
      <PageHeader title="Expenses" eyebrow="Operating costs"
        subtitle="Day-to-day operating expenses with vendors and receipts. Inventory purchases are recorded in Procurement and capitalized — not expensed here.">
        {writable && <><Button size="sm" variant="outline" onClick={() => setVopen(true)} data-testid="vendor-new-button"><Store /> Add vendor</Button>
          <Button size="sm" onClick={() => setOpen(true)} data-testid="expense-new-button"><Plus /> New expense</Button></>}
      </PageHeader>

      <Panel className="mb-4 p-4 flex items-center justify-between">
        <span className="label-caps">Total operating expenses</span>
        <span className="font-heading text-2xl font-semibold tabular-nums" data-testid="expenses-total">{fmtMoney(total)}</span>
      </Panel>

      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="expenses-table">
          <thead><tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">Date</th><th className="px-4 py-2 font-medium">Category</th><th className="px-4 py-2 font-medium">Vendor</th>
            <th className="px-4 py-2 font-medium">Description</th><th className="px-4 py-2 font-medium">Method</th><th className="px-4 py-2 font-medium">Receipt</th>
            <th className="px-4 py-2 text-right font-medium">Amount</th><th className="px-4 py-2"></th></tr></thead>
          <tbody>
            {expenses.map((e) => (
              <tr key={e.id} className={`border-b border-border last:border-0 ${e.reversed_by ? "opacity-50 line-through" : ""}`} data-testid={`expense-row-${e.id}`}>
                <td className="px-4 py-2 whitespace-nowrap">{fmtDate(e.date)}</td>
                <td className="px-4 py-2">{e.category}</td>
                <td className="px-4 py-2">{e.vendor_name ?? "—"}</td>
                <td className="px-4 py-2 text-muted-foreground">{e.description}</td>
                <td className="px-4 py-2"><Pill tone="neutral">{e.payment_method}</Pill></td>
                <td className="px-4 py-2">{e.receipt_url ? <a href={e.receipt_url} download={e.receipt_name || "receipt"} className="inline-flex items-center gap-1 text-primary"><Paperclip className="size-3" /> view</a> : "—"}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{fmtMoney(e.amount)}</td>
                <td className="px-4 py-2 text-right">{writable && !e.reversed_by && <Button size="icon-sm" variant="ghost" onClick={() => remove.mutate(e.id)} data-testid={`expense-delete-${e.id}`}><Trash2 /></Button>}</td>
              </tr>
            ))}
            {expenses.length === 0 && <EmptyRow cols={8} text="No expenses recorded yet." />}
          </tbody>
        </table>
      </Panel>

      <BillsSection writable={writable} vendors={vendors} categories={categories} />
      <RecurringSection writable={writable} vendors={vendors} categories={categories} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="expense-dialog">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogHeader><DialogTitle>New expense</DialogTitle></DialogHeader>
            <div className="rounded-md border border-dashed border-border p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Sparkles className="size-3.5" /> Scan a receipt to auto-fill (AI)</div>
              <Input type="file" accept="image/*" disabled={scanning} onChange={(e) => onScan(e.target.files?.[0])} data-testid="expense-scan" />
              {scanning && <p className="mt-1 text-[11px] text-muted-foreground">Reading receipt…</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} data-testid="expense-date" /></Field>
              <Field label="Amount"><Input type="number" step="0.01" min={0.01} required value={f.amount || ""} onChange={(e) => setF({ ...f, amount: Number(e.target.value) })} className="font-mono" data-testid="expense-amount" /></Field>
              <Field label="Category"><NativeSelect value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} data-testid="expense-category">
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}</NativeSelect></Field>
              <Field label="Payment method"><NativeSelect value={f.payment_method} onChange={(e) => setF({ ...f, payment_method: e.target.value as PayMethod })} data-testid="expense-method">
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</NativeSelect></Field>
              <Field label="Vendor" className="col-span-2"><NativeSelect value={f.vendor_id ?? ""} onChange={(e) => setF({ ...f, vendor_id: e.target.value || null })} data-testid="expense-vendor">
                <option value="">—</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</NativeSelect></Field>
              <Field label="Description" className="col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} data-testid="expense-description" /></Field>
              <Field label="Receipt (optional)" className="col-span-2" hint={f.receipt_name || "Image or PDF, max ~400 KB"}>
                <Input type="file" accept="image/*,application/pdf" onChange={(e) => onReceipt(e.target.files?.[0])} data-testid="expense-receipt" /></Field>
            </div>
            <DialogFooter><Button type="submit" disabled={create.isPending} data-testid="expense-save-button">Record expense</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={vopen} onOpenChange={setVopen}>
        <DialogContent className="sm:max-w-md" data-testid="vendor-dialog">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); createVendor.mutate(); }}>
            <DialogHeader><DialogTitle>Add vendor</DialogTitle></DialogHeader>
            <Field label="Name"><Input required value={vf.name} onChange={(e) => setVf({ ...vf, name: e.target.value })} data-testid="vendor-name" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Contact"><Input value={vf.contact_name} onChange={(e) => setVf({ ...vf, contact_name: e.target.value })} data-testid="vendor-contact" /></Field>
              <Field label="Phone"><Input value={vf.phone} onChange={(e) => setVf({ ...vf, phone: e.target.value })} data-testid="vendor-phone" /></Field>
              <Field label="Email" className="col-span-2"><Input value={vf.email} onChange={(e) => setVf({ ...vf, email: e.target.value })} data-testid="vendor-email" /></Field>
            </div>
            <DialogFooter><Button type="submit" disabled={createVendor.isPending} data-testid="vendor-save-button">Add vendor</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BillsSection({ writable, vendors, categories }: { writable: boolean; vendors: Vendor[]; categories: string[] }) {
  const { data: bills = [] } = useQuery({ queryKey: ["bills"], queryFn: () => apiGet<Bill[]>("/bills") });
  const { data: ap } = useQuery({ queryKey: ["ap-summary"], queryFn: () => apiGet<{ accounts_payable: number; open_bills: number; open_balance: number }>("/bills/ap-summary") });
  const [open, setOpen] = useState(false);
  const blank = { vendor_id: null as string | null, date: businessToday(), due_date: null as string | null, category: categories[0] || "Supplies", amount: 0, is_inventory: false, description: "" };
  const [f, setF] = useState(blank);
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["bills"] }); queryClient.invalidateQueries({ queryKey: ["ap-summary"] }); queryClient.invalidateQueries({ queryKey: ["books-overview"] }); };
  const create = useMutation({ mutationFn: () => apiPost("/bills", f), onSuccess: () => { toast.success("Bill recorded"); refresh(); setOpen(false); setF(blank); }, onError: (e) => toast.error(errMsg(e)) });
  const pay = (id: string, bal: number) => { const v = prompt(`Pay bill — balance ${fmtMoney(bal)}`, String(bal)); if (v) apiPost(`/bills/${id}/pay`, { amount: Number(v), method: "bank" }).then(() => { toast.success("Bill payment recorded"); refresh(); }).catch((e) => toast.error(errMsg(e))); };
  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3"><h2 className="font-heading text-lg font-semibold">Vendor bills (A/P)</h2>{ap && <Pill tone={ap.accounts_payable > 0 ? "warning" : "neutral"}>Owed {fmtMoney(ap.accounts_payable)}</Pill>}</div>
        {writable && <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="bill-new-button"><FileText /> New bill</Button>}
      </div>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="bills-table">
          <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Date</th><th className="px-4 py-2 font-medium">Vendor</th><th className="px-4 py-2 font-medium">Category</th><th className="px-4 py-2 text-right font-medium">Amount</th><th className="px-4 py-2 text-right font-medium">Balance</th><th className="px-4 py-2 font-medium">Status</th><th className="px-4 py-2"></th></tr></thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">{fmtDate(b.date)}</td><td className="px-4 py-2">{b.vendor_name ?? "—"}</td>
                <td className="px-4 py-2">{b.category}{b.is_inventory ? " · stock" : ""}</td>
                <td className="px-4 py-2 text-right font-mono">{fmtMoney(b.amount)}</td>
                <td className="px-4 py-2 text-right font-mono">{fmtMoney(b.balance)}</td>
                <td className="px-4 py-2"><Pill tone={b.status === "paid" ? "success" : b.status === "partial" ? "warning" : "info"}>{b.status}</Pill></td>
                <td className="px-4 py-2 text-right">{writable && b.balance > 0 && <Button size="xs" onClick={() => pay(b.id, b.balance)} data-testid={`bill-pay-${b.id}`}>Pay</Button>}</td>
              </tr>
            ))}
            {bills.length === 0 && <EmptyRow cols={7} text="No vendor bills — record purchases on terms here." />}
          </tbody>
        </table>
      </Panel>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="bill-dialog">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogHeader><DialogTitle>New vendor bill</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vendor" className="col-span-2"><NativeSelect value={f.vendor_id ?? ""} onChange={(e) => setF({ ...f, vendor_id: e.target.value || null })} data-testid="bill-vendor"><option value="">—</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</NativeSelect></Field>
              <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} data-testid="bill-date" /></Field>
              <Field label="Due date"><Input type="date" value={f.due_date ?? ""} onChange={(e) => setF({ ...f, due_date: e.target.value || null })} /></Field>
              <Field label="Category"><NativeSelect value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} data-testid="bill-category">{categories.map((c) => <option key={c} value={c}>{c}</option>)}</NativeSelect></Field>
              <Field label="Amount"><Input type="number" step="0.01" min={0.01} required value={f.amount || ""} onChange={(e) => setF({ ...f, amount: Number(e.target.value) })} className="font-mono" data-testid="bill-amount" /></Field>
              <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_inventory} onChange={(e) => setF({ ...f, is_inventory: e.target.checked })} data-testid="bill-is-inventory" /> This bill is for inventory/stock (capitalize to Inventory)</label>
              <Field label="Description" className="col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            </div>
            <DialogFooter><Button type="submit" disabled={create.isPending} data-testid="bill-save-button">Record bill</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RecurringSection({ writable, vendors, categories }: { writable: boolean; vendors: Vendor[]; categories: string[] }) {
  const { data: items = [] } = useQuery({ queryKey: ["recurring"], queryFn: () => apiGet<Recurring[]>("/recurring") });
  const [open, setOpen] = useState(false);
  const blank = { name: "", category: categories[0] || "Rent", amount: 0, payment_method: "bank" as PayMethod, vendor_id: null as string | null, day_of_month: 1, active: true };
  const [f, setF] = useState(blank);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["recurring"] });
  const create = useMutation({ mutationFn: () => apiPost("/recurring", f), onSuccess: () => { toast.success("Recurring expense added"); refresh(); setOpen(false); setF(blank); }, onError: (e) => toast.error(errMsg(e)) });
  const runNow = (id: string) => apiPost(`/recurring/${id}/run`, {}).then(() => { toast.success("Posted this month's expense"); queryClient.invalidateQueries({ queryKey: ["expenses"] }); }).catch((e) => toast.error(errMsg(e)));
  const del = (id: string) => apiDelete(`/recurring/${id}`).then(refresh);
  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-heading text-lg font-semibold">Recurring expenses</h2>
        {writable && <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="recurring-new-button"><RefreshCw /> Add recurring</Button>}
      </div>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="recurring-table">
          <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Name</th><th className="px-4 py-2 font-medium">Category</th><th className="px-4 py-2 text-right font-medium">Amount</th><th className="px-4 py-2 font-medium">Day</th><th className="px-4 py-2 font-medium">Last run</th><th className="px-4 py-2"></th></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">{r.name}</td><td className="px-4 py-2">{r.category}</td>
                <td className="px-4 py-2 text-right font-mono">{fmtMoney(r.amount)}</td><td className="px-4 py-2">{r.day_of_month}</td>
                <td className="px-4 py-2 text-muted-foreground">{r.last_run ?? "—"}</td>
                <td className="px-4 py-2 text-right">{writable && <span className="flex justify-end gap-1"><Button size="xs" variant="outline" onClick={() => runNow(r.id)} data-testid={`recurring-run-${r.id}`}>Post now</Button><Button size="icon-sm" variant="ghost" onClick={() => del(r.id)}><Trash2 /></Button></span>}</td>
              </tr>
            ))}
            {items.length === 0 && <EmptyRow cols={6} text="Add rent, booth rent or subscriptions — they post automatically each month." />}
          </tbody>
        </table>
      </Panel>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="recurring-dialog">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogHeader><DialogTitle>Recurring expense</DialogTitle></DialogHeader>
            <Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="recurring-name" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category"><NativeSelect value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} data-testid="recurring-category">{categories.map((c) => <option key={c} value={c}>{c}</option>)}</NativeSelect></Field>
              <Field label="Amount"><Input type="number" step="0.01" min={0.01} required value={f.amount || ""} onChange={(e) => setF({ ...f, amount: Number(e.target.value) })} className="font-mono" data-testid="recurring-amount" /></Field>
              <Field label="Day of month"><Input type="number" min={1} max={28} value={f.day_of_month} onChange={(e) => setF({ ...f, day_of_month: Number(e.target.value) })} data-testid="recurring-day" /></Field>
              <Field label="Vendor"><NativeSelect value={f.vendor_id ?? ""} onChange={(e) => setF({ ...f, vendor_id: e.target.value || null })}><option value="">—</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</NativeSelect></Field>
            </div>
            <DialogFooter><Button type="submit" disabled={create.isPending} data-testid="recurring-save-button">Save</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
