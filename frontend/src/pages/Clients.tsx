import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Plus, Repeat, Sparkles, TrendingUp, Users } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg, fmtDate, fmtMoney } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { Client, ClientIn, ClientProfile } from "@/lib/types";
import { EmptyRow, Field, PageHeader, Panel, Pill, Stat } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const KIND = { rebuy: { icon: Repeat, label: "Due for a rebuy", tone: "warning" as const }, pairs: { icon: Users, label: "Goes with their usuals", tone: "info" as const }, popular: { icon: TrendingUp, label: "Shop favourite", tone: "neutral" as const } };

function Profile({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ["client", id], queryFn: () => apiGet<ClientProfile>(`/clients/${id}`) });
  if (!data) return null;
  const c = data.client;
  return (
    <div className="space-y-4">
      <Link to="/clients" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="client-back-link"><ArrowLeft className="size-3" /> Clients</Link>
      <PageHeader eyebrow={c.phone || c.email} title={c.name} subtitle={data.favorites.length ? `Usually buys: ${data.favorites.join(", ")}` : "No purchases yet"} />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Spent on retail" testId="client-total-spent" value={fmtMoney(c.total_spent)} />
        <Stat label="Visits with a purchase" testId="client-visits" value={String(c.visits)} />
        <Stat label="Last visit" testId="client-last-visit" value={c.last_visit ? fmtDate(c.last_visit) : "—"} />
      </div>
      <Panel className="relative overflow-hidden p-4" data-testid="client-suggestions">
        <div className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-primary/10 blur-3xl" />
        <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-primary" /> Suggest at the chair</div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {data.suggestions.map((s) => { const k = KIND[s.kind]; return (
            <Link key={s.product_id} to={`/inventory/products/${s.product_id}`} data-testid={`client-suggestion-${s.product_id}`} className="flex items-start gap-3 rounded-lg border border-border p-3 transition-colors duration-150 hover:border-primary animate-rise">
              <k.icon className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{s.name}</span><span className="font-mono text-sm">{fmtMoney(s.sell_price)}</span></div>
                <div className="text-[11px] text-muted-foreground">{s.reason}</div>
                <div className="mt-1 flex gap-1"><Pill tone={k.tone}>{k.label}</Pill>{!s.in_stock && <Pill tone="danger">out of stock</Pill>}</div>
              </div>
            </Link>
          ); })}
          {data.suggestions.length === 0 && <p className="text-sm text-muted-foreground">Sell them something first — suggestions build from purchase history.</p>}
        </div>
      </Panel>
      <Panel>
        <div className="border-b border-border p-3 text-sm font-semibold">Purchase history</div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead className="label-caps">Date</TableHead><TableHead className="label-caps">Product</TableHead><TableHead className="label-caps text-right">Qty</TableHead><TableHead className="label-caps text-right">Price</TableHead><TableHead className="label-caps hidden sm:table-cell">Barber</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.purchases.map((m) => (
                <TableRow key={m.movement_id} data-testid={`client-purchase-${m.movement_id}`}>
                  <TableCell className="text-xs text-muted-foreground">{fmtDate(m.date)}</TableCell>
                  <TableCell className="text-sm">{m.product_name}</TableCell>
                  <TableCell className="text-right font-mono">{m.quantity}</TableCell>
                  <TableCell className="text-right font-mono">{fmtMoney(m.unit_price)}</TableCell>
                  <TableCell className="hidden text-xs sm:table-cell">{m.barber_name ?? "—"}</TableCell>
                </TableRow>
              ))}
              {data.purchases.length === 0 && <EmptyRow cols={5} text="No purchases yet." />}
            </TableBody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}

export default function Clients() {
  const { id } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<ClientIn>({ name: "", phone: "", email: "", notes: "" });
  const { data: rows = [] } = useQuery({ queryKey: ["clients", q], queryFn: () => apiGet<Client[]>(`/clients${q ? `?q=${encodeURIComponent(q)}` : ""}`), enabled: !id });
  const add = useMutation({
    mutationFn: () => apiPost<Client>("/clients", f),
    onSuccess: (c) => { toast.success(`${c.name} added`); setOpen(false); invalidateInventory(); nav(`/clients/${c.id}`); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (id) return <Profile id={id} />;
  return (
    <div>
      <PageHeader title="Clients" subtitle="Who buys what — pick a client at Quick sell and their history and suggestions build up here.">
        <Button size="sm" onClick={() => { setF({ name: "", phone: "", email: "", notes: "" }); setOpen(true); }} data-testid="client-new-button"><Plus /> New client</Button>
      </PageHeader>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients" className="mb-3 md:w-80" data-testid="clients-search-input" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((c) => (
          <Link key={c.id} to={`/clients/${c.id}`} data-testid={`client-card-${c.id}`}>
            <Panel className="p-4 transition-colors duration-150 hover:border-primary">
              <div className="font-medium">{c.name}</div>
              <div className="text-xs text-muted-foreground">{c.phone || c.email || "—"}</div>
              <div className="mt-2 flex gap-4 font-mono text-xs text-muted-foreground"><span>{fmtMoney(c.total_spent)}</span><span>{c.visits} visits</span><span>{c.last_visit ? fmtDate(c.last_visit) : "new"}</span></div>
            </Panel>
          </Link>
        ))}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="client-dialog">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <DialogHeader><DialogTitle>New client</DialogTitle></DialogHeader>
            <Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="client-name-input" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} data-testid="client-phone-input" /></Field>
              <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} data-testid="client-email-input" /></Field>
            </div>
            <DialogFooter><Button type="submit" disabled={add.isPending} data-testid="client-save-button">Save</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
