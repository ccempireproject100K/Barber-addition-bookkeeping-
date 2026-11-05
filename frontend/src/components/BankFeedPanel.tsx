import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Landmark, RefreshCw, Unplug, Building2 } from "lucide-react";
import { apiGet, apiPost, apiDelete } from "@/lib/api";
import { errMsg } from "@/lib/format";
import { Panel } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { toast as toastFn } from "sonner";

interface BankConnection {
  id: string;
  institution: string;
  accounts: { account_id: string; name: string; mask: string; type: string; subtype: string }[];
  last_sync: string;
  created_at: string;
}
interface FeedStatus { configured: boolean; env: string; connections: BankConnection[] }

declare global { interface Window { Plaid?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any

const loadPlaid = () => new Promise<void>((res, rej) => {
  if (window.Plaid) return res();
  const s = document.createElement("script");
  s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
  s.onload = () => res();
  s.onerror = () => rej(new Error("plaid"));
  document.head.appendChild(s);
});

/** Live bank feeds (Plaid): connect once, transactions flow into the same staging table as CSV imports. */
export default function BankFeedPanel({ onChanged }: { onChanged: () => void }) {
  const { data, refetch, isLoading } = useQuery({ queryKey: ["bankfeed-status"], queryFn: () => apiGet<FeedStatus>("/bankfeed/status") });
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    try {
      const { link_token } = await apiPost<{ link_token: string }>("/bankfeed/link-token", {});
      await loadPlaid();
      const handler = window.Plaid.create({
        token: link_token,
        onSuccess: async (public_token: string) => {
          try {
            await apiPost("/bankfeed/exchange", { public_token });
            toastFn.success("Bank connected — syncing now");
            await apiPost("/bankfeed/sync", {});
            refetch(); onChanged();
          } catch (e) { toastFn.error(errMsg(e)); }
        },
        onExit: () => { /* user closed Link */ },
      });
      handler.open();
    } catch (e) { toastFn.error(errMsg(e)); }
    setBusy(false);
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const r = await apiPost<{ added: number; matched: number; duplicates: number }>("/bankfeed/sync", {});
      toastFn.success(`Synced: ${r.added} new, ${r.matched} auto-matched`);
      refetch(); onChanged();
    } catch (e) { toastFn.error(errMsg(e)); }
    setBusy(false);
  };

  const disconnect = async (id: string) => {
    if (!confirm("Disconnect this bank? Already-imported transactions stay in your books.")) return;
    try { await apiDelete(`/bankfeed/connection/${id}`); toastFn.success("Disconnected"); refetch(); }
    catch (e) { toastFn.error(errMsg(e)); }
  };

  if (isLoading || !data) return null;

  if (!data.configured) {
    return (
      <Panel className="p-4" data-testid="bankfeed-setup">
        <div className="label-caps mb-2">Live bank feeds</div>
        <p className="text-sm text-muted-foreground">
          Connect a bank once and transactions import automatically — no more CSV uploads.
          To enable, set <code className="font-mono text-xs">PLAID_CLIENT_ID</code>,{" "}
          <code className="font-mono text-xs">PLAID_SECRET</code> and{" "}
          <code className="font-mono text-xs">TOKEN_ENCRYPTION_KEY</code> on the server
          (see <code className="font-mono text-xs">PLAID_SETUP.md</code>), then come back here.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="p-4" data-testid="bankfeed-panel">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="label-caps">Live bank feeds <span className="text-muted-foreground">({data.env})</span></div>
        <div className="flex gap-2">
          {data.connections.length > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={syncNow} data-testid="bankfeed-sync">
              <RefreshCw className="mr-1 size-3" /> Sync now
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={connect} data-testid="bankfeed-connect">
            <Landmark className="mr-1 size-3" /> Connect bank
          </Button>
        </div>
      </div>
      {data.connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No banks connected yet. Connect one and new transactions will appear in the table below for review.</p>
      ) : (
        <ul className="space-y-2">
          {data.connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <Building2 className="size-4 text-muted-foreground" />
                <div>
                  <div className="font-medium">{c.accounts.map((a) => `${a.name} ••${a.mask}`).join(", ") || "Bank account"}</div>
                  <div className="text-xs text-muted-foreground">Last sync: {c.last_sync ? new Date(c.last_sync).toLocaleString() : "never"}</div>
                </div>
              </div>
              <Button size="xs" variant="ghost" onClick={() => disconnect(c.id)} data-testid={`bankfeed-disconnect-${c.id}`}>
                <Unplug className="mr-1 size-3" /> Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
