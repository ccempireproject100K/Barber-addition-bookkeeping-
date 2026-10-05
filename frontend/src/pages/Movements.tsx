import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { apiGet } from "@/lib/api";
import { fmtDateTime, fmtMoney } from "@/lib/format";
import type { Movement, MovementType } from "@/lib/types";
import { EmptyRow, MovementBadge, NativeSelect, PageHeader, Panel } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const TYPES: MovementType[] = ["restock", "sale", "use", "adjustment", "return"];

export default function Movements() {
  const [type, setType] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const qs = new URLSearchParams({ ...(type && { type }), ...(start && { start }), ...(end && { end }) }).toString();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["movements", "ledger", qs], queryFn: () => apiGet<Movement[]>(`/inventory/movements?${qs}`) });

  return (
    <div>
      <PageHeader title="Stock ledger" subtitle="Append-only. Every unit in or out, who did it, and the money it touched.">
        <a href={`/api/inventory/movements/export.csv?${new URLSearchParams({ ...(start && { start }), ...(end && { end }) })}`} data-testid="movements-export-button">
          <Button variant="outline" size="sm" tabIndex={-1}><Download /> Export CSV</Button>
        </a>
      </PageHeader>
      <Panel>
        <div className="grid grid-cols-3 gap-2 border-b border-border p-3 md:flex">
          <NativeSelect value={type} onChange={(e) => setType(e.target.value)} className="md:w-40" data-testid="movements-type-filter">
            <option value="">All types</option>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </NativeSelect>
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="md:w-40" data-testid="movements-start-input" />
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="md:w-40" data-testid="movements-end-input" />
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="label-caps">When</TableHead><TableHead className="label-caps">Product</TableHead><TableHead className="label-caps">Type</TableHead>
              <TableHead className="label-caps text-right">Qty</TableHead><TableHead className="label-caps hidden text-right md:table-cell">Money</TableHead>
              <TableHead className="label-caps hidden lg:table-cell">Detail</TableHead><TableHead className="label-caps hidden sm:table-cell">By</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={m.id} data-testid={`movement-row-${m.id}`}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(m.created_at)}</TableCell>
                  <TableCell><Link to={`/inventory/products/${m.product_id}`} className="text-sm hover:underline">{m.product_name}</Link></TableCell>
                  <TableCell><MovementBadge type={m.type} /></TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", m.quantity > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>{m.quantity > 0 ? "+" : ""}{m.quantity}</TableCell>
                  <TableCell className="hidden text-right font-mono text-xs tabular-nums md:table-cell">
                    {m.type === "restock" && m.unit_cost != null ? `−${fmtMoney(m.quantity * m.unit_cost)}` : m.type === "sale" && m.unit_price != null ? `+${fmtMoney(-m.quantity * m.unit_price)}` : m.cogs ? `cost ${fmtMoney(m.cogs)}` : "—"}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                    {[m.lot_number && `lot ${m.lot_number}`, m.serial_numbers.join(", "), m.reason.replace(/_/g, " "), m.note, m.barber_name].filter(Boolean).join(" · ")}
                  </TableCell>
                  <TableCell className="hidden text-xs sm:table-cell">{m.performed_by_name}</TableCell>
                </TableRow>
              ))}
              {!isLoading && rows.length === 0 && <EmptyRow cols={7} text="No movements in this range." />}
            </TableBody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}
