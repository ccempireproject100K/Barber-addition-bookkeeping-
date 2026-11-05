import InternationalFields from "@/components/InternationalFields";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CreditCard, LogOut, Mail, Package } from "lucide-react";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { errMsg, fmtDateTime } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { BackupMeta, BillingCheckoutIn, BillingCheckoutOut, BillingStatus, BillingSyncIn, OutboxEmail, WorkspaceSettings } from "@/lib/types";
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

function BackupPanel({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const { data: backups = [] } = useQuery({ queryKey: ["backups"], queryFn: () => apiGet<BackupMeta[]>("/backups"), enabled: admin });
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["backups"] });
  const create = async () => {
    setBusy(true);
    try { const b = await apiPost<BackupMeta>("/backup"); toast.success(`Backup saved — ${b.documents} records`); refresh(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const restore = async (b: BackupMeta) => {
    if (!window.confirm(`Restore the backup from ${fmtDateTime(b.created_at)}? ALL current workspace data will be replaced with the backup. This can't be undone.`)) return;
    if (!window.confirm("Really restore? Type of confirmation #2: click OK to replace all data.")) return;
    try { const r = await apiPost<{ restored_documents: number }>("/backup/" + b.id + "/restore"); toast.success(`Restored ${r.restored_documents} records`); invalidateInventory(); }
    catch (e) { toast.error(errMsg(e)); }
  };
  if (!admin) return null;
  const kb = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  return (
    <Panel className="p-4 md:p-5" data-testid="settings-backup-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Backup & restore</h3>
          <p className="text-xs text-muted-foreground">Snapshots of every record in this workspace — clients, invoices, ledger, inventory and settings. Restoring replaces current data.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void create()} disabled={busy} data-testid="backup-create-button">{busy ? "Backing up…" : "Create backup"}</Button>
      </div>
      {backups.length > 0 && (
        <table className="mt-3 w-full text-sm" data-testid="backups-table">
          <thead><tr className="border-b border-border text-left text-muted-foreground"><th className="px-2 py-2 font-medium">Created</th><th className="px-2 py-2 font-medium">By</th><th className="px-2 py-2 text-right font-medium">Records</th><th className="px-2 py-2 text-right font-medium">Size</th><th className="px-2 py-2"></th></tr></thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.id} className="border-b border-border last:border-0" data-testid={`backup-row-${b.id}`}>
                <td className="px-2 py-2 text-xs">{fmtDateTime(b.created_at)}</td>
                <td className="px-2 py-2">{b.created_by}</td>
                <td className="px-2 py-2 text-right font-mono">{b.documents}</td>
                <td className="px-2 py-2 text-right font-mono">{kb(b.size_bytes)}</td>
                <td className="px-2 py-2 text-right">
                  <span className="flex justify-end gap-1">
                    <a href={`/api/backup/${b.id}/download`} data-testid={`backup-download-${b.id}`}><Button size="xs" variant="outline" tabIndex={-1}>Download</Button></a>
                    <Button size="xs" variant="destructive" onClick={() => void restore(b)} data-testid={`backup-restore-${b.id}`}>Restore</Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function TwoFactorPanel() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const start = async () => {
    try {
      const r = await apiPost<{ secret: string; otpauth_url: string }>("/auth/2fa/setup", {});
      setSecret(r.secret); setOtpauthUrl(r.otpauth_url); setCode("");
    } catch (e) { toast.error(errMsg(e)); }
  };
  const enable = async () => {
    try {
      const r = await apiPost<{ backup_codes: string[] }>("/auth/2fa/enable", { code });
      setBackupCodes(r.backup_codes); setSecret(null);
      toast.success("Two-factor auth enabled");
      void qc.invalidateQueries({ queryKey: ["me"] });
    } catch (e) { toast.error(errMsg(e)); }
  };
  const disable = async (pw: string) => {
    try {
      await apiPost("/auth/2fa/disable", { password: pw });
      setConfirmDisable(false); setPassword("");
      toast.success("Two-factor auth disabled");
      void qc.invalidateQueries({ queryKey: ["me"] });
    } catch (e) { toast.error(errMsg(e)); }
  };
  const regen = async () => {
    try {
      const r = await apiPost<{ backup_codes: string[] }>("/auth/2fa/backup-codes/regenerate", { password });
      setBackupCodes(r.backup_codes); setPassword("");
      toast.success("New backup codes generated — old ones no longer work");
    } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <Panel className="p-4 md:p-5" data-testid="settings-2fa-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Two-factor authentication</h3>
          <p className="text-xs text-muted-foreground">Authenticator-app codes at sign-in, plus one-time backup codes.</p>
        </div>
        {me?.totp_enabled
          ? <Pill tone="success" testId="2fa-status">Enabled</Pill>
          : <Pill tone="neutral" testId="2fa-status">Off</Pill>}
      </div>

      {!me?.totp_enabled && !secret && (
        <Button size="sm" className="mt-3" onClick={() => void start()} data-testid="2fa-start">Set up authenticator app</Button>
      )}
      {!me?.totp_enabled && secret && (
        <div className="mt-3 space-y-2 rounded-lg bg-muted/50 p-3" data-testid="2fa-setup">
          <p className="text-sm">Add this key to your authenticator app (Google Authenticator, 1Password, etc.):</p>
          <code className="block select-all rounded bg-background p-2 font-mono text-sm tracking-widest" data-testid="2fa-secret">{secret}</code>
          <p className="text-xs text-muted-foreground">Then enter the 6-digit code it shows:</p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Code"><Input value={code} onChange={(e) => setCode(e.target.value)} className="w-36 font-mono text-center text-lg tracking-[0.2em]" inputMode="numeric" data-testid="2fa-enable-code" /></Field>
            <Button size="sm" onClick={() => void enable()} disabled={code.trim().length < 6} data-testid="2fa-enable">Enable</Button>
            <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {backupCodes && (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3" data-testid="2fa-backup-codes">
          <p className="text-sm font-medium">Backup codes — save these now, each works once:</p>
          <div className="mt-1 grid grid-cols-2 gap-1 font-mono text-sm">{backupCodes.map((c) => <span key={c}>{c}</span>)}</div>
          <Button size="xs" variant="outline" className="mt-2" onClick={() => setBackupCodes(null)}>I've saved them</Button>
        </div>
      )}
      {me?.totp_enabled && (
        <div className="mt-3 space-y-2">
          {!confirmDisable ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Password (for new backup codes)"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-44" data-testid="2fa-regen-password" /></Field>
              <Button size="sm" variant="outline" onClick={() => void regen()} disabled={!password} data-testid="2fa-regen-codes">New backup codes</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDisable(true)} data-testid="2fa-disable-start">Disable 2FA</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Confirm with password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-44" data-testid="2fa-disable-password" /></Field>
              <Button size="sm" variant="destructive" onClick={() => void disable(password)} data-testid="2fa-disable">Disable</Button>
              <Button size="sm" variant="ghost" onClick={() => { setConfirmDisable(false); setPassword(""); }}>Keep enabled</Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function SessionsPanel() {  const qc = useQueryClient();
  const signOutAll = async () => {
    if (!window.confirm("Sign out on every device? You'll need to sign in again here.")) return;
    try { await apiPost("/auth/logout-all"); }
    catch (e) { toast.error(errMsg(e)); return; }
    qc.clear();
    window.location.assign("/login");
  };
  return (
    <Panel className="p-4 md:p-5" data-testid="settings-sessions-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Sessions</h3>
          <p className="text-xs text-muted-foreground">Left signed in somewhere else? End every session at once.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void signOutAll()} data-testid="signout-all-button"><LogOut className="size-3" /> Sign out all devices</Button>
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
      <TwoFactorPanel />
      <SessionsPanel />
      <BackupPanel admin={admin} />
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}>
        <Panel className="p-4 md:p-5">
          <InternationalFields value={f} disabled={!admin} currencyLocked onChange={(key, value) => setF({ ...f, [key]: value })} />
          <Field label="Shop name"><Input disabled={!admin} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="max-w-sm" data-testid="settings-name-input" /></Field>
        </Panel>
        <Panel className="p-4 md:p-5" data-testid="settings-edition-panel">
          <h3 className="text-base font-semibold">Edition</h3>
          <p className="text-xs text-muted-foreground">Packaging for your kind of business. Same books underneath — the service-shop edition adds a setup checklist and shop-first wording.</p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {(["general", "service-shop"] as const).map((ed) => (
              <button key={ed} type="button" disabled={!admin} onClick={() => setF({ ...f, edition: ed })}
                data-testid={`settings-edition-${ed}`}
                className={`rounded-lg border p-3 text-left ${f.edition === ed ? "border-primary ring-1 ring-primary" : "border-border"} ${admin ? "hover:bg-muted/50" : "opacity-70"}`}>
                <div className="font-medium">{ed === "general" ? "General business" : "Service shop"}</div>
                <div className="text-xs text-muted-foreground">
                  {ed === "general" ? "The standard books: invoices, bills, inventory, reports." : "Barbershops, salons, spas — booth rent, tips, and QuickSell front and center, plus a guided setup checklist."}
                </div>
              </button>
            ))}
          </div>
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
