import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Archive, ImageOff, Minus, PackagePlus, Pencil, RotateCcw, ShoppingBag, SlidersHorizontal } from "lucide-react";
import { apiDelete, apiGet } from "@/lib/api";
import { errMsg, fmtDate, fmtDateTime, fmtMoney } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { Movement, ProductDetail } from "@/lib/types";
import { can, useMe } from "@/hooks/useMe";
import { EmptyRow, LotBadge, MovementBadge, PageHeader, Panel, Pill, SerialBadge, Stat, StockBadge } from "@/components/Common";
import ProductDialog from "@/components/ProductDialog";
import StockActionDialog, { type StockAction } from "@/components/StockActionDialog";
import PriceCompare from "@/components/procurement/PriceCompare";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export default function ProductDetailPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { data: me } = useMe();
  const [action, setAction] = useState<StockAction | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [serialFilter, setSerialFilter] = useState<string | null>(null);
  const { data: d, isError } = useQuery({ queryKey: ["product", id], queryFn: () => apiGet<ProductDetail>(`/inventory/products/${id}`) });
  const mvParams = serialFilter ? `serial_unit_id=${serialFilter}` : `product_id=${id}`;
  const { data: mvs = [] } = useQuery({ queryKey: ["movements", mvParams], queryFn: () => apiGet<Movement[]>(`/inventory/movements?${mvParams}&limit=200`) });
  const archive = useMutation({
    mutationFn: () => apiDelete(`/inventory/products/${id}`),
    onSuccess: () => { toast.success("Archived — history kept"); invalidateInventory(); nav("/inventory"); },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (isError) return <p className="p-8 text-sm text-muted-foreground" data-testid="product-not-found">Product not found. <Link to="/inventory" className="text-primary">Back to products</Link></p>;
  if (!d) return null;
  const p = d.product;
  const actions: { a: StockAction; label: string; icon: React.ComponentType; show: boolean }[] = [
    { a: "restock", label: "Restock", icon: PackagePlus, show: can(me, "stock:write") },
    { a: "sell", label: "Sell", icon: ShoppingBag, show: p.type === "retail" && can(me, "stock:write") },
    { a: "use", label: "Use", icon: Minus, show: can(me, "stock:write") },
    { a: "return", label: "Return", icon: RotateCcw, show: p.type === "retail" && can(me, "stock:write") },
    { a: "adjust", label: "Adjust", icon: SlidersHorizontal, show: can(me, "stock:adjust") },
  ];

  return (
    <div className="space-y-4">
      <Link to="/inventory" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="product-back-link"><ArrowLeft className="size-3" /> Products</Link>
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-border bg-muted">
          {p.image ? <img src={p.image} alt={p.name} className="size-full object-cover" /> : <ImageOff className="size-6 text-muted-foreground" />}
        </div>
        <div className="flex-1">
          <PageHeader eyebrow={[p.brand, p.category].filter(Boolean).join(" · ")} title={p.name}>
            {can(me, "product:write") && <Button variant="outline" size="sm" onClick={() => setEditOpen(true)} data-testid="product-edit-button"><Pencil /> Edit</Button>}
            {can(me, "product:delete") && (
              <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Archive ${p.name}? Its history stays.`)) archive.mutate(); }} data-testid="product-archive-button"><Archive /> Archive</Button>
            )}
          </PageHeader>
          <div className="-mt-3 flex flex-wrap gap-1.5">
            <StockBadge status={p.status} testId="product-detail-status" />
            <Pill tone={p.type === "retail" ? "info" : "neutral"}>{p.type}</Pill>
            <Pill tone="neutral">{p.tracking_mode === "none" ? "quantity" : `${p.tracking_mode}-tracked`}</Pill>
            {p.sku && <Pill tone="neutral"><span className="font-mono">SKU {p.sku}</span></Pill>}
            {p.barcode && <Pill tone="neutral"><span className="font-mono" data-testid="product-detail-barcode">{p.barcode}</span></Pill>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-2 sm:flex sm:flex-wrap" data-testid="product-actions">
        {actions.filter((x) => x.show).map((x) => (
          <Button key={x.a} variant={x.a === "sell" || x.a === "restock" ? "default" : "outline"} onClick={() => setAction(x.a)}
            className="h-auto flex-col gap-1 py-2 sm:h-9 sm:flex-row sm:py-0" data-testid={`product-action-${x.a}`}>
            <x.icon /> <span className="text-[11px] sm:text-sm">{x.label}</span>
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="On hand" testId="product-detail-qty" value={`${p.quantity_on_hand} ${p.unit}`} sub={`Reorder at ${p.reorder_point}`} />
        <Stat label="Avg unit cost" testId="product-detail-cost" value={fmtMoney(p.unit_cost)} />
        <Stat label={p.type === "retail" ? "Sell price" : "Type"} testId="product-detail-price" value={p.type === "retail" ? fmtMoney(p.sell_price) : "Supply"}
          sub={p.type === "retail" && p.sell_price ? `${Math.round(((p.sell_price - p.unit_cost) / p.sell_price) * 100)}% margin` : undefined} />
        <Stat label="Stock value" testId="product-detail-value" value={fmtMoney(p.stock_value)} sub={p.supplier_name ?? undefined} />
      </div>

      {p.tracking_mode === "lot" && (
        <Panel data-testid="lots-panel">
          <div className="border-b border-border p-3 text-sm font-semibold">Lots · first-expired goes out first</div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead className="label-caps">Lot</TableHead><TableHead className="label-caps">Expiry</TableHead>
                <TableHead className="label-caps text-right">Qty</TableHead><TableHead className="label-caps hidden sm:table-cell">Received</TableHead><TableHead className="label-caps">Status</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {d.lots.map((l) => (
                  <TableRow key={l.id} data-testid={`lot-row-${l.lot_number}`} className={cn(l.id === d.suggested_lot_id && "bg-primary/5")}>
                    <TableCell className="font-mono text-sm">{l.lot_number} {l.id === d.suggested_lot_id && <Pill tone="info">next out</Pill>}</TableCell>
                    <TableCell className="text-sm">{fmtDate(l.expiry_date)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{l.quantity_on_hand}</TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{fmtDate(l.received_date)}</TableCell>
                    <TableCell><LotBadge status={l.status} testId={`lot-status-${l.lot_number}`} /></TableCell>
                  </TableRow>
                ))}
                {d.lots.length === 0 && <EmptyRow cols={5} text="No lots yet — restock to create one." />}
              </TableBody>
            </Table>
          </div>
        </Panel>
      )}

      {p.tracking_mode === "serial" && (
        <Panel data-testid="serials-panel">
          <div className="flex items-center justify-between border-b border-border p-3 text-sm font-semibold">
            Serial units {serialFilter && <Button variant="ghost" size="xs" onClick={() => setSerialFilter(null)} data-testid="serial-filter-clear">Show all history</Button>}
          </div>
          <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
            {d.serials.map((s) => (
              <button key={s.id} onClick={() => setSerialFilter(s.id)} data-testid={`serial-card-${s.serial_number}`}
                className={cn("rounded-md border p-3 text-left transition-colors duration-150 hover:border-primary", serialFilter === s.id ? "border-primary bg-primary/5" : "border-border")}>
                <div className="flex items-center justify-between"><span className="font-mono text-sm">{s.serial_number}</span><SerialBadge status={s.status} testId={`serial-status-${s.serial_number}`} /></div>
                <div className="mt-1 text-[11px] text-muted-foreground">In {fmtDate(s.received_date)}{s.sold_date ? ` · sold ${fmtDate(s.sold_date)}` : ""}{s.warranty_until ? ` · warranty ${fmtDate(s.warranty_until)}` : ""}</div>
              </button>
            ))}
            {d.serials.length === 0 && <p className="text-sm text-muted-foreground">No units yet.</p>}
          </div>
        </Panel>
      )}

      <PriceCompare productId={p.id} />

      <Panel data-testid="product-history-panel">
        <div className="border-b border-border p-3 text-sm font-semibold">History {serialFilter && <span className="font-normal text-muted-foreground">· one serial</span>}</div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="label-caps">When</TableHead><TableHead className="label-caps">Type</TableHead>
              <TableHead className="label-caps text-right">Qty</TableHead><TableHead className="label-caps hidden md:table-cell">Detail</TableHead>
              <TableHead className="label-caps hidden sm:table-cell">By</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {mvs.map((m) => (
                <TableRow key={m.id} data-testid={`history-row-${m.id}`}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(m.created_at)}</TableCell>
                  <TableCell><MovementBadge type={m.type} /></TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", m.quantity > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>{m.quantity > 0 ? "+" : ""}{m.quantity}</TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {[m.lot_number && `lot ${m.lot_number}`, m.serial_numbers.length ? m.serial_numbers.join(", ") : "", m.unit_price != null && m.type === "sale" ? `@ ${fmtMoney(m.unit_price)}` : "",
                      m.reason && m.reason.replace(/_/g, " "), m.note, m.barber_name && `barber ${m.barber_name}`, m.linked_transaction_id && "linked $", m.linked_invoice_id && "on invoice"]
                      .filter(Boolean).join(" · ")}
                  </TableCell>
                  <TableCell className="hidden text-xs sm:table-cell">{m.performed_by_name}</TableCell>
                </TableRow>
              ))}
              {mvs.length === 0 && <EmptyRow cols={5} text="No movements yet." />}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <StockActionDialog open={!!action} onOpenChange={(o) => !o && setAction(null)} detail={d} action={action ?? "restock"} />
      <ProductDialog open={editOpen} onOpenChange={setEditOpen} product={p} />
    </div>
  );
}
