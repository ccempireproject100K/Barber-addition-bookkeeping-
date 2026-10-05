import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ClipboardCheck, Mic, MicOff, Minus, Plus, RotateCcw, ScanLine } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { CountResult, Product } from "@/lib/types";
import { NativeSelect, PageHeader, Panel, Pill, Stat } from "@/components/Common";
import Scanner from "@/components/Scanner";
import { useWedge } from "@/components/layout/AppLayout";
import { getRec, type Recognizer } from "@/components/MusicPlayer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const KEY = "stock-count-session";

const UNITS: Record<string, number> = { zero: 0, none: 0, one: 1, a: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, dozen: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "pomade twelve" / "beard oil 7" / "shampoo twenty three" -> { words, n } — the number is the last spoken quantity. */
export function parseSpoken(text: string): { words: string[]; n: number } | null {
  const toks = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    let n: number | null = /^\d+$/.test(t) ? Number(t) : t in UNITS && t !== "a" && t !== "to" && t !== "for" ? UNITS[t] : t in TENS ? TENS[t] : null;
    let start = i;
    if (n !== null && i > 0 && toks[i - 1] in TENS && n < 10) { n += TENS[toks[i - 1]]; start = i - 1; }
    if (n !== null) return { words: toks.slice(0, start).filter((w) => w.length > 2 && !["count", "set", "the", "and", "units", "of"].includes(w)), n };
  }
  return null;
}

function matchProduct(words: string[], products: Product[]): Product | null {
  let best: Product | null = null, bestScore = 0, tie = false;
  for (const p of products) {
    const name = p.name.toLowerCase().split(/[^a-z0-9]+/);
    const score = words.reduce((s, w) => s + (name.some((x) => x.startsWith(w) || w.startsWith(x) && x.length > 2) ? 1 : 0), 0);
    if (score > bestScore) { best = p; bestScore = score; tie = false; } else if (score && score === bestScore) tie = true;
  }
  return bestScore && !tie ? best : null;
}
type Counts = Record<string, number>;

/** Guided shelf count: scan or tap each unit, review differences, post them all as audited adjustments. */
export default function StockCount() {
  const [counts, setCounts] = useState<Counts>(() => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Counts; } catch { return {}; } });
  const [scope, setScope] = useState("all");
  const [scan, setScan] = useState(false);
  const [review, setReview] = useState(false);
  const [result, setResult] = useState<CountResult | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const { data: products = [] } = useQuery({ queryKey: ["products", "count"], queryFn: () => apiGet<Product[]>("/inventory/products") });

  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(counts)); }, [counts]);

  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter(Boolean))].sort(), [products]);
  const list = products.filter((p) => scope === "all" || (scope.startsWith("type:") ? p.type === scope.slice(5) : p.category === scope));
  const counted = list.filter((p) => counts[p.id] !== undefined);
  const diffs = counted.filter((p) => counts[p.id] !== p.quantity_on_hand);
  const bump = (id: string, d: number) => setCounts((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + d) }));

  const onCode = (code: string) => {
    const p = products.find((x) => x.barcode === code || x.sku === code);
    if (!p) { toast.error(`Unknown code ${code}`); return; }
    bump(p.id, 1);
    setLast(p.id);
    navigator.vibrate?.(40);
    toast.success(`${p.name}: ${(counts[p.id] ?? 0) + 1}`, { duration: 900 });
  };

  useWedge(!scan, onCode);

  // Voice entry: "pomade twelve" sets that product's count, hands-free.
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const rec = useRef<Recognizer | null>(null);
  const keep = useRef(false);
  const listRef = useRef(list);
  listRef.current = list;
  const onSpeech = (t: string) => {
    setHeard(t);
    const parsed = parseSpoken(t);
    const p = parsed && parsed.words.length ? matchProduct(parsed.words, listRef.current) : null;
    if (!parsed || !p) { toast.error(`Didn't catch a product + number in "${t}"`); return; }
    setCounts((c) => ({ ...c, [p.id]: parsed.n }));
    setLast(p.id);
    toast.success(`${p.name}: ${parsed.n}`, { duration: 1200 });
  };
  const toggleVoice = () => {
    const Ctor = getRec();
    if (!Ctor) { toast.error("Voice entry needs Chrome, Edge or Safari"); return; }
    if (listening) { keep.current = false; rec.current?.stop(); setListening(false); return; }
    const r = new Ctor();
    r.continuous = true; r.interimResults = false; r.lang = navigator.language || "en-US";
    r.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) onSpeech(e.results[i][0].transcript); };
    r.onerror = (e) => { if (e.error === "not-allowed") { keep.current = false; setListening(false); toast.error("Microphone permission denied"); } };
    r.onend = () => { if (keep.current) { try { r.start(); } catch { /* restarting */ } } };
    rec.current = r; keep.current = true; r.start(); setListening(true);
    toast.info('Say the product then the number, e.g. "matte clay twelve"');
  };
  useEffect(() => () => { keep.current = false; rec.current?.stop(); }, []);

  const save = useMutation({
    mutationFn: () => apiPost<CountResult>("/inventory/stock/count", { lines: counted.map((p) => ({ product_id: p.id, counted: counts[p.id] })), note: "Shelf count" }),
    onSuccess: (r) => {
      setResult(r); setReview(false); invalidateInventory();
      setCounts((c) => { const n = { ...c }; counted.forEach((p) => { if (!r.skipped.some((s) => s.product_id === p.id)) delete n[p.id]; }); return n; });
      toast.success(`${r.adjusted.length} adjustment(s) posted`);
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Stock count" subtitle="Scan every unit on the shelf (or tap +). Your progress is saved on this device until you post it.">
        <Button size="sm" onClick={() => setScan(true)} data-testid="count-scan-button"><ScanLine /> Scan</Button>
        <Button size="sm" variant={listening ? "default" : "outline"} onClick={toggleVoice} data-testid="count-voice-button">{listening ? <><Mic className="animate-pulse-dot" /> Listening…</> : <><MicOff /> Voice</>}</Button>
        <Button variant="outline" size="sm" onClick={() => { if (confirm("Clear this count?")) setCounts({}); }} data-testid="count-reset-button"><RotateCcw /> Reset</Button>
        <Button size="sm" variant="default" disabled={!counted.length} onClick={() => setReview(true)} data-testid="count-review-button"><ClipboardCheck /> Review ({diffs.length})</Button>
      </PageHeader>

      {heard && <p className="-mt-2 text-xs text-muted-foreground" data-testid="count-heard">Heard: "{heard}"</p>}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Counted" testId="count-progress" value={`${counted.length}/${list.length}`} />
        <Stat label="Differences" testId="count-diff-count" value={String(diffs.length)} tone={diffs.length ? "text-amber-500" : undefined} />
        <Stat label="Units counted" testId="count-units" value={String(counted.reduce((s, p) => s + counts[p.id], 0))} />
      </div>

      <Panel>
        <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center">
          <NativeSelect value={scope} onChange={(e) => setScope(e.target.value)} className="sm:w-56" data-testid="count-scope-select">
            <option value="all">Whole shop</option><option value="type:retail">Retail shelf</option><option value="type:supply">Supplies / backbar</option>
            {categories.map((c) => <option key={c} value={c}>{`Category: ${c}`}</option>)}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">Hardware scanners work while this page is open. Blind count: the ledger number shows once you've counted an item.</p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="label-caps">Product</TableHead><TableHead className="label-caps text-center">Counted</TableHead>
              <TableHead className="label-caps hidden text-right sm:table-cell">Ledger</TableHead><TableHead className="label-caps text-right">Diff</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {list.map((p) => {
                const c = counts[p.id];
                const d = c === undefined ? null : c - p.quantity_on_hand;
                return (
                  <TableRow key={p.id} data-testid={`count-row-${p.id}`} className={cn("transition-colors duration-300", last === p.id && "bg-primary/10")}>
                    <TableCell>
                      <div className="text-sm font-medium">{p.name}</div>
                      <div className="flex gap-1 text-[11px] text-muted-foreground">{p.barcode ?? "no barcode"} {p.tracking_mode === "serial" && <Pill tone="warning">serial — count on product page</Pill>}</div>
                    </TableCell>
                    <TableCell>
                      <div className="mx-auto flex w-fit items-center rounded-md border border-border">
                        <Button variant="ghost" size="icon-sm" onClick={() => bump(p.id, -1)} data-testid={`count-dec-${p.id}`}><Minus /></Button>
                        <Input value={c ?? ""} placeholder="–" inputMode="numeric" onChange={(e) => {
                          const v = e.target.value.replace(/\D/g, "");
                          setCounts((s) => { const n = { ...s }; if (v === "") delete n[p.id]; else n[p.id] = Number(v); return n; });
                        }} className="h-8 w-10 border-0 text-center font-mono shadow-none" data-testid={`count-input-${p.id}`} />
                        <Button variant="ghost" size="icon-sm" onClick={() => bump(p.id, 1)} data-testid={`count-inc-${p.id}`}><Plus /></Button>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-right font-mono tabular-nums text-muted-foreground sm:table-cell">{c === undefined ? "•" : p.quantity_on_hand}</TableCell>
                    <TableCell className={cn("text-right font-mono font-semibold tabular-nums", d && d > 0 && "text-emerald-600 dark:text-emerald-400", d && d < 0 && "text-red-500")} data-testid={`count-diff-${p.id}`}>
                      {d === null ? "" : d > 0 ? `+${d}` : d}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </Panel>

      {result && (
        <Panel className="p-4" data-testid="count-result-panel">
          <div className="text-sm font-semibold">Last count posted: {result.adjusted.length} adjusted · {result.unchanged} matched</div>
          {result.skipped.map((s) => <div key={s.product_id} className="mt-1 text-xs text-amber-600">{s.name}: {s.reason}</div>)}
        </Panel>
      )}

      <Dialog open={scan} onOpenChange={setScan}>
        <DialogContent className="sm:max-w-md" data-testid="count-scan-dialog">
          <DialogHeader><DialogTitle>Count by scanning</DialogTitle><DialogDescription>Each scan adds one unit. Keep scanning; close when done.</DialogDescription></DialogHeader>
          {scan && <ContinuousScanner onCode={onCode} />}
        </DialogContent>
      </Dialog>

      <Dialog open={review} onOpenChange={setReview}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md" data-testid="count-review-dialog">
          <DialogHeader>
            <DialogTitle>Post {diffs.length} adjustment(s)?</DialogTitle>
            <DialogDescription>Each difference is saved as a "count correction" adjustment with your name and the time. Matching items need nothing.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1 text-sm">
            {diffs.map((p) => { const d = counts[p.id] - p.quantity_on_hand; return (
              <div key={p.id} className="flex justify-between"><span className="truncate">{p.name}</span><span className={cn("font-mono", d > 0 ? "text-emerald-600" : "text-red-500")}>{d > 0 ? `+${d}` : d}</span></div>
            ); })}
            {diffs.length === 0 && <p className="text-muted-foreground">Everything you counted matches the ledger.</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(false)} data-testid="count-review-cancel">Keep counting</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="count-post-button">Post count</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Scanner that keeps running: remounts after each read with a short cooldown to avoid double-counting one scan. */
function ContinuousScanner({ onCode }: { onCode: (c: string) => void }) {
  const [k, setK] = useState(0);
  return <Scanner key={k} onCode={(c) => { onCode(c); setTimeout(() => setK((x) => x + 1), 700); }} />;
}
