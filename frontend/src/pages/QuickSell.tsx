import { useMemo, useState, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CreditCard, ImageOff, Minus, Plus, ScanLine, Search, ShoppingBag, Trash2 } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg, fmtMoney } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { BarcodeLookup, CardCheckoutIn, CardCheckoutOut, CheckoutResult, Client, DiscountCheck, Invoice, Product, ProductDetail } from "@/lib/types";
import { useMe, useTeam } from "@/hooks/useMe";
import { Field, NativeSelect, PageHeader, Panel } from "@/components/Common";
import Scanner from "@/components/Scanner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface CartLine { product: Product; quantity: number; unit_price: number; serial_unit_ids: string[] }

export default function QuickSell() {
  const { data: me } = useMe();
  const { data: team = [] } = useTeam();
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [barber, setBarber] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [scan, setScan] = useState(false);
  const [clientId, setClientId] = useState("");
  const [code, setCode] = useState("");
  const [disc, setDisc] = useState<DiscountCheck | null>(null);
  const { data: clients = [] } = useQuery({ queryKey: ["clients"], queryFn: () => apiGet<Client[]>("/clients") });
  const [serialPick, setSerialPick] = useState<Product | null>(null);
  const { data: products = [] } = useQuery({ queryKey: ["products", "type=retail"], queryFn: () => apiGet<Product[]>("/inventory/products?type=retail") });
  const { data: invoices = [] } = useQuery({ queryKey: ["invoices"], queryFn: () => apiGet<Invoice[]>("/invoices"), select: (xs) => xs.filter((i) => i.status === "draft" || i.status === "sent") });
  const { data: serialDetail } = useQuery({ queryKey: ["product", serialPick?.id], queryFn: () => apiGet<ProductDetail>(`/inventory/products/${serialPick!.id}`), enabled: !!serialPick });

  const shown = useMemo(() => products.filter((p) => !q || `${p.name} ${p.brand} ${p.barcode ?? ""} ${p.sku ?? ""}`.toLowerCase().includes(q.toLowerCase())), [products, q]);
  const subtotal = cart.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const total = disc?.valid ? subtotal * (1 - disc.pct / 100) : subtotal;
  const checkCode = async () => {
    if (!code.trim()) { setDisc(null); return; }
    try { const d = await apiGet<DiscountCheck>(`/discounts/${encodeURIComponent(code.trim())}`); setDisc(d); if (!d.valid) toast.error(d.reason); else toast.success(`${d.pct}% off applied`); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const payload = () => ({
    lines: cart.map((l) => ({ product_id: l.product.id, quantity: l.quantity, unit_price: l.unit_price, serial_unit_ids: l.serial_unit_ids })),
    barber_id: barber || null, client_id: clientId || null, discount_code: disc?.valid ? disc.code : null,
  });
  const card = useMutation({
    mutationFn: () => apiPost<CardCheckoutOut>("/payments/quick-sell", { ...payload(), invoice_id: null, payment_method: "card", origin_url: window.location.origin } satisfies CardCheckoutIn),
    onSuccess: (r) => { window.location.href = r.checkout_url; },
    onError: (e) => toast.error(errMsg(e)),
  });
  const me_id = me?.user_id;

  const add = (p: Product) => {
    if (p.tracking_mode === "serial") return setSerialPick(p);
    setCart((c) => {
      const ex = c.find((l) => l.product.id === p.id);
      if (ex) return c.map((l) => (l === ex ? { ...l, quantity: l.quantity + 1 } : l));
      return [...c, { product: p, quantity: 1, unit_price: p.sell_price, serial_unit_ids: [] }];
    });
  };
  const onCode = async (code: string) => {
    setScan(false);
    try {
      const r = await apiGet<BarcodeLookup>(`/inventory/products/barcode/${encodeURIComponent(code)}`);
      if (!r.found || !r.product) return toast.error(`No product with code ${code}`);
      if (r.product.type !== "retail") return toast.error(`${r.product.name} is a supply`);
      add(r.product);
      toast.success(`Added ${r.product.name}`);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const saleKey = useRef<string>(crypto.randomUUID()); // same key for retries of THIS cart; new key after success
  const checkout = useMutation({
    mutationFn: () => apiPost<CheckoutResult>("/inventory/stock/checkout", { ...payload(), invoice_id: invoiceId || null, payment_method: "cash" }, { idempotencyKey: saleKey.current }),
    onSuccess: (r) => { saleKey.current = crypto.randomUUID(); toast.success(`Sold ${fmtMoney(r.total)}${r.invoice_id ? " — added to invoice" : " — income recorded"}`); setCart([]); setCode(""); setDisc(null); invalidateInventory(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div>
      <PageHeader title="Quick sell" subtitle="Ring up products at the chair. One tap per item, one income record per sale.">
        <Button variant="outline" size="sm" onClick={() => setScan(true)} data-testid="quick-sell-scan-button"><ScanLine /> Scan item</Button>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div>
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product" className="pl-8" data-testid="quick-sell-search-input" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {shown.map((p) => (
              <button key={p.id} onClick={() => add(p)} disabled={p.quantity_on_hand <= 0} data-testid={`quick-sell-tile-${p.id}`}
                className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-[border-color,transform] duration-150 hover:border-primary active:scale-[0.98] disabled:opacity-40">
                <div className="grid aspect-[4/3] place-items-center bg-muted">
                  {p.image ? <img src={p.image} alt="" className="size-full object-cover" /> : <ImageOff className="size-5 text-muted-foreground" />}
                </div>
                <div className="p-2.5">
                  <div className="line-clamp-2 text-sm font-medium leading-tight">{p.name}</div>
                  <div className="mt-1 flex items-center justify-between text-xs">
                    <span className="font-mono font-semibold">{fmtMoney(p.sell_price)}</span>
                    <span className="text-muted-foreground">{p.quantity_on_hand} left</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <Panel className="h-fit p-4 lg:sticky lg:top-20" data-testid="quick-sell-cart">
          <div className="flex items-center gap-2 font-semibold"><ShoppingBag className="size-4" /> Ticket</div>
          <div className="mt-3 divide-y divide-border">
            {cart.map((l, i) => (
              <div key={l.product.id} className="py-2.5" data-testid={`cart-line-${l.product.id}`}>
                <div className="flex justify-between gap-2 text-sm"><span className="truncate">{l.product.name}</span><span className="font-mono tabular-nums">{fmtMoney(l.quantity * l.unit_price)}</span></div>
                <div className="mt-1.5 flex items-center gap-2">
                  {l.product.tracking_mode === "serial" ? (
                    <span className="font-mono text-[11px] text-muted-foreground">{l.serial_unit_ids.length} serial unit(s)</span>
                  ) : (
                    <div className="flex items-center rounded-md border border-border">
                      <Button variant="ghost" size="icon-xs" onClick={() => setCart((c) => c.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x)))} data-testid={`cart-dec-${l.product.id}`}><Minus /></Button>
                      <span className="w-6 text-center font-mono text-sm" data-testid={`cart-qty-${l.product.id}`}>{l.quantity}</span>
                      <Button variant="ghost" size="icon-xs" onClick={() => setCart((c) => c.map((x, j) => (j === i ? { ...x, quantity: x.quantity + 1 } : x)))} data-testid={`cart-inc-${l.product.id}`}><Plus /></Button>
                    </div>
                  )}
                  <Input type="number" step="0.01" value={l.unit_price} onChange={(e) => setCart((c) => c.map((x, j) => (j === i ? { ...x, unit_price: Number(e.target.value) } : x)))} className="h-7 w-20 font-mono text-xs" data-testid={`cart-price-${l.product.id}`} />
                  <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={() => setCart((c) => c.filter((_, j) => j !== i))} data-testid={`cart-remove-${l.product.id}`}><Trash2 /></Button>
                </div>
              </div>
            ))}
            {cart.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Tap products to add them.</p>}
          </div>
          <div className="mt-3 space-y-3 border-t border-border pt-3">
            <Field label="Barber (for commission)">
              <NativeSelect value={barber} onChange={(e) => setBarber(e.target.value)} data-testid="quick-sell-barber-select">
                <option value="">— None —</option>
                {team.map((t) => <option key={t.id} value={t.id}>{`${t.name}${t.id === me_id ? " (me)" : ""}`}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Client (for profile & suggestions)">
              <NativeSelect value={clientId} onChange={(e) => setClientId(e.target.value)} data-testid="quick-sell-client-select">
                <option value="">Walk-in</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Discount code">
              <div className="flex gap-2">
                <Input value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setDisc(null); }} placeholder="FADE10-XXXXX" className="font-mono" data-testid="quick-sell-discount-input" />
                <Button type="button" variant="outline" size="sm" onClick={() => void checkCode()} data-testid="quick-sell-discount-apply">Apply</Button>
              </div>
            </Field>
            <Field label="Money record">
              <NativeSelect value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} data-testid="quick-sell-invoice-select">
                <option value="">New income record</option>
                {invoices.map((i) => <option key={i.id} value={i.id}>{`Add to ${i.number} · ${i.client_name}`}</option>)}
              </NativeSelect>
            </Field>
            <div className="flex items-baseline justify-between"><span className="label-caps">Total</span><span className="font-heading text-2xl font-semibold tabular-nums" data-testid="quick-sell-total">{fmtMoney(total)}</span></div>
            {disc?.valid && <div className="-mt-2 text-right text-xs text-emerald-600" data-testid="quick-sell-discount-note">{disc.pct}% off · was {fmtMoney(subtotal)}</div>}
            <div className="grid grid-cols-2 gap-2">
              <Button size="lg" variant="outline" disabled={!cart.length || checkout.isPending} onClick={() => checkout.mutate()} data-testid="quick-sell-checkout-button">Cash sale</Button>
              <Button size="lg" disabled={!cart.length || card.isPending || !!invoiceId} onClick={() => card.mutate()} data-testid="quick-sell-card-button"><CreditCard /> {card.isPending ? "Opening…" : "Card"}</Button>
            </div>
            <p className="text-[10px] text-muted-foreground">Card opens secure Stripe checkout; stock and income are recorded only after payment succeeds.</p>
          </div>
        </Panel>
      </div>

      <Dialog open={scan} onOpenChange={setScan}>
        <DialogContent className="sm:max-w-md" data-testid="quick-sell-scan-dialog">
          <DialogHeader><DialogTitle>Scan item</DialogTitle></DialogHeader>
          {scan && <Scanner onCode={(c) => void onCode(c)} />}
        </DialogContent>
      </Dialog>
      <Dialog open={!!serialPick} onOpenChange={(o) => !o && setSerialPick(null)}>
        <DialogContent className="sm:max-w-sm" data-testid="quick-sell-serial-dialog">
          <DialogHeader><DialogTitle>Which unit? · {serialPick?.name}</DialogTitle></DialogHeader>
          <div className="space-y-1">
            {(serialDetail?.serials ?? []).filter((s) => s.status === "in_stock").map((s) => {
              const line = cart.find((l) => l.product.id === serialPick?.id);
              const checked = !!line?.serial_unit_ids.includes(s.id);
              return (
                <label key={s.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted">
                  <Checkbox checked={checked} data-testid={`quick-sell-serial-${s.serial_number}`} onCheckedChange={(c) => setCart((cs) => {
                    const p = serialPick!;
                    const cur = cs.find((l) => l.product.id === p.id);
                    const ids = c ? [...(cur?.serial_unit_ids ?? []), s.id] : (cur?.serial_unit_ids ?? []).filter((x) => x !== s.id);
                    const rest = cs.filter((l) => l.product.id !== p.id);
                    return ids.length ? [...rest, { product: p, quantity: ids.length, unit_price: cur?.unit_price ?? p.sell_price, serial_unit_ids: ids }] : rest;
                  })} />
                  <span className="font-mono text-sm">{s.serial_number}</span>
                </label>
              );
            })}
          </div>
          <Button onClick={() => setSerialPick(null)} data-testid="quick-sell-serial-done">Done</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
