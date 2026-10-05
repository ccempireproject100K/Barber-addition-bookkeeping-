import InternationalFields from "@/components/InternationalFields";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CreditCard, Mail, Package } from "lucide-react";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { errMsg, fmtDateTime } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { BillingCheckoutIn, BillingCheckoutOut, BillingStatus, BillingSyncIn, OutboxEmail, WorkspaceSettings } from "@/lib/types";
import { can, useMe } from "@/hooks/useMe";
import { Field, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

function WeeklyNow() {
  const m = useMutation({
    mutationFn: () => apiPost<OutboxEmail>("/ai/weekly-email"),
    onSuccess: (e) => { toast.success(e.status === "sent" ? `Emailed ${e.to}` : "Saved to the outbox below (SMTP not configured)"); invalidateInventory(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => m.mutate()} disabled={m.isPending} data-testid="weekly-ai-send-button">
      {m.isPending ? "Writing…" : "Send Monday email now"}
    </Button>
  );
}

function Outbox() {
  const { data: rows = [] } = useQuery({ queryKey: ["outbox"], queryFn: () => apiGet<OutboxEmail[]>("/inventory/alerts/outbox") });
  const send = useMutation({
    mutationFn: () => apiPost<OutboxEmail>("/inventory/alerts/digest"),
    onSuccess: (e) => { toast.success(e.status === "sent" ? `Emailed ${e.to}` : e.status === "logged" ? "SMTP not configured — digest saved to the outbox below" : `Send failed: ${e.error}`); invalidateInventory(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Panel className="p-4 md:p-5" data-testid="outbox-panel">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold"><Mail className="size-4" /> Daily alert email</h3>
          <p className="text-xs text-muted-foreground">Sent once a day to the owner when something is low or expiring. Uses your SMTP server (SMTP_HOST etc. in backend/.env); without it, emails are kept here.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => send.mutate()} disabled={send.isPending} data-testid="digest-send-button">Send now</Button>
      </div>
      <div className="mt-3 space-y-2">
        {rows.map((e) => (
          <details key={e.id} className="rounded-md border border-border p-3" data-testid={`outbox-row-${e.id}`}>
            <summary className="flex cursor-pointer items-center gap-2 text-sm">
              <Pill tone={e.status === "sent" ? "success" : e.status === "logged" ? "neutral" : "danger"}>{e.status}</Pill>
              <span className="truncate">{e.subject}</span><span className="ml-auto text-[11px] text-muted-foreground">{fmtDateTime(e.created_at)}</span>
            </summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-muted-foreground">{e.body}</pre>
          </details>
        ))}
        {rows.length === 0 && <p className="text-xs text-muted-foreground">No alert emails yet.</p>}
      </div>
    </Panel>
  );
}

function BillingPanel({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data: b } = useQuery({ queryKey: ["billing"], queryFn: () => apiGet<BillingStatus>("/billing") });
  const start = useMutation({
    mutationFn: () => apiPost<BillingCheckoutOut>("/billing/checkout", { origin_url: window.location.origin } satisfies BillingCheckoutIn),
    onSuccess: (r) => { window.location.href = r.checkout_url; },
    onError: (e) => toast.error(errMsg(e)),
  });
  const synced = useRef(false);
  useEffect(() => {
    const sid = params.get("session_id");
    if (params.get("billing") === "success" && sid && admin && !synced.current) {
      synced.current = true;
      apiPost<BillingStatus>("/billing/sync", { session_id: sid } satisfies BillingSyncIn)
        .then((r) => { toast.success(r.entitlements.inventory ? "Subscription active — add-ons unlocked" : `Subscription status: ${r.status}`); void qc.invalidateQueries(); })
        .catch((e) => toast.error(errMsg(e)))
        .finally(() => setParams({}, { replace: true }));
    }
  }, [params, admin, qc, setParams]);
  if (!b) return null;
  const tone = b.access === "demo" ? "info" : b.entitlements.inventory ? "success" : b.status === "past_due" ? "danger" : "neutral";
  return (
    <Panel className="p-4 md:p-5" data-testid="settings-billing-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold"><CreditCard className="size-4" /> Plan & billing</h3>
          <p className="text-xs text-muted-foreground">Inventory, procurement and the AI assistant are paid add-ons ({fmtMoneyLocal(b.price)}/month). They unlock only after Stripe confirms the subscription — not from this page's switches.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill tone={tone} testId="billing-access">{b.access === "demo" ? "Demo workspace (never billed)" : b.entitlements.inventory ? "Pro add-ons active" : "Free plan"}</Pill>
            {b.access !== "demo" && b.status !== "none" && <Pill tone="neutral" testId="billing-status">Stripe: {b.status.replace("_", " ")}</Pill>}
            {b.test_mode && <Pill tone="warning" testId="billing-test-mode">Stripe test mode — no real charges</Pill>}
            {b.current_period_end && <Pill tone="neutral">Renews {fmtDateTime(b.current_period_end)}</Pill>}
          </div>
          {b.status === "past_due" && <p className="mt-2 text-xs text-red-500" role="alert">The last payment failed — add-ons are paused until Stripe collects it.</p>}
        </div>
        {admin && b.access !== "demo" && !b.entitlements.inventory && (
          <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending} data-testid="billing-subscribe-button">{start.isPending ? "Opening Stripe…" : "Subscribe (test mode)"}</Button>
        )}
      </div>
    </Panel>
  );
}

const fmtMoneyLocal = (v: number) => `${v.toFixed(2)} USD`;

export default function Settings() {
  const { data: me } = useMe();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => apiGet<WorkspaceSettings>("/settings") });
  const [f, setF] = useState<WorkspaceSettings | null>(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  const admin = can(me, "settings:write");
  const qcl = useQueryClient();
  const save = useMutation({
    mutationFn: (s: WorkspaceSettings) => apiPut<WorkspaceSettings>("/settings", s),
    onSuccess: () => { toast.success("Settings saved"); invalidateInventory(); void qcl.invalidateQueries({ queryKey: ["me"] }); }, onError: (e) => toast.error(errMsg(e)),
  });
  const entInv = !!me?.entitlements.inventory;
  const entAi = !!me?.entitlements.ai;
  if (!f) return null;
  const check = (k: "low_stock_email" | "allow_negative_stock", label: string, hint: string) => (
    <label className="flex items-start gap-3">
      <Checkbox checked={f[k]} disabled={!admin} onCheckedChange={(c) => setF({ ...f, [k]: !!c })} data-testid={`settings-${k.replace(/_/g, "-")}`} />
      <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
    </label>
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" subtitle="Workspace and add-on configuration." />
      <BillingPanel admin={admin} />
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}>
        <Panel className="p-4 md:p-5">
          <InternationalFields value={f} disabled={!admin} currencyLocked onChange={(key, value) => setF({ ...f, [key]: value })} />
          <Field label="Shop name"><Input disabled={!admin} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="max-w-sm" data-testid="settings-name-input" /></Field>
        </Panel>
        <Panel className="p-4 md:p-5" data-testid="settings-inventory-panel">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="flex items-center gap-2 text-base font-semibold"><Package className="size-4" /> Inventory & procurement add-on</h3>
              <p className="text-xs text-muted-foreground">When off, every inventory screen, menu and API is hidden. Your existing data is kept and comes back when you turn it on.</p>
            </div>
            <button type="button" role="switch" aria-checked={f.inventory_enabled} aria-label="Inventory add-on" disabled={!admin || (!entInv && !f.inventory_enabled)} title={entInv ? undefined : "Needs an active subscription"} onClick={() => setF({ ...f, inventory_enabled: !f.inventory_enabled })} data-testid="settings-inventory-toggle"
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${f.inventory_enabled ? "bg-primary" : "bg-muted-foreground/30"}`}>
              <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200 ${f.inventory_enabled ? "translate-x-5" : "translate-x-0.5"}`} />
            </button>
          </div>
          {f.inventory_enabled && (
            <div className="mt-4 grid gap-4 border-t border-border pt-4 md:grid-cols-2">
              {check("low_stock_email", "Daily low-stock / expiry email", "One digest per day to the owner.")}
              {check("allow_negative_stock", "Allow selling below zero", "Off by default — sales that would go negative are blocked.")}
              <Field label="Expiry warning (days)"><Input disabled={!admin} type="number" min={1} max={365} value={f.expiry_warning_days} onChange={(e) => setF({ ...f, expiry_warning_days: Number(e.target.value) })} className="w-28 font-mono" data-testid="settings-expiry-days-input" /></Field>
              <div />
              <Field label="PO approval limit ($)" hint="Orders above this need an owner's approval before they're ordered or emailed. 0 = off.">
                <Input disabled={!admin} type="number" min={0} step="10" value={f.po_approval_limit} onChange={(e) => setF({ ...f, po_approval_limit: Number(e.target.value) })} className="w-32 font-mono" data-testid="settings-po-limit-input" />
              </Field>
              <Field label="Expense category · retail restocks"><Input disabled={!admin} value={f.expense_category_retail} onChange={(e) => setF({ ...f, expense_category_retail: e.target.value })} data-testid="settings-retail-category-input" /></Field>
              <Field label="Expense category · supplies"><Input disabled={!admin} value={f.expense_category_supply} onChange={(e) => setF({ ...f, expense_category_supply: e.target.value })} data-testid="settings-supply-category-input" /></Field>
            </div>
          )}
        </Panel>
        <Panel className="p-4 md:p-5" data-testid="settings-ai-panel">
          <label className="flex items-start gap-3">
            <Checkbox checked={f.ai_enabled} disabled={!admin || (!entAi && !f.ai_enabled)} onCheckedChange={(c) => setF({ ...f, ai_enabled: !!c })} data-testid="settings-ai-enabled" />
            <span>
              <span className="block text-sm font-medium">ChatGPT assistant & daily insights (optional)</span>
              <span className="block text-xs text-muted-foreground">Sends a summary of this shop's numbers (no client names or passwords) to OpenAI (GPT-5 mini) to answer owner questions. The only feature that uses an outside service; needs EMERGENT_LLM_KEY in backend/.env.</span>
            </span>
          </label>
          {f.ai_enabled && (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <label className="flex items-start gap-3">
                <Checkbox checked={f.weekly_ai_email} disabled={!admin} onCheckedChange={(c) => setF({ ...f, weekly_ai_email: !!c })} data-testid="settings-weekly-ai-email" />
                <span><span className="block text-sm font-medium">Monday AI email</span><span className="block text-xs text-muted-foreground">Every Monday 7am UTC: the briefing plus this week's AI-drafted orders, saved as drafts for you to approve.</span></span>
              </label>
              {admin && data?.ai_enabled && <WeeklyNow />}
            </div>
          )}
        </Panel>
        {admin && <Button type="submit" disabled={save.isPending} data-testid="settings-save-button">Save settings</Button>}
      </form>
      {admin && (
        <Panel className="p-4 md:p-5" data-testid="settings-source-panel">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Source code</h3>
              <p className="text-xs text-muted-foreground">Download the full app (backend, frontend, Docker setup, README and CHATGPT_HANDOFF.md clone guide). Secrets in .env are never included.</p>
            </div>
            <a href="/api/source/download" data-testid="settings-download-source"><Button type="button" size="sm" variant="outline" tabIndex={-1}>Download source code (.zip)</Button></a>
          </div>
        </Panel>
      )}
      {admin && data?.inventory_enabled && <Outbox />}
    </div>
  );
}
