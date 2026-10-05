import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Hourglass, ImageOff, Plus, Search, Upload } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg, fmtMoney } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { ImportResult, Product } from "@/lib/types";
import { can, useMe } from "@/hooks/useMe";
import { EmptyRow, NativeSelect, PageHeader, Panel, Pill, StockBadge } from "@/components/Common";
import ProductDialog from "@/components/ProductDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export default function Products() {
  const { data: me } = useMe();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const status = sp.get("status") ?? "";
  const expiring = sp.get("expiring") === "1";
  const [createOpen, setCreateOpen] = useState(false);
  const [importRes, setImportRes] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const params = new URLSearchParams({ ...(q && { q }), ...(type && { type }), ...(status && { status }), ...(expiring && { expiring: "true" }) });
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["products", params.toString()], queryFn: () => apiGet<Product[]>(`/inventory/products?${params}`),
  });
  const imp = useMutation({
    mutationFn: (csv: string) => apiPost<ImportResult>("/inventory/products/import", { csv }),
    onSuccess: (r) => { setImportRes(r); if (r.imported) { toast.success(`Imported ${r.imported} products`); invalidateInventory(); } },
    onError: (e) => toast.error(errMsg(e)),
  });

  const setFilter = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };

  return (
    <div>
      <PageHeader title="Products" subtitle="Retail you sell and supplies you use. Quantities come only from the stock ledger.">
        <a href="/api/inventory/products/export.csv" data-testid="products-export-button"><Button variant="outline" size="sm" tabIndex={-1}><Download /> Export</Button></a>
        {can(me, "product:write") && (
          <>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={imp.isPending} data-testid="products-import-button"><Upload /> Import CSV</Button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" data-testid="products-import-input"
              onChange={async (e) => { const file = e.target.files?.[0]; if (file) imp.mutate(await file.text()); e.target.value = ""; }} />
            <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="products-add-button"><Plus /> New product</Button>
          </>
        )}
      </PageHeader>

      <Panel>
        <div className="flex flex-col gap-2 border-b border-border p-3 md:flex-row md:items-center">
          <div className="relative md:w-80">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, brand, SKU, barcode" className="pl-8" data-testid="products-search-input" />
          </div>
          <div className="grid grid-cols-3 gap-2 md:ml-auto md:flex">
            <NativeSelect value={type} onChange={(e) => setType(e.target.value)} className="md:w-32" data-testid="products-type-filter">
              <option value="">All types</option><option value="retail">Retail</option><option value="supply">Supplies</option>
            </NativeSelect>
            <NativeSelect value={status} onChange={(e) => setFilter("status", e.target.value)} className="md:w-36" data-testid="products-status-filter">
              <option value="">Any stock</option><option value="in_stock">In stock</option><option value="low">Low / out</option><option value="out">Out</option>
            </NativeSelect>
            <Button variant={expiring ? "default" : "outline"} size="sm" onClick={() => setFilter("expiring", expiring ? "" : "1")} data-testid="products-expiring-filter"><Hourglass /> Expiring</Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="label-caps">Product</TableHead>
              <TableHead className="label-caps text-right">On hand</TableHead>
              <TableHead className="label-caps hidden text-right sm:table-cell">Price / cost</TableHead>
              <TableHead className="label-caps hidden text-right lg:table-cell">Value</TableHead>
              <TableHead className="label-caps hidden sm:table-cell">Status</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.id} className="cursor-pointer transition-colors duration-150" onClick={() => nav(`/inventory/products/${p.id}`)} data-testid={`product-row-${p.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-muted">
                        {p.image ? <img src={p.image} alt="" className="size-full object-cover" /> : <ImageOff className="size-4 text-muted-foreground" />}
                      </div>
                      <div className="min-w-0">
                        <Link to={`/inventory/products/${p.id}`} className="block truncate font-medium hover:underline" data-testid={`product-link-${p.id}`}>{p.name}</Link>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{p.brand || p.category}</span>
                          <Pill tone={p.type === "retail" ? "info" : "neutral"}>{p.type}</Pill>
                          {p.tracking_mode !== "none" && <Pill tone="neutral">{p.tracking_mode}</Pill>}
                          {p.expiring_lots > 0 && <Pill tone="danger" dot>{p.expiring_lots} expiring</Pill>}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className={cn("text-right font-mono tabular-nums", p.status !== "in_stock" && "text-amber-600 dark:text-amber-400")} data-testid={`product-qty-${p.id}`}>
                    {p.quantity_on_hand}
                  </TableCell>
                  <TableCell className="hidden text-right font-mono text-xs tabular-nums sm:table-cell">{p.type === "retail" ? fmtMoney(p.sell_price) : "—"} / {fmtMoney(p.unit_cost)}</TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums lg:table-cell">{fmtMoney(p.stock_value)}</TableCell>
                  <TableCell className="hidden sm:table-cell"><StockBadge status={p.status} testId={`product-status-${p.id}`} /></TableCell>
                </TableRow>
              ))}
              {!isLoading && items.length === 0 && <EmptyRow cols={5} text="No products match." />}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <ProductDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={(p) => nav(`/inventory/products/${p.id}`)} />
      <Dialog open={!!importRes && importRes.errors.length > 0} onOpenChange={(o) => !o && setImportRes(null)}>
        <DialogContent data-testid="import-errors-dialog">
          <DialogHeader>
            <DialogTitle>Nothing was imported</DialogTitle>
            <DialogDescription>Fix these rows and upload again — imports are all-or-nothing so you never get half a catalogue.</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-1 overflow-y-auto font-mono text-xs">
            {importRes?.errors.map((e) => <div key={e.row} data-testid={`import-error-row-${e.row}`}>Row {e.row}: {e.error}</div>)}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
