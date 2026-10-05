import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { apiGet } from "@/lib/api";
import { fmtMoney } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { PaymentStatus } from "@/lib/types";
import { Panel } from "@/components/Common";
import { buttonVariants } from "@/components/ui/button";

/** Stripe returns here; poll until paid + sale posted (stock and income), or show the failure. */
export default function PaymentResult() {
  const [sp] = useSearchParams();
  const cancelled = useLocation().pathname.endsWith("/cancel");
  const sid = sp.get("session_id") ?? "";
  const [st, setSt] = useState<PaymentStatus | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const tries = useRef(0);

  useEffect(() => {
    if (cancelled || !sid) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await apiGet<PaymentStatus>(`/payments/status/${sid}`);
        setSt(s);
        if (s.fulfilled || s.error || ["expired", "failed"].includes(s.payment_status)) { invalidateInventory(); return; }
      } catch { /* keep polling */ }
      if (++tries.current > 15) { setTimedOut(true); return; }
      if (!stop) setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { stop = true; };
  }, [sid, cancelled]);

  const ok = st?.fulfilled;
  const bad = cancelled || !!st?.error || ["expired", "failed"].includes(st?.payment_status ?? "") || timedOut;
  return (
    <div className="mx-auto mt-10 max-w-md">
      <Panel className="p-6 text-center" data-testid="payment-result">
        {ok ? <CheckCircle2 className="mx-auto size-10 text-emerald-500" /> : bad ? <XCircle className="mx-auto size-10 text-red-500" /> : <Loader2 className="mx-auto size-10 animate-spin text-primary" />}
        <h1 className="mt-3 text-xl font-semibold" data-testid="payment-result-title">
          {ok ? `Paid ${fmtMoney(st!.total, st!.currency)}` : cancelled ? "Payment cancelled" : st?.error ? "Payment needs attention" : timedOut ? "Still confirming…" : "Confirming payment…"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground" data-testid="payment-result-detail">
          {ok ? "Stock and the income record were posted automatically." : cancelled ? "Nothing was charged and no stock moved." : st?.error ? st.error : timedOut ? "Check Money & P&L in a minute — the sale posts as soon as Stripe confirms." : "Waiting for Stripe…"}
        </p>
        <Link to="/inventory/sell" className={buttonVariants({ className: "mt-5" })} data-testid="payment-back-button">Back to Quick sell</Link>
      </Panel>
    </div>
  );
}
