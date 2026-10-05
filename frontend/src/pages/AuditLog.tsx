import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { apiGet } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import type { AuditEntry } from "@/lib/types";
import { can, useMe } from "@/hooks/useMe";
import { EmptyRow, NativeSelect, PageHeader, Panel } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const FILTERS = [["", "All activity"], ["txn", "Transactions"], ["invoice", "Invoices"], ["cash_close", "Cash closes"], ["settings", "Settings"],
  ["team", "Team"], ["auth", "Sign-ins & passwords"], ["billing", "Billing"], ["ops", "Recovery"], ["export", "Exports"]] as const;

export default function AuditLog() {
  const { data: me } = useMe();
  const [action, setAction] = useState("");
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["audit", action], queryFn: () => apiGet<AuditEntry[]>(`/audit${action ? `?action=${action}` : ""}`), enabled: can(me, "audit:read") });
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Ledger" title="Audit log & exports" subtitle="Who did what, when. Entries can't be edited or deleted. Exports are for your accountant.">
        {can(me, "export:read") && (
          <div className="flex gap-2">
            <a href="/api/exports/transactions.csv" data-testid="export-transactions-link"><Button size="sm" variant="outline" tabIndex={-1}><Download /> Transactions CSV</Button></a>
            <a href="/api/exports/audit.csv" data-testid="export-audit-link"><Button size="sm" variant="outline" tabIndex={-1}><Download /> Audit CSV</Button></a>
          </div>
        )}
      </PageHeader>
      <Panel>
        <div className="border-b border-border p-3">
          <NativeSelect value={action} onChange={(e) => setAction(e.target.value)} className="w-56" aria-label="Filter activity" data-testid="audit-filter-select">
            {FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="label-caps">When</TableHead><TableHead className="label-caps">Who</TableHead>
              <TableHead className="label-caps">Action</TableHead><TableHead className="label-caps hidden md:table-cell">Details</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id} data-testid={`audit-row-${a.id}`}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(a.created_at)}</TableCell>
                  <TableCell className="text-sm">{a.actor_name}{a.actor_role && <span className="ml-1 text-[11px] text-muted-foreground">({a.actor_role})</span>}</TableCell>
                  <TableCell className="font-mono text-xs">{a.action}</TableCell>
                  <TableCell className="hidden max-w-md truncate font-mono text-[11px] text-muted-foreground md:table-cell">{JSON.stringify(a.details)}</TableCell>
                </TableRow>
              ))}
              {!isLoading && rows.length === 0 && <EmptyRow cols={4} text="No activity recorded for this filter yet." />}
            </TableBody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}
