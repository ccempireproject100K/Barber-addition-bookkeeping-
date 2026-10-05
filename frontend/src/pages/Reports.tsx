import { businessToday } from "@/lib/format";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiGet } from "@/lib/api";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { InventoryReport } from "@/lib/types";
import { PageHeader, Panel, Stat, StockBadge } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const today = () => businessToday();

function Simple<T>({ title, rows, cols, testId }: { title: string; rows: T[]; cols: [string, (r: T) => React.ReactNode, boolean?][]; testId: string }) {
  return (
    <Panel data-testid={testId}>
      <div className="border-b border-border p-3 text-sm font-semibold">{title}</div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>{cols.map(([h, , right]) => <TableHead key={h} className={`label-caps ${right ? "text-right" : ""}`}>{h}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>{cols.map(([h, f, right]) => <TableCell key={h} className={right ? "text-right font-mono tabular-nums" : "text-sm"}>{f(r)}</TableCell>)}</TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={cols.length} className="py-6 text-center text-sm text-muted-foreground">Nothing in this range.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}

export default function Reports() {
  const [start, setStart] = useState(today().slice(0, 8) + "01");
  const [end, setEnd] = useState(today());
  const { data: r } = useQuery({ queryKey: ["inv-report", start, end], queryFn: () => apiGet<InventoryReport>(`/inventory/reports?start=${start}&end=${end}`) });

  return (
    <div className="space-y-4">
      <PageHeader title="Inventory reports" subtitle="Stock value, what sells, what it earns — and who sold it. All numbers come from the ledger.">
        <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-36" data-testid="report-start-input" />
        <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-36" data-testid="report-end-input" />
        <Button variant="outline" size="sm" onClick={() => window.print()} data-testid="report-print-button"><Printer /> Print</Button>
      </PageHeader>
      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
            <Stat label="Stock value (cost)" testId="report-total-value" value={fmtMoney(r.total_value)} sub={`${fmtMoney(r.retail_value)} at retail`} />
            <Stat label="Retail revenue" testId="report-retail-revenue" value={fmtMoney(r.totals.retail_revenue)} />
            <Stat label="Cost of goods sold" testId="report-retail-cogs" value={fmtMoney(r.totals.retail_cogs)} />
            <Stat label="Retail profit" testId="report-retail-profit" value={fmtMoney(r.totals.retail_profit)} />
            <Stat label="Supplies used" testId="report-supply-usage" value={fmtMoney(r.totals.supply_usage_cost)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel className="p-4" data-testid="best-sellers-chart">
              <div className="text-sm font-semibold">Best sellers (units)</div>
              <div className="mt-3 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={r.best_sellers} layout="vertical" margin={{ left: 8, right: 8 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "var(--accent)" }} />
                    <Bar dataKey="units" fill="var(--chart-1)" radius={[0, 4, 4, 0]} barSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Simple testId="report-barbers" title="Profit & commission by barber" rows={r.profit_by_barber} cols={[
              ["Barber", (b) => b.name], ["Units", (b) => b.units, true], ["Revenue", (b) => fmtMoney(b.revenue), true],
              ["Profit", (b) => fmtMoney(b.profit), true], ["Commission", (b) => `${fmtMoney(b.commission)} (${b.commission_rate}%)`, true],
            ]} />
          </div>
          <Simple testId="report-profit-by-product" title="Profit by product" rows={r.profit_by_product} cols={[
            ["Product", (x) => x.name], ["Units", (x) => x.units, true], ["Revenue", (x) => fmtMoney(x.revenue), true],
            ["COGS", (x) => fmtMoney(x.cogs), true], ["Profit", (x) => fmtMoney(x.profit), true], ["Margin", (x) => `${x.margin}%`, true],
          ]} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Simple testId="report-low-stock" title="Low / out of stock" rows={r.low_stock} cols={[
              ["Product", (x) => x.name], ["On hand", (x) => x.quantity_on_hand, true], ["Reorder at", (x) => x.reorder_point, true], ["Status", (x) => <StockBadge status={x.status} />],
            ]} />
            <Simple testId="report-expiring" title="Expiring lots" rows={r.expiring_lots} cols={[
              ["Product", (x) => x.product_name], ["Lot", (x) => x.lot_number], ["Expiry", (x) => fmtDate(x.expiry_date)], ["Qty", (x) => x.quantity_on_hand, true],
            ]} />
          </div>
          <Simple testId="report-supply-usage-table" title="Supply usage" rows={r.supply_usage} cols={[
            ["Supply", (x) => x.name], ["Units used", (x) => x.units, true], ["Cost", (x) => fmtMoney(x.cost), true],
          ]} />
          <Simple testId="report-stock-value" title="Stock on hand" rows={r.stock} cols={[
            ["Product", (x) => x.name], ["Type", (x) => x.type], ["On hand", (x) => x.quantity_on_hand, true], ["Unit cost", (x) => fmtMoney(x.unit_cost), true], ["Value", (x) => fmtMoney(x.value), true],
          ]} />
        </>
      )}
    </div>
  );
}
