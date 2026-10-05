import { businessToday } from "@/lib/format";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2, Undo2 } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { errMsg, fmtDate, fmtMoney } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { PayMethod, Pnl, ReverseIn, Transaction, TransactionIn, TxnKind } from "@/lib/types";
import { can, useMe, useTeam } from "@/hooks/useMe";
import { EmptyRow, Field, NativeSelect, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const today = () => businessToday();
const monthStart = () => today().slice(0, 8) + "01";

function PnlPanel() {
  const [basis, setBasis] = useState<"cash" | "accrual">("cash");
  const [start, setStart] = useState(monthStart());
  const [end, setEnd] = useState(today());
  const { data: me } = useMe();
  const { data: pnl } = useQuery({ queryKey: ["pnl", start, end, basis], queryFn: () => apiGet<Pnl>(`/reports/pnl?start=${start}&end=${end}&basis=${basis}`), enabled: can(me, "report:read") });
  if (!can(me, "report:read")) return null;
  const row = (label: string, v: number, testId: string, strong = false) => (
    <div key={testId} className={cn("flex justify-between py-1.5 text-sm", strong && "border-t border-border pt-2 font-semibold")}>
      <span>{label}</span><span className="font-mono tabular-nums" data-testid={testId}>{fmtMoney(v)}</span>
    </div>
  );
  return (
    <Panel className="p-4 md:p-5" data-testid="pnl-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="text-base font-semibold">Profit & loss</h3>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-md border border-border p-0.5" role="group" aria-label="Accounting basis">
            {(["cash", "accrual"] as const).map((b) => (
              <Button key={b} type="button" size="sm" variant={basis === b ? "default" : "ghost"} className="h-7" onClick={() => setBasis(b)} data-testid={`pnl-basis-${b}`}>{b === "cash" ? "Cash basis" : "Accrual basis"}</Button>
            ))}
          </div>
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-36" data-testid="pnl-start-input" />
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-36" data-testid="pnl-end-input" />
        </div>
      </div>
      {pnl && (
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div>
            <div className="label-caps mb-1">Income</div>
            {pnl.income.map((c) => row(c.category, c.amount, `pnl-income-${c.category.toLowerCase().replace(/\W+/g, "-")}`))}
            {row("Total income", pnl.total_income, "pnl-total-income", true)}
            <div className="label-caps mb-1 mt-4">Expenses</div>
            {pnl.expenses.map((c) => row(c.category, c.amount, `pnl-expense-${c.category.toLowerCase().replace(/\W+/g, "-")}`))}
            {row("Total expenses", pnl.total_expenses, "pnl-total-expenses", true)}
            {row("Net profit", pnl.net_profit, "pnl-net-profit", true)}
            <ul className="mt-3 space-y-1 text-[11px] text-muted-foreground" data-testid="pnl-notes">
              {pnl.notes.map((n) => <li key={n}>• {n}</li>)}
              {pnl.basis === "accrual" && pnl.inventory_purchases_excluded > 0 && <li>• Stock purchases excluded: {fmtMoney(pnl.inventory_purchases_excluded)}</li>}
            </ul>
          </div>
          {pnl.retail && (
            <div className="rounded-lg border border-border bg-muted/30 p-4" data-testid="pnl-retail-section">
              <div className="label-caps mb-1">Retail (from stock ledger)</div>
              {row("Retail sales", pnl.retail.retail_sales, "pnl-retail-sales")}
              {row("Cost of goods sold", pnl.retail.retail_cogs, "pnl-retail-cogs")}
              {row("Retail gross profit", pnl.retail.retail_gross_profit, "pnl-retail-gross", true)}
              {row("Supplies used in services", pnl.retail.supply_usage_cost, "pnl-supply-usage")}
              <p className="mt-3 text-[11px] text-muted-foreground">{pnl.basis === "cash" ? "Cash basis: restock purchases are in expenses; COGS here is for reference and is not deducted again." : "Accrual basis: COGS replaces stock purchases in expenses — inventory is never counted twice."}</p>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

export default function Money() {
  const { data: me } = useMe();
  const { data: team = [] } = useTeam();
  const [kind, setKind] = useState<"" | TxnKind>("");
  const [f, setF] = useState<TransactionIn>({ kind: "income", category: "Services", amount: 0, date: today(), description: "", barber_id: null, payment_method: "cash" });
  const { data: txns = [], isLoading } = useQuery({ queryKey: ["transactions", kind], queryFn: () => apiGet<Transaction[]>(`/transactions${kind ? `?kind=${kind}` : ""}`) });

  const add = useMutation({
    mutationFn: () => apiPost<Transaction>("/transactions", f),
    onSuccess: () => { toast.success("Recorded"); invalidateInventory(); setF((s) => ({ ...s, amount: 0, description: "" })); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/transactions/${id}`),
    onSuccess: () => { toast.success("Reversed — the original and its reversal both stay in the books"); invalidateInventory(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const reverse = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => apiPost<Transaction>(`/transactions/${id}/reverse`, { reason } satisfies ReverseIn),
    onSuccess: () => { toast.success("Correction posted"); invalidateInventory(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const askReverse = (t: Transaction) => {
    const reason = window.prompt(`Why are you reversing “${t.description || t.category}”? (kept in the audit log)`);
    if (reason && reason.trim().length >= 3) reverse.mutate({ id: t.id, reason: reason.trim() });
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Money & P&L" subtitle="Every dollar in and out. Stock purchases and retail sales are linked here automatically." />
      <PnlPanel />
      {can(me, "txn:write") && (
        <Panel className="p-4">
          <form className="grid grid-cols-2 gap-3 md:grid-cols-6 md:items-end" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <Field label="Type">
              <NativeSelect value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as TxnKind, category: e.target.value === "income" ? "Services" : "Rent" })} data-testid="txn-kind-select">
                <option value="income">Income</option><option value="expense">Expense</option>
              </NativeSelect>
            </Field>
            <Field label="Category"><Input required value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} data-testid="txn-category-input" /></Field>
            <Field label="Amount ($)"><Input required type="number" step="0.01" min={0.01} value={f.amount || ""} onChange={(e) => setF({ ...f, amount: Number(e.target.value) })} className="font-mono" data-testid="txn-amount-input" /></Field>
            <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} data-testid="txn-date-input" /></Field>
            <Field label="Barber">
              <NativeSelect value={f.barber_id ?? ""} onChange={(e) => setF({ ...f, barber_id: e.target.value || null })} data-testid="txn-barber-select">
                <option value="">—</option>{team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </NativeSelect>
            </Field>
            <Button type="submit" disabled={add.isPending} data-testid="txn-add-button"><Plus /> Add</Button>
            <Field label="Paid by">
              <NativeSelect value={f.payment_method} onChange={(e) => setF({ ...f, payment_method: e.target.value as PayMethod })} data-testid="txn-method-select">
                <option value="cash">Cash</option><option value="card">Card (recorded)</option><option value="bank">Bank transfer</option><option value="other">Other</option>
              </NativeSelect>
            </Field>
            <Field label="Description" className="col-span-2 md:col-span-5"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} data-testid="txn-description-input" /></Field>
          </form>
        </Panel>
      )}
      <Panel>
        <div className="flex gap-1 border-b border-border p-3">
          {(["", "income", "expense"] as const).map((k) => (
            <Button key={k} size="sm" variant={kind === k ? "default" : "ghost"} onClick={() => setKind(k)} data-testid={`txn-filter-${k || "all"}`}>{k ? k[0].toUpperCase() + k.slice(1) : "All"}</Button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="label-caps">Date</TableHead><TableHead className="label-caps">Description</TableHead>
              <TableHead className="label-caps hidden md:table-cell">Category</TableHead><TableHead className="label-caps hidden md:table-cell">Barber</TableHead>
              <TableHead className="label-caps text-right">Amount</TableHead><TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {txns.map((t) => (
                <TableRow key={t.id} data-testid={`txn-row-${t.id}`}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(t.date)}</TableCell>
                  <TableCell>
                    <div className="text-sm">{t.description || t.category}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {t.source !== "manual" && <Pill tone="info">{t.source === "inventory" ? "From stock" : "From invoice"}</Pill>}
                      {t.processor === "stripe" && <Pill tone="success" testId={`txn-processed-${t.id}`}>Processed · Stripe</Pill>}
                      {t.payment_method !== "other" && t.processor !== "stripe" && <Pill tone="neutral">{t.payment_method}</Pill>}
                      {t.reversal_of && <Pill tone="warning" testId={`txn-reversal-${t.id}`}>Reversal</Pill>}
                      {t.reversed_by && <Pill tone="neutral" testId={`txn-reversed-${t.id}`}>Reversed</Pill>}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm">{t.category}</TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{t.barber_name ?? "—"}</TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", t.kind === "income" ? "text-emerald-600 dark:text-emerald-400" : "text-red-500")}>
                    {(t.kind === "income") === (t.amount >= 0) ? "+" : "−"}{fmtMoney(Math.abs(t.amount))}
                  </TableCell>
                  <TableCell className="text-right">
                    {!t.reversal_of && !t.reversed_by && (can(me, "txn:adjust") && t.source !== "inventory" ? (
                      <Button variant="ghost" size="icon-sm" onClick={() => askReverse(t)} data-testid={`txn-reverse-${t.id}`} aria-label="Reverse entry" title="Reverse (correction)"><Undo2 /></Button>
                    ) : t.source === "manual" && can(me, "txn:write") ? (
                      <Button variant="ghost" size="icon-sm" onClick={() => del.mutate(t.id)} data-testid={`txn-delete-${t.id}`} aria-label="Remove (posts a reversal)"><Trash2 /></Button>
                    ) : null)}
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && txns.length === 0 && <EmptyRow cols={6} text="No transactions yet." />}
            </TableBody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}
