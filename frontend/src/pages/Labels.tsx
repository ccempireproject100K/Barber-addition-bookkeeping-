import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import JsBarcode from "jsbarcode";
import { Barcode, Printer } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg, fmtMoney } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { Product } from "@/lib/types";
import { can, useMe } from "@/hooks/useMe";
import { Field, NativeSelect, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Layout = "sheet30" | "thermal";
const LAYOUTS: Record<Layout, { label: string; hint: string }> = {
  sheet30: { label: "Sheet · 30 per page (Avery 5160 / L7160-style)", hint: "Letter or A4 label sheets on any office printer" },
  thermal: { label: "Thermal · 2.25″ × 1.25″, one per label", hint: "Dymo / Zebra / Rollo style label printers" },
};

function BarcodeSvg({ code }: { code: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, code, { format: /^\d{13}$/.test(code) ? "EAN13" : "CODE128", height: 34, width: 1.4, fontSize: 11, margin: 0, displayValue: true });
    } catch {
      JsBarcode(ref.current, code, { format: "CODE128", height: 34, width: 1.4, fontSize: 11, margin: 0 });
    }
  }, [code]);
  return <svg ref={ref} className="h-auto max-w-full" />;
}

export default function Labels() {
  const { data: me } = useMe();
  const [sel, setSel] = useState<string[]>([]);
  const [copies, setCopies] = useState(1);
  const [layout, setLayout] = useState<Layout>("sheet30");
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [showPrice, setShowPrice] = useState(true);
  const { data: products = [] } = useQuery({ queryKey: ["products", "labels"], queryFn: () => apiGet<Product[]>("/inventory/products") });
  const shown = products.filter((p) => !onlyMissing || !p.barcode);
  const chosen = products.filter((p) => sel.includes(p.id));
  const missing = chosen.filter((p) => !p.barcode);

  const assign = useMutation({
    mutationFn: () => apiPost<Product[]>("/inventory/products/assign-barcodes", { product_ids: missing.map((p) => p.id) }),
    onSuccess: (ps) => { toast.success(`Generated ${ps.length} in-store barcode(s)`); invalidateInventory(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const labels = useMemo(() => chosen.filter((p) => p.barcode).flatMap((p) => Array.from({ length: copies }, (_, i) => ({ p, i }))), [chosen, copies]);

  return (
    <div className="space-y-4">
      <div className="print:hidden space-y-4">
        <PageHeader title="Barcode labels" subtitle="Give unlabelled products an in-store barcode, then print shelf or product labels.">
          {missing.length > 0 && can(me, "product:write") && (
            <Button size="sm" variant="outline" onClick={() => assign.mutate()} disabled={assign.isPending} data-testid="labels-assign-button"><Barcode /> Generate {missing.length} barcode(s)</Button>
          )}
          <Button size="sm" disabled={!labels.length} onClick={() => window.print()} data-testid="labels-print-button"><Printer /> Print {labels.length} label(s)</Button>
        </PageHeader>
        <Panel className="grid gap-4 p-4 md:grid-cols-4">
          <Field label="Layout" hint={LAYOUTS[layout].hint} className="md:col-span-2">
            <NativeSelect value={layout} onChange={(e) => setLayout(e.target.value as Layout)} data-testid="labels-layout-select">
              {(Object.keys(LAYOUTS) as Layout[]).map((k) => <option key={k} value={k}>{LAYOUTS[k].label}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Copies each"><Input type="number" min={1} max={30} value={copies} onChange={(e) => setCopies(Math.max(1, Number(e.target.value)))} className="font-mono" data-testid="labels-copies-input" /></Field>
          <div className="space-y-2 pt-5">
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={onlyMissing} onCheckedChange={(c) => setOnlyMissing(!!c)} data-testid="labels-only-missing" /> Only products without a barcode</label>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={showPrice} onCheckedChange={(c) => setShowPrice(!!c)} data-testid="labels-show-price" /> Show price</label>
          </div>
        </Panel>
        <Panel>
          <div className="flex items-center justify-between border-b border-border p-3 text-sm">
            <label className="flex items-center gap-2"><Checkbox checked={shown.length > 0 && shown.every((p) => sel.includes(p.id))} onCheckedChange={(c) => setSel(c ? [...new Set([...sel, ...shown.map((p) => p.id)])] : sel.filter((id) => !shown.some((p) => p.id === id)))} data-testid="labels-select-all" /> Select all ({shown.length})</label>
            <span className="text-xs text-muted-foreground">{sel.length} selected</span>
          </div>
          <div className="grid gap-1 p-2 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => (
              <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-muted" data-testid={`labels-product-${p.id}`}>
                <Checkbox checked={sel.includes(p.id)} onCheckedChange={(c) => setSel((s) => (c ? [...s, p.id] : s.filter((x) => x !== p.id)))} data-testid={`labels-select-${p.id}`} />
                <span className="flex-1 truncate text-sm">{p.name}</span>
                {p.barcode ? <span className="font-mono text-[11px] text-muted-foreground">{p.barcode}</span> : <Pill tone="warning">no barcode</Pill>}
              </label>
            ))}
            {shown.length === 0 && <p className="p-4 text-sm text-muted-foreground">Every product already has a barcode. Untick "Only products without a barcode" to reprint labels.</p>}
          </div>
        </Panel>
        {labels.length > 0 && <div className="label-caps">Print preview</div>}
      </div>

      {/* Printable area: everything else is hidden by @media print in index.css */}
      <div id="label-print-area" data-testid="labels-preview" className={cn(layout === "sheet30" ? "label-sheet" : "label-thermal")}>
        {labels.map(({ p, i }) => (
          <div key={`${p.id}-${i}`} className="label-cell">
            <div className="label-name">{p.name}</div>
            {showPrice && p.type === "retail" && <div className="label-price">{fmtMoney(p.sell_price)}</div>}
            <BarcodeSvg code={p.barcode!} />
          </div>
        ))}
      </div>
    </div>
  );
}
