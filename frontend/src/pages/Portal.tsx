import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, X, ReceiptText, FileCheck2 } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg, fmtMoney } from "@/lib/format";
import { Field } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface PortalLine { description: string; quantity: number; unit_price: number }
interface PortalInvoice {
  id: string; number: string; client_name: string; date: string; due_date: string | null; status: string;
  lines: PortalLine[]; subtotal: number; discount_amount: number; tax_rate: number; tax_amount: number;
  tip_amount: number; total: number; amount_paid: number; balance_due: number; notes: string;
  reported_payments: { amount: number; method: string; reference: string; confirmed: boolean }[] | null;
}
interface PortalEstimate {
  id: string; number: string; client_name: string; date: string; valid_until: string | null; status: string;
  lines: PortalLine[]; subtotal: number; discount_amount: number; tax_rate: number; tax_amount: number;
  tip_amount: number; total: number; notes: string;
}
interface PortalView {
  kind: "invoice" | "estimate"; business: string;
  invoice?: PortalInvoice; estimate?: PortalEstimate;
}

function Lines({ lines }: { lines: PortalLine[] }) {
  return (
    <table className="w-full text-sm">
      <thead><tr className="border-b border-border text-left text-muted-foreground">
        <th className="py-2 font-medium">Description</th><th className="py-2 text-right font-medium">Qty</th>
        <th className="py-2 text-right font-medium">Price</th><th className="py-2 text-right font-medium">Amount</th>
      </tr></thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} className="border-b border-border/50">
            <td className="py-2">{l.description}</td>
            <td className="py-2 text-right font-mono">{l.quantity}</td>
            <td className="py-2 text-right font-mono">{fmtMoney(l.unit_price)}</td>
            <td className="py-2 text-right font-mono">{fmtMoney(l.quantity * l.unit_price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Totals({ doc }: { doc: PortalInvoice | PortalEstimate }) {
  return (
    <div className="mt-3 space-y-1 text-sm">
      <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-mono">{fmtMoney(doc.subtotal)}</span></div>
      {doc.discount_amount > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Discount</span><span className="font-mono">−{fmtMoney(doc.discount_amount)}</span></div>}
      {doc.tax_amount > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Tax ({doc.tax_rate}%)</span><span className="font-mono">{fmtMoney(doc.tax_amount)}</span></div>}
      {doc.tip_amount > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Tip</span><span className="font-mono">{fmtMoney(doc.tip_amount)}</span></div>}
      <div className="flex justify-between border-t border-border pt-2 text-base font-semibold"><span>Total</span><span className="font-mono">{fmtMoney(doc.total)}</span></div>
    </div>
  );
}

/** Public, passwordless client portal — no login, link expires in 7 days. */
export default function Portal() {
  const { token = "" } = useParams();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["portal", token],
    queryFn: () => apiGet<PortalView>(`/portal/view/${token}`),
    retry: false,
  });
  const [pay, setPay] = useState({ amount: "", method: "bank transfer", reference: "" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const decide = async (decision: "accepted" | "declined") => {
    setBusy(true);
    try {
      await apiPost(`/portal/estimate/${token}/decision`, { decision, note });
      toast.success(decision === "accepted" ? "Estimate accepted — thank you!" : "Estimate declined");
      refetch();
    } catch (e) { toast.error(errMsg(e)); }
    setBusy(false);
  };

  const reportPayment = async () => {
    setBusy(true);
    try {
      const r = await apiPost<{ message: string }>(`/portal/invoice/${token}/report-payment`,
        { amount: Number(pay.amount), method: pay.method, reference: pay.reference });
      toast.success(r.message);
      setPay({ amount: "", method: "bank transfer", reference: "" });
      refetch();
    } catch (e) { toast.error(errMsg(e)); }
    setBusy(false);
  };

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-4 py-10">
      {isLoading && <p className="text-center text-muted-foreground">Loading…</p>}
      {error && (
        <div className="rounded-xl border border-border bg-card p-8 text-center" data-testid="portal-error">
          <p className="font-medium">This link didn't work</p>
          <p className="mt-1 text-sm text-muted-foreground">{errMsg(error)}. Ask the business for a fresh link.</p>
        </div>
      )}
      {data && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm" data-testid="portal-doc">
          <div className="mb-4 flex items-center gap-2 text-muted-foreground">
            {data.kind === "invoice" ? <ReceiptText className="size-4" /> : <FileCheck2 className="size-4" />}
            <span className="text-sm">{data.business} · {data.kind === "invoice" ? "Invoice" : "Estimate"} {(data.invoice ?? data.estimate)?.number}</span>
          </div>

          {data.kind === "invoice" && data.invoice && (
            <>
              <Lines lines={data.invoice.lines} />
              <Totals doc={data.invoice} />
              <div className="mt-3 flex justify-between text-sm">
                <span className="text-muted-foreground">Paid</span><span className="font-mono">{fmtMoney(data.invoice.amount_paid)}</span>
              </div>
              <div className="flex justify-between text-base font-semibold">
                <span>Balance due</span><span className="font-mono">{fmtMoney(data.invoice.balance_due)}</span>
              </div>
              {data.invoice.status !== "paid" && data.invoice.status !== "void" && (
                <div className="mt-4 rounded-lg bg-muted/50 p-4" data-testid="portal-pay">
                  <div className="mb-2 text-sm font-medium">Report a payment</div>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Amount $"><Input type="number" step="0.01" min="0.01" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} className="w-28 font-mono" /></Field>
                    <Field label="Method"><Input value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} className="w-36" /></Field>
                    <Field label="Reference"><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} className="w-40" placeholder="Check #, etc." /></Field>
                    <Button size="sm" disabled={busy || !Number(pay.amount)} onClick={() => void reportPayment()}>I've paid</Button>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">The business confirms reported payments before they're applied.</p>
                </div>
              )}
              {(data.invoice.reported_payments ?? []).length > 0 && (
                <div className="mt-3 text-xs text-muted-foreground">
                  Reported payments: {data.invoice.reported_payments!.map((r) => `${fmtMoney(r.amount)} (${r.method})`).join(", ")}
                </div>
              )}
            </>
          )}

          {data.kind === "estimate" && data.estimate && (
            <>
              <Lines lines={data.estimate.lines} />
              <Totals doc={data.estimate} />
              {data.estimate.notes && <p className="mt-3 text-sm text-muted-foreground">{data.estimate.notes}</p>}
              {data.estimate.status === "sent" && (
                <div className="mt-4 space-y-2" data-testid="portal-decide">
                  <Field label="Note for the business (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything we should know?" /></Field>
                  <div className="flex gap-2">
                    <Button disabled={busy} onClick={() => void decide("accepted")} data-testid="portal-accept"><Check className="mr-1 size-4" /> Accept estimate</Button>
                    <Button disabled={busy} variant="outline" onClick={() => void decide("declined")} data-testid="portal-decline"><X className="mr-1 size-4" /> Decline</Button>
                  </div>
                </div>
              )}
              {data.estimate.status !== "sent" && (
                <p className="mt-4 text-sm text-muted-foreground">This estimate is <strong>{data.estimate.status}</strong>.</p>
              )}
            </>
          )}
        </div>
      )}
      <p className="mt-6 text-center text-xs text-muted-foreground">Secure link — expires 7 days after it was created.</p>
    </div>
  );
}
