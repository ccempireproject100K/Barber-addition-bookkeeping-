import { businessToday } from "@/lib/format";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg, fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import type { CashClose, CashCloseIn, CashClosePreview, CashReviewIn, DrawerMove } from "@/lib/types";
import { can, useMe } from "@/hooks/useMe";
import { EmptyRow, Field, NativeSelect, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const todayStr = () => businessToday();
const r2 = (n: number) => Math.round(n * 100) / 100;
const TONE = { submitted: "warning", approved: "success", flagged: "danger" } as const;

function Line({ label, v, testId, strong, sign = "" }: { label: string; v: number; testId: string; strong?: boolean; sign?: string }) {
  return (
    <div className={cn("flex justify-between py-1 text-sm", strong && "mt-1 border-t border-border pt-2 font-semibold")}>
      <span>{label}</span><span className="font-mono tabular-nums" data-testid={testId}>{sign}{fmtMoney(v)}</span>
    </div>
  );
}

function ReviewBox({ c }: { c: CashClose }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: (approve: boolean) => apiPost<CashClose>(`/cash-closes/${c.id}/review`, { approve, note } satisfies CashReviewIn),
    onSuccess: (r) => { toast.success(r.status === "approved" ? "Approved and locked" : "Flagged for correction"); void qc.invalidateQueries({ queryKey: ["cash-closes"] }); void qc.invalidateQueries({ queryKey: ["cash-preview"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Review note (required to flag)" className="h-8 max-w-xs text-xs" data-testid={`cash-review-note-${c.id}`} />
      <Button size="sm" onClick={() => m.mutate(true)} disabled={m.isPending} data-testid={`cash-approve-${c.id}`}>Approve</Button>
      <Button size="sm" variant="outline" onClick={() => m.mutate(false)} disabled={m.isPending} data-testid={`cash-flag-${c.id}`}>Flag</Button>
    </div>
  );
}

export default function CashClosePage() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const canWrite = can(me, "cashclose:write");
  const [day, setDay] = useState(todayStr());
  const { data: pv } = useQuery({ queryKey: ["cash-preview", day], queryFn: () => apiGet<CashClosePreview>(`/cash-closes/preview?day=${day}`), enabled: canWrite });
  const { data: closes = [], isLoading } = useQuery({ queryKey: ["cash-closes"], queryFn: () => apiGet<CashClose[]>("/cash-closes"), enabled: can(me, "cashclose:read") });
  const [opening, setOpening] = useState(0);
  const [counted, setCounted] = useState<number | "">("");
  const [moves, setMoves] = useState<DrawerMove[]>([]);
  const [why, setWhy] = useState("");
  useEffect(() => {
    if (!pv) return;
    const ex = pv.existing;
    setOpening(ex ? ex.opening_float : pv.suggested_opening_float);
    setCounted(ex ? ex.counted_cash : "");
    setMoves(ex ? ex.drawer_moves : []);
    setWhy(ex ? ex.explanation : "");
  }, [pv]);

  const locked = pv?.existing?.status === "approved";
  // A locked (approved) day shows the snapshot the owner approved, not live numbers that may have changed since.
  const src = locked && pv?.existing ? pv.existing : pv;
  const paidIn = moves.filter((m) => m.kind === "paid_in").reduce((a, m) => a + (m.amount || 0), 0);
  const paidOut = moves.filter((m) => m.kind === "paid_out").reduce((a, m) => a + (m.amount || 0), 0);
  const expected = locked && pv?.existing ? pv.existing.expected_cash : src ? r2(opening + src.cash_sales - src.cash_refunds - src.cash_expenses + paidIn - paidOut) : 0;
  const disc = counted === "" ? 0 : r2(counted - expected);

  const submit = useMutation({
    mutationFn: () => apiPost<CashClose>("/cash-closes", { date: day, opening_float: opening, counted_cash: Number(counted), drawer_moves: moves, explanation: why } satisfies CashCloseIn),
    onSuccess: (r) => { toast.success(r.discrepancy === 0 ? "Drawer balanced — sent to the owner" : `Submitted with ${fmtMoney(r.discrepancy)} discrepancy`); void qc.invalidateQueries({ queryKey: ["cash-closes"] }); void qc.invalidateQueries({ queryKey: ["cash-preview"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Ledger" title="Daily cash close" subtitle="Count the drawer, explain any difference, owner signs off. Expected cash is calculated from today's cash-method entries." />
      {canWrite && pv && (
        <Panel className="p-4 md:p-5" data-testid="cash-close-form">
          <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit.mutate(); }}>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <Field label="Day"><Input type="date" value={day} max={todayStr()} onChange={(e) => setDay(e.target.value)} data-testid="cash-day-input" /></Field>
                <Field label="Opening float ($)" hint="Cash in the drawer at open"><Input type="number" step="0.01" min={0} value={opening} disabled={locked} onChange={(e) => setOpening(Number(e.target.value))} className="font-mono" data-testid="cash-opening-input" /></Field>
                <Field label="Counted cash ($)" hint="What's in the drawer now"><Input required type="number" step="0.01" min={0} value={counted} disabled={locked} onChange={(e) => setCounted(e.target.value === "" ? "" : Number(e.target.value))} className="font-mono" data-testid="cash-counted-input" /></Field>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="label-caps">Paid in / paid out (not in the books)</span>
                  <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => setMoves([...moves, { kind: "paid_out", amount: 0, reason: "" }])} data-testid="cash-add-move"><Plus /> Add</Button>
                </div>
                {moves.length === 0 && <p className="text-xs text-muted-foreground">No drawer movements. Add one for change brought in, petty cash taken out, etc.</p>}
                {moves.map((m, i) => (
                  <div key={i} className="mb-2 grid grid-cols-[110px_100px_1fr_auto] gap-2" data-testid={`cash-move-${i}`}>
                    <NativeSelect value={m.kind} disabled={locked} onChange={(e) => setMoves(moves.map((x, j) => (j === i ? { ...x, kind: e.target.value as DrawerMove["kind"] } : x)))} aria-label="Movement type" data-testid={`cash-move-kind-${i}`}>
                      <option value="paid_out">Paid out</option><option value="paid_in">Paid in</option>
                    </NativeSelect>
                    <Input type="number" step="0.01" min={0.01} required value={m.amount || ""} disabled={locked} aria-label="Amount" onChange={(e) => setMoves(moves.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))} className="font-mono" data-testid={`cash-move-amount-${i}`} />
                    <Input required value={m.reason} placeholder="Reason" disabled={locked} aria-label="Reason" onChange={(e) => setMoves(moves.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} data-testid={`cash-move-reason-${i}`} />
                    <Button type="button" size="icon-sm" variant="ghost" disabled={locked} onClick={() => setMoves(moves.filter((_, j) => j !== i))} aria-label="Remove" data-testid={`cash-move-remove-${i}`}><Trash2 /></Button>
                  </div>
                ))}
              </div>
              <Field label={disc !== 0 ? "Explanation (required — drawer doesn't match)" : "Notes (optional)"}>
                <Textarea value={why} disabled={locked} onChange={(e) => setWhy(e.target.value)} rows={2} placeholder="e.g. gave $5 too much change to a walk-in" data-testid="cash-explanation-input" />
              </Field>
              {locked ? <Pill tone="success" testId="cash-locked">Approved by owner — locked</Pill> :
                <Button type="submit" disabled={submit.isPending || counted === ""} data-testid="cash-submit-button">{pv.existing ? "Resubmit close" : "Submit close"}</Button>}
            </form>
            <div className="rounded-lg border border-border bg-muted/30 p-4" data-testid="cash-summary">
              <div className="label-caps mb-1">Expected drawer · {fmtDate(day)}</div>
              <Line label="Opening float" v={opening} testId="cash-sum-opening" />
              <Line label={locked ? "Cash income (as approved)" : `Cash income (${pv.cash_txn_count} cash entries)`} v={src?.cash_sales ?? 0} testId="cash-sum-sales" sign="+" />
              <Line label="Cash refunds" v={src?.cash_refunds ?? 0} testId="cash-sum-refunds" sign="−" />
              <Line label="Cash expenses paid from drawer" v={src?.cash_expenses ?? 0} testId="cash-sum-expenses" sign="−" />
              <Line label="Paid in" v={paidIn} testId="cash-sum-paid-in" sign="+" />
              <Line label="Paid out" v={paidOut} testId="cash-sum-paid-out" sign="−" />
              <Line label="Expected cash" v={expected} testId="cash-sum-expected" strong />
              {counted !== "" && (
                <div className={cn("mt-2 rounded-md px-3 py-2 text-sm font-semibold", disc === 0 ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-red-500/10 text-red-600")} data-testid="cash-sum-discrepancy">
                  {disc === 0 ? "Balanced" : `${disc > 0 ? "Over" : "Short"} by ${fmtMoney(Math.abs(disc))}`}
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">Only entries recorded with payment method “cash” count. Card sales go through the card processor and are not in the drawer.</p>
            </div>
          </div>
        </Panel>
      )}
      {can(me, "cashclose:read") && (
        <Panel>
          <div className="border-b border-border p-3 text-sm font-semibold">Recent closes</div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead className="label-caps">Day</TableHead><TableHead className="label-caps text-right">Expected</TableHead>
                <TableHead className="label-caps text-right">Counted</TableHead><TableHead className="label-caps text-right">Difference</TableHead><TableHead className="label-caps">Status</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {closes.map((c) => (
                  <TableRow key={c.id} data-testid={`cash-close-row-${c.date}`}>
                    <TableCell className="align-top">
                      <div className="text-sm font-medium">{fmtDate(c.date)}</div>
                      <div className="text-[11px] text-muted-foreground">by {c.submitted_by_name} · {fmtDateTime(c.submitted_at)} · rev {c.revision}</div>
                      {c.explanation && <div className="mt-1 text-xs">“{c.explanation}”</div>}
                      {c.review_note && <div className="mt-1 text-xs text-muted-foreground">Owner: {c.review_note}</div>}
                      {c.status === "submitted" && can(me, "cashclose:review") && <ReviewBox c={c} />}
                    </TableCell>
                    <TableCell className="text-right align-top font-mono tabular-nums">{fmtMoney(c.expected_cash)}</TableCell>
                    <TableCell className="text-right align-top font-mono tabular-nums">{fmtMoney(c.counted_cash)}</TableCell>
                    <TableCell className={cn("text-right align-top font-mono tabular-nums", c.discrepancy !== 0 && "text-red-500")}>{fmtMoney(c.discrepancy)}</TableCell>
                    <TableCell className="align-top"><Pill tone={TONE[c.status]} testId={`cash-status-${c.date}`}>{c.status}</Pill></TableCell>
                  </TableRow>
                ))}
                {!isLoading && closes.length === 0 && <EmptyRow cols={5} text="No cash closes yet. Count the drawer at the end of the day above." />}
              </TableBody>
            </Table>
          </div>
        </Panel>
      )}
    </div>
  );
}
