import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, Paperclip, Store } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { businessToday, errMsg, fmtDate, fmtMoney } from "@/lib/format";
import { queryClient } from "@/lib/queryClient";
import type { ExpenseIn, ExpenseRow, PayMethod, Vendor, VendorIn } from "@/lib/types";
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="expense-dialog">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogHeader><DialogTitle>New expense</DialogTitle></DialogHeader>
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
