import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Scale, FileSpreadsheet, BookOpen, Receipt, Boxes, TrendingUp, ListTree } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { businessToday, errMsg, fmtMoney } from "@/lib/format";
import type {
  Account, ARAging, BalanceSheet, GeneralLedger, IncomeStatement, InventoryValuation, JournalEntryView,
  SalesSummary, TrialBalance,
} from "@/lib/types";
import { PageHeader, Panel, Pill, Stat } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const monthStart = () => businessToday().slice(0, 8) + "01";

const TABS = [
  { id: "summary", label: "Sales summary", icon: TrendingUp },
  { id: "pnl", label: "Income statement", icon: FileSpreadsheet },
  { id: "balance", label: "Balance sheet", icon: Scale },
  { id: "trial", label: "Trial balance", icon: ListTree },
  { id: "gl", label: "General ledger", icon: BookOpen },
  { id: "aging", label: "A/R aging", icon: Receipt },
  { id: "inventory", label: "Inventory valuation", icon: Boxes },
  { id: "accounts", label: "Chart of accounts", icon: ListTree },
  { id: "journal", label: "Journal", icon: BookOpen },
] as const;
type TabId = (typeof TABS)[number]["id"];

function csvDownload(path: string, name: string) {
  fetch(`/api${path}`, { credentials: "include" })
    .then((r) => (r.ok ? r.blob() : Promise.reject(r)))
    .then((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    })
    .catch(() => toast.error("Export failed"));
}

function ReconcileBadge({ ok }: { ok: boolean }) {
  return <Pill tone={ok ? "success" : "danger"} testId="reconcile-badge">{ok ? "Reconciled ✓" : "Out of balance"}</Pill>;
}

function Money({ v, bold }: { v: number; bold?: boolean }) {
  return <span className={`font-mono tabular-nums ${bold ? "font-semibold" : ""} ${v < 0 ? "text-red-500" : ""}`}>{fmtMoney(v)}</span>;
}

export default function Books() {
  const [tab, setTab] = useState<TabId>("summary");
  const [start, setStart] = useState(monthStart());
  const [end, setEnd] = useState(businessToday());
  const [account, setAccount] = useState("1100");

  return (
    <div>
      <PageHeader title="Books" eyebrow="Double-entry bookkeeping"
        subtitle="Accountant-grade reports off the balanced journal. Every report reconciles to the underlying records.">
      </PageHeader>

      <div className="mb-5 flex flex-wrap gap-1.5" data-testid="books-tabs">
        {TABS.map((t) => (
          <Button key={t.id} size="sm" variant={tab === t.id ? "default" : "outline"} onClick={() => setTab(t.id)} data-testid={`books-tab-${t.id}`}>
            <t.icon className="size-3.5" /> {t.label}
          </Button>
        ))}
      </div>

      {(tab === "summary" || tab === "pnl" || tab === "gl" || tab === "journal") && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="space-y-1"><span className="text-xs text-muted-foreground">From</span>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-40" data-testid="books-start" /></label>
          <label className="space-y-1"><span className="text-xs text-muted-foreground">To</span>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-40" data-testid="books-end" /></label>
          {tab === "gl" && (
            <AccountPicker value={account} onChange={setAccount} />
          )}
        </div>
      )}

      {tab === "summary" && <SalesSummaryView start={start} end={end} />}
      {tab === "pnl" && <IncomeStatementView start={start} end={end} />}
      {tab === "balance" && <BalanceSheetView />}
      {tab === "trial" && <TrialBalanceView />}
      {tab === "gl" && <GeneralLedgerView account={account} start={start} end={end} />}
      {tab === "aging" && <AgingView />}
      {tab === "inventory" && <InventoryView />}
      {tab === "accounts" && <AccountsView />}
      {tab === "journal" && <JournalView start={start} end={end} />}
    </div>
  );
}

function AccountPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: () => apiGet<Account[]>("/books/accounts") });
  return (
    <label className="space-y-1"><span className="text-xs text-muted-foreground">Account</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} data-testid="books-gl-account"
        className="h-9 w-64 rounded-md border border-input bg-background px-2.5 text-sm">
        {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
      </select>
    </label>
  );
}

function SalesSummaryView({ start, end }: { start: string; end: string }) {
  const { data } = useQuery({ queryKey: ["sales-summary", start, end], queryFn: () => apiGet<SalesSummary>(`/books/sales-summary?start=${start}&end=${end}`) });
  if (!data) return null;
  const rows: [string, number][] = [
    ["Service revenue", data.service_revenue], ["Product revenue", data.product_revenue], ["Discounts given", -data.discounts],
    ["Net sales", data.net_sales], ["Sales tax collected", data.tax_collected], ["Tips collected", data.tips_collected],
    ["Cost of goods sold", -data.cogs], ["Gross profit", data.gross_profit], ["Processing fees", -data.processing_fees],
  ];
  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Stat label="Net sales" value={fmtMoney(data.net_sales)} testId="sum-net-sales" />
      <Stat label="Gross profit" value={fmtMoney(data.gross_profit)} testId="sum-gross-profit" />
      <Stat label="Tax collected" value={fmtMoney(data.tax_collected)} testId="sum-tax" sub="Liability — owed to tax authority" />
      <Stat label="Tips collected" value={fmtMoney(data.tips_collected)} testId="sum-tips" sub="Liability — owed to staff" />
      <Panel className="md:col-span-4 overflow-hidden">
        <table className="w-full text-sm" data-testid="sales-summary-table">
          <tbody>
            {rows.map(([l, v], i) => (
              <tr key={i} className={`border-b border-border last:border-0 ${l === "Net sales" || l === "Gross profit" ? "bg-muted/40 font-medium" : ""}`}>
                <td className="px-4 py-2.5">{l}</td>
                <td className="px-4 py-2.5 text-right"><Money v={v} bold={l.includes("profit") || l.includes("Net")} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function IncomeStatementView({ start, end }: { start: string; end: string }) {
  const { data } = useQuery({ queryKey: ["pnl-books", start, end], queryFn: () => apiGet<IncomeStatement>(`/books/income-statement?start=${start}&end=${end}`) });
  if (!data) return null;
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="label-caps">Income statement (accrual)</span>
        <Button size="xs" variant="outline" onClick={() => csvDownload(`/books/income-statement?start=${start}&end=${end}&format=csv`, "income_statement.csv")} data-testid="export-pnl"><Download className="size-3" /> CSV</Button>
      </div>
      <table className="w-full text-sm">
        <tbody>
          <tr className="bg-muted/40"><td className="px-4 py-2 font-medium" colSpan={2}>Income</td></tr>
          {data.income.map((r) => <tr key={r.code} className="border-b border-border"><td className="px-4 py-2 pl-8">{r.name}</td><td className="px-4 py-2 text-right"><Money v={r.amount} /></td></tr>)}
          <tr className="border-b border-border font-medium"><td className="px-4 py-2">Total income</td><td className="px-4 py-2 text-right"><Money v={data.total_income} bold /></td></tr>
          <tr className="bg-muted/40"><td className="px-4 py-2 font-medium" colSpan={2}>Expenses</td></tr>
          {data.expenses.map((r) => <tr key={r.code} className="border-b border-border"><td className="px-4 py-2 pl-8">{r.name}</td><td className="px-4 py-2 text-right"><Money v={r.amount} /></td></tr>)}
          <tr className="border-b border-border font-medium"><td className="px-4 py-2">Total expenses</td><td className="px-4 py-2 text-right"><Money v={data.total_expenses} bold /></td></tr>
          <tr className="bg-primary/5 text-base font-semibold"><td className="px-4 py-3">Net income</td><td className="px-4 py-3 text-right" data-testid="pnl-net-income"><Money v={data.net_income} bold /></td></tr>
        </tbody>
      </table>
    </Panel>
  );
}

function BalanceSheetView() {
  const [asOf, setAsOf] = useState(businessToday());
  const { data } = useQuery({ queryKey: ["balance-sheet", asOf], queryFn: () => apiGet<BalanceSheet>(`/books/balance-sheet?as_of=${asOf}`) });
  const Section = ({ title, lines, total, testId }: { title: string; lines: { code: string; name: string; balance: number }[]; total: number; testId: string }) => (
    <Panel className="overflow-hidden">
      <div className="border-b border-border bg-muted/40 px-4 py-2 font-medium">{title}</div>
      <table className="w-full text-sm"><tbody>
        {lines.map((l) => <tr key={l.code} className="border-b border-border"><td className="px-4 py-2">{l.name}</td><td className="px-4 py-2 text-right"><Money v={l.balance} /></td></tr>)}
        <tr className="font-medium"><td className="px-4 py-2.5">Total {title.toLowerCase()}</td><td className="px-4 py-2.5 text-right" data-testid={testId}><Money v={total} bold /></td></tr>
      </tbody></table>
    </Panel>
  );
  return (
    <div>
      <div className="mb-4 flex items-end justify-between gap-3">
        <label className="space-y-1"><span className="text-xs text-muted-foreground">As of</span>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-40" data-testid="bs-asof" /></label>
        {data && <div className="flex items-center gap-2"><ReconcileBadge ok={data.balanced} /><Button size="xs" variant="outline" onClick={() => csvDownload(`/books/balance-sheet?as_of=${asOf}&format=csv`, "balance_sheet.csv")} data-testid="export-balance"><Download className="size-3" /> CSV</Button></div>}
      </div>
      {data && (
        <div className="grid gap-4 md:grid-cols-2">
          <Section title="Assets" lines={data.assets} total={data.total_assets} testId="bs-total-assets" />
          <div className="space-y-4">
            <Section title="Liabilities" lines={data.liabilities} total={data.total_liabilities} testId="bs-total-liabilities" />
            <Section title="Equity" lines={data.equity} total={data.total_equity} testId="bs-total-equity" />
          </div>
        </div>
      )}
    </div>
  );
}

function TrialBalanceView() {
  const [asOf, setAsOf] = useState(businessToday());
  const { data } = useQuery({ queryKey: ["trial-balance", asOf], queryFn: () => apiGet<TrialBalance>(`/books/trial-balance?as_of=${asOf}`) });
  return (
    <div>
      <div className="mb-4 flex items-end justify-between gap-3">
        <label className="space-y-1"><span className="text-xs text-muted-foreground">As of</span>
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-40" data-testid="tb-asof" /></label>
        {data && <div className="flex items-center gap-2"><ReconcileBadge ok={data.balanced} /><Button size="xs" variant="outline" onClick={() => csvDownload(`/books/trial-balance?as_of=${asOf}&format=csv`, "trial_balance.csv")} data-testid="export-trial"><Download className="size-3" /> CSV</Button></div>}
      </div>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="trial-balance-table">
          <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Code</th><th className="px-4 py-2 font-medium">Account</th><th className="px-4 py-2 text-right font-medium">Debit</th><th className="px-4 py-2 text-right font-medium">Credit</th></tr></thead>
          <tbody>
            {data?.rows.map((r) => <tr key={r.code} className="border-b border-border"><td className="px-4 py-2 font-mono text-xs">{r.code}</td><td className="px-4 py-2">{r.name}</td><td className="px-4 py-2 text-right">{r.debit ? <Money v={r.debit} /> : ""}</td><td className="px-4 py-2 text-right">{r.credit ? <Money v={r.credit} /> : ""}</td></tr>)}
            {data && <tr className="bg-muted/40 font-semibold"><td className="px-4 py-2.5" colSpan={2}>Total</td><td className="px-4 py-2.5 text-right" data-testid="tb-total-debit"><Money v={data.total_debit} bold /></td><td className="px-4 py-2.5 text-right" data-testid="tb-total-credit"><Money v={data.total_credit} bold /></td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function GeneralLedgerView({ account, start, end }: { account: string; start: string; end: string }) {
  const { data } = useQuery({ queryKey: ["gl", account, start, end], queryFn: () => apiGet<GeneralLedger>(`/books/general-ledger?account=${account}&start=${start}&end=${end}`) });
  if (!data) return null;
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="label-caps">{data.account} · {data.account_name} — opening {fmtMoney(data.opening_balance)}</span>
        <Button size="xs" variant="outline" onClick={() => csvDownload(`/books/general-ledger?account=${account}&start=${start}&end=${end}&format=csv`, `gl_${account}.csv`)} data-testid="export-gl"><Download className="size-3" /> CSV</Button>
      </div>
      <table className="w-full text-sm" data-testid="gl-table">
        <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Date</th><th className="px-4 py-2 font-medium">Memo</th><th className="px-4 py-2 text-right font-medium">Debit</th><th className="px-4 py-2 text-right font-medium">Credit</th><th className="px-4 py-2 text-right font-medium">Balance</th></tr></thead>
        <tbody>
          {data.rows.map((r, i) => <tr key={i} className="border-b border-border"><td className="px-4 py-2 whitespace-nowrap">{r.date}</td><td className="px-4 py-2">{r.memo}</td><td className="px-4 py-2 text-right">{r.debit ? <Money v={r.debit} /> : ""}</td><td className="px-4 py-2 text-right">{r.credit ? <Money v={r.credit} /> : ""}</td><td className="px-4 py-2 text-right"><Money v={r.balance} /></td></tr>)}
          {data.rows.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">No entries in this range</td></tr>}
          <tr className="bg-muted/40 font-semibold"><td className="px-4 py-2.5" colSpan={4}>Closing balance</td><td className="px-4 py-2.5 text-right"><Money v={data.closing_balance} bold /></td></tr>
        </tbody>
      </table>
    </Panel>
  );
}

function AgingView() {
  const { data } = useQuery({ queryKey: ["ar-aging"], queryFn: () => apiGet<ARAging>("/books/ar-aging") });
  if (!data) return null;
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex flex-wrap gap-3">
          {Object.entries(data.buckets).map(([k, v]) => <Stat key={k} label={k} value={fmtMoney(v)} testId={`aging-${k}`} />)}
        </div>
        <div className="flex items-center gap-2"><ReconcileBadge ok={data.reconciled} /><Button size="xs" variant="outline" onClick={() => csvDownload("/books/ar-aging?format=csv", "ar_aging.csv")} data-testid="export-aging"><Download className="size-3" /> CSV</Button></div>
      </div>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="aging-table">
          <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Invoice</th><th className="px-4 py-2 font-medium">Client</th><th className="px-4 py-2 font-medium">Due</th><th className="px-4 py-2 text-right font-medium">Balance</th><th className="px-4 py-2 text-right font-medium">Days</th><th className="px-4 py-2 font-medium">Bucket</th></tr></thead>
          <tbody>
            {data.rows.map((r) => <tr key={r.invoice_id} className="border-b border-border"><td className="px-4 py-2 font-mono text-xs">{r.number}</td><td className="px-4 py-2">{r.client_name}</td><td className="px-4 py-2">{r.due_date ?? "—"}</td><td className="px-4 py-2 text-right"><Money v={r.balance_due} /></td><td className="px-4 py-2 text-right">{r.days_overdue}</td><td className="px-4 py-2"><Pill tone={r.bucket === "current" ? "info" : r.bucket === "90+" ? "danger" : "warning"}>{r.bucket}</Pill></td></tr>)}
            {data.rows.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-muted-foreground">No outstanding invoices</td></tr>}
            <tr className="bg-muted/40 font-semibold"><td className="px-4 py-2.5" colSpan={3}>Total outstanding</td><td className="px-4 py-2.5 text-right" data-testid="aging-total"><Money v={data.total_outstanding} bold /></td><td colSpan={2}></td></tr>
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function InventoryView() {
  const { data } = useQuery({ queryKey: ["inv-valuation"], queryFn: () => apiGet<InventoryValuation>("/books/inventory-valuation") });
  if (!data) return null;
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <Stat label="Inventory value (at cost)" value={fmtMoney(data.total_value)} testId="inv-total" sub={`Inventory account: ${fmtMoney(data.inventory_account_balance)}`} />
        <div className="flex items-center gap-2"><ReconcileBadge ok={data.reconciled} /><Button size="xs" variant="outline" onClick={() => csvDownload("/books/inventory-valuation?format=csv", "inventory_valuation.csv")} data-testid="export-inv"><Download className="size-3" /> CSV</Button></div>
      </div>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="inv-valuation-table">
          <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Product</th><th className="px-4 py-2 text-right font-medium">On hand</th><th className="px-4 py-2 text-right font-medium">Unit cost</th><th className="px-4 py-2 text-right font-medium">Value</th></tr></thead>
          <tbody>
            {data.rows.map((r) => <tr key={r.product_id} className="border-b border-border"><td className="px-4 py-2">{r.name}</td><td className="px-4 py-2 text-right">{r.quantity_on_hand}</td><td className="px-4 py-2 text-right"><Money v={r.unit_cost} /></td><td className="px-4 py-2 text-right"><Money v={r.value} /></td></tr>)}
            {data.rows.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-muted-foreground">No stock on hand</td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function AccountsView() {
  const { data = [] } = useQuery({ queryKey: ["accounts"], queryFn: () => apiGet<Account[]>("/books/accounts") });
  return (
    <Panel className="overflow-hidden">
      <table className="w-full text-sm" data-testid="accounts-table">
        <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-4 py-2 font-medium">Code</th><th className="px-4 py-2 font-medium">Account</th><th className="px-4 py-2 font-medium">Type</th><th className="px-4 py-2 font-medium">Normal</th></tr></thead>
        <tbody>
          {data.map((a) => <tr key={a.code} className="border-b border-border"><td className="px-4 py-2 font-mono text-xs">{a.code}</td><td className="px-4 py-2">{a.name}</td><td className="px-4 py-2 capitalize">{a.type}</td><td className="px-4 py-2 capitalize">{a.normal}</td></tr>)}
        </tbody>
      </table>
    </Panel>
  );
}

function JournalView({ start, end }: { start: string; end: string }) {
  const { data = [] } = useQuery({ queryKey: ["journal", start, end], queryFn: () => apiGet<JournalEntryView[]>(`/books/journal?start=${start}&end=${end}&limit=300`) });
  return (
    <div className="space-y-3" data-testid="journal-list">
      {data.map((e) => (
        <Panel key={e.id} className="p-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{e.date} · <span className="font-mono">{e.ref}</span>{e.reversed_by ? <> · <Pill tone="warning">reversed</Pill></> : ""}</span>
            <span>{e.created_by_name}</span>
          </div>
          <div className="mt-1 font-medium">{e.memo}</div>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {e.lines.map((l, i) => <tr key={i}><td className="py-0.5 font-mono text-xs text-muted-foreground">{l.account}</td><td className="py-0.5">{l.account_name}</td><td className="py-0.5 text-right">{l.debit ? <Money v={l.debit} /> : ""}</td><td className="py-0.5 text-right">{l.credit ? <Money v={l.credit} /> : ""}</td></tr>)}
            </tbody>
          </table>
        </Panel>
      ))}
      {data.length === 0 && <p className="text-sm text-muted-foreground">No journal entries in this range.</p>}
    </div>
  );
}
