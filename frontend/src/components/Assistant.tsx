import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, Check, Loader2, Send, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiStream } from "@/lib/api";
import { errMsg } from "@/lib/format";
import type { AiMessage, CopilotAction } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const SUGGESTIONS = ["What sold best this month?", "What should I reorder this week?", "How much commission does each team member get?", "Which lots expire soon?"];

/** "Ask the shop": streaming ChatGPT answers grounded in this workspace's own numbers. */
export default function Assistant() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"chat" | "actions">("chat");
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ q: string; a: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const { data: msgs = [] } = useQuery({ queryKey: ["ai-chat"], queryFn: () => apiGet<AiMessage[]>("/ai/chat"), enabled: open });
  const { data: actions = [], refetch: refetchActions, isFetching: actionsLoading } = useQuery({
    queryKey: ["ai-actions"], queryFn: () => apiGet<CopilotAction[]>("/ai/actions"), enabled: open && tab === "actions",
  });
  const [proposing, setProposing] = useState(false);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs.length, pending?.a]);

  const clear = useMutation({ mutationFn: () => apiDelete("/ai/chat"), onSuccess: () => void qc.invalidateQueries({ queryKey: ["ai-chat"] }) });

  const ask = async (q: string) => {
    if (!q.trim() || pending) return;
    setText("");
    setPending({ q, a: "" });
    try {
      await apiStream("/ai/chat/stream", { message: q }, (e) => {
        if (typeof e.delta === "string") setPending((p) => (p ? { ...p, a: p.a + (e.delta as string) } : p));
        if (typeof e.error === "string") toast.error(e.error);
      });
    } catch (e) {
      toast.error(errMsg(e));
    }
    await qc.invalidateQueries({ queryKey: ["ai-chat"] });
    setPending(null);
  };

  const bubble = (role: string, content: string, key: string, live = false) => (
    <div key={key} className={cn("flex", role === "user" ? "justify-end" : "justify-start")} data-testid={`ai-msg-${role}`}>
      <div className={cn("max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm animate-rise",
        role === "user" ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted")}>
        {content || (live ? <Loader2 className="size-4 animate-spin" /> : "")}
      </div>
    </div>
  );

  const propose = async () => {
    setProposing(true);
    try {
      const r = await apiPost<CopilotAction[]>("/ai/actions/propose", {});
      toast.success(r.length ? `Proposed ${r.length} action${r.length > 1 ? "s" : ""} for your approval` : "Nothing worth doing right now");
      refetchActions();
    } catch (e) { toast.error(errMsg(e)); }
    setProposing(false);
  };

  const decide = async (a: CopilotAction, approve: boolean) => {
    if (approve && !confirm(`Run this action?\n\n${a.title}\n${a.detail}`)) return;
    try {
      await apiPost(`/ai/actions/${a.id}/${approve ? "approve" : "reject"}`, {});
      toast.success(approve ? "Action executed" : "Action dismissed");
      refetchActions();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const actionCard = (a: CopilotAction) => (
    <div key={a.id} className="rounded-xl border border-border p-3" data-testid={`ai-action-${a.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium">{a.title}</div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
          a.status === "proposed" ? "bg-primary/10 text-primary"
          : a.status === "executed" ? "bg-green-500/10 text-green-700 dark:text-green-400"
          : "bg-muted text-muted-foreground")}>{a.status}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{a.detail}</p>
      {a.result && <p className="mt-1 text-xs text-green-700 dark:text-green-400">{a.result}</p>}
      {a.status === "proposed" && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => void decide(a, true)} data-testid={`ai-action-approve-${a.id}`}><Check className="mr-1 size-3" /> Approve & run</Button>
          <Button size="sm" variant="outline" onClick={() => void decide(a, false)} data-testid={`ai-action-reject-${a.id}`}><X className="mr-1 size-3" /> Dismiss</Button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="ai-open-button"><Sparkles /> Ask</Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md" data-testid="ai-assistant-sheet">
          <div className="flex items-center gap-3 border-b border-border p-4 pr-12">
            <div className="grid size-9 place-items-center rounded-full bg-primary/10 text-primary"><Bot className="size-4" /></div>
            <div className="flex-1">
              <SheetTitle>Ask the shop</SheetTitle>
              <SheetDescription className="text-xs">Answers from your live numbers · GPT-5 mini</SheetDescription>
            </div>
            {msgs.length > 0 && tab === "chat" && <Button variant="ghost" size="icon-sm" onClick={() => clear.mutate()} data-testid="ai-clear-button" aria-label="Clear chat"><Trash2 /></Button>}
          </div>
          <div className="flex gap-1 border-b border-border px-4">
            {(["chat", "actions"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} data-testid={`ai-tab-${t}`}
                className={cn("border-b-2 px-3 py-2 text-sm font-medium capitalize transition-colors",
                  tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                {t === "chat" ? "Chat" : "Actions"}
              </button>
            ))}
          </div>
          {tab === "chat" ? (
          <>
          <div className="flex-1 space-y-3 overflow-y-auto p-4" data-testid="ai-messages">
            {msgs.length === 0 && !pending && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Try one of these:</p>
                {SUGGESTIONS.map((s, i) => (
                  <button key={s} onClick={() => void ask(s)} data-testid={`ai-suggestion-${i}`}
                    className="block w-full rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors duration-150 hover:border-primary hover:bg-primary/5">{s}</button>
                ))}
              </div>
            )}
            {msgs.map((m) => bubble(m.role, m.content, m.id))}
            {pending && <>{bubble("user", pending.q, "pq")}{bubble("assistant", pending.a, "pa", true)}</>}
            <div ref={end} />
          </div>
          <form className="flex gap-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about sales, stock, commission…" disabled={!!pending} data-testid="ai-input" />
            <Button type="submit" size="icon" disabled={!text.trim() || !!pending} data-testid="ai-send-button" aria-label="Send"><Send /></Button>
          </form>
          <p className="px-3 pb-2 text-[10px] text-muted-foreground">AI can make mistakes — double-check numbers in Reports before acting.</p>
          </>
          ) : (
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="ai-actions">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">The copilot proposes actions — nothing runs without your approval.</p>
              <Button size="sm" variant="outline" disabled={proposing} onClick={() => void propose()} data-testid="ai-propose-button">
                {proposing ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Wand2 className="mr-1 size-3" />} Suggest actions
              </Button>
            </div>
            {actionsLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
            {!actionsLoading && actions.length === 0 && (
              <p className="text-sm text-muted-foreground">No actions yet. Tap "Suggest actions" and the copilot will look for overdue invoices and unpaid bills worth acting on.</p>
            )}
            {actions.map(actionCard)}
          </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
