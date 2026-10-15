import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { businessToday, errMsg, fmtMoney } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import { queryClient } from "@/lib/queryClient";
import type { PayoutRow, Role, TeamMember, TeamMemberCreate } from "@/lib/types";
import { can, useMe, useTeam } from "@/hooks/useMe";
import { EmptyRow, Field, NativeSelect, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const ROLE_LABEL: Record<Role, string> = { admin: "Owner", staff: "Staff member", accountant: "Accountant (read-only)", bookkeeper: "Bookkeeper (can correct)" };
const ROLE_OPTIONS = (Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>);
const blank: TeamMemberCreate = { name: "", email: "", password: "", role: "staff", commission_rate: 10, booth_rent: 0 };

export default function Team() {
  const { data: me } = useMe();
  const { data: team = [] } = useTeam();
  const [f, setF] = useState<TeamMemberCreate>(blank);
  const admin = can(me, "team:write");
  const add = useMutation({
    mutationFn: () => apiPost<TeamMember>("/team", f),
    onSuccess: (m) => { toast.success(`${m.name} added`); setF(blank); invalidateInventory(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const upd = useMutation({
    mutationFn: (m: TeamMember) => apiPatch<TeamMember>(`/team/${m.id}`, { commission_rate: m.commission_rate, role: m.role, booth_rent: m.booth_rent ?? 0 }),
    onSuccess: () => { toast.success("Saved"); invalidateInventory(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/team/${id}`),
    onSuccess: () => { toast.success("Removed"); invalidateInventory(); }, onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Team & commission" subtitle="Staff can sell, restock and use supplies. Only owners adjust stock, change prices or see reports." />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {team.map((m) => (
          <Panel key={m.id} className="p-4" data-testid={`team-card-${m.id}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium">{m.name} {m.id === me?.user_id && <span className="text-xs text-muted-foreground">(you)</span>}</div>
                <div className="text-xs text-muted-foreground">{m.email}</div>
              </div>
              <Pill tone={m.role === "admin" ? "info" : "neutral"}>{ROLE_LABEL[m.role]}</Pill>
            </div>
            {admin ? (
              <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                upd.mutate({ ...m, commission_rate: Number(fd.get("rate")), role: fd.get("role") as Role, booth_rent: Number(fd.get("rent")) || 0 });
              }}>
                <Field label="Retail commission %"><Input name="rate" type="number" step="0.5" min={0} max={100} defaultValue={m.commission_rate} className="w-24 font-mono" data-testid={`team-rate-${m.id}`} /></Field>
                <Field label="Booth rent $/mo"><Input name="rent" type="number" step="1" min={0} defaultValue={m.booth_rent ?? 0} className="w-24 font-mono" data-testid={`team-rent-${m.id}`} /></Field>
                <Field label="Role">
                  <NativeSelect name="role" defaultValue={m.role} className="w-44" data-testid={`team-role-${m.id}`}>{ROLE_OPTIONS}</NativeSelect>
                </Field>
                <Button type="submit" size="sm" variant="outline" data-testid={`team-save-${m.id}`}>Save</Button>
                {m.id !== me?.user_id && <Button type="button" size="icon-sm" variant="ghost" onClick={() => { if (confirm(`Remove ${m.name}?`)) del.mutate(m.id); }} data-testid={`team-remove-${m.id}`}><Trash2 /></Button>}
              </form>
            ) : (
              <div className="mt-3 font-mono text-xs text-muted-foreground">{m.commission_rate}% commission on retail{(m.booth_rent ?? 0) > 0 && ` · ${fmtMoney(m.booth_rent)} booth rent`}</div>
            )}
          </Panel>
        ))}
      </div>
      {admin && (
        <Panel className="p-4">
          <div className="mb-3 text-sm font-semibold">Add a team member</div>
          <form className="grid grid-cols-2 gap-3 md:grid-cols-7 md:items-end" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="team-name-input" /></Field>
            <Field label="Email"><Input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} data-testid="team-email-input" /></Field>
            <Field label="Password"><Input required minLength={8} type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} data-testid="team-password-input" /></Field>
            <Field label="Role"><NativeSelect value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })} data-testid="team-role-input">{ROLE_OPTIONS}</NativeSelect></Field>
            <Field label="Commission %"><Input type="number" min={0} max={100} value={f.commission_rate} onChange={(e) => setF({ ...f, commission_rate: Number(e.target.value) })} data-testid="team-rate-input" /></Field>
            <Field label="Booth rent $/mo"><Input type="number" min={0} value={f.booth_rent} onChange={(e) => setF({ ...f, booth_rent: Number(e.target.value) })} data-testid="team-rent-input" /></Field>
            <Button type="submit" disabled={add.isPending} data-testid="team-add-button"><Plus /> Add</Button>
          </form>
        </Panel>
      )}
      <PayoutsSection />
    </div>
  );
}

function PayoutsSection() {
  const { data: me } = useMe();
  const monthStart = businessToday().slice(0, 8) + "01";
  const [start, setStart] = useState(monthStart);
  const [end, setEnd] = useState(businessToday());
  const { data } = useQuery({
    queryKey: ["team-payouts", start, end],
    queryFn: () => apiGet<{ start: string; end: string; rows: PayoutRow[] }>(`/team/payouts?start=${start}&end=${end}`),
    enabled: can(me, "report:read"),
  });
  if (!can(me, "report:read")) return null;
  const totals = (data?.rows ?? []).reduce((s, r) => ({ sales: s.sales + r.retail_sales, commission: s.commission + r.commission, rent: s.rent + r.booth_rent, net: s.net + r.net_payout }), { sales: 0, commission: 0, rent: 0, net: 0 });
  return (
    <div className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold">Booth rent & payouts</h2>
          <p className="text-xs text-muted-foreground">Retail sales attributed to each member, commission owed, monthly booth rent, and net payout.</p>
        </div>
        <div className="flex items-end gap-2">
          <Field label="From"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-40" data-testid="payouts-start" /></Field>
          <Field label="To"><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-40" data-testid="payouts-end" /></Field>
        </div>
      </div>
      <Panel className="overflow-hidden">
        <table className="w-full text-sm" data-testid="payouts-table">
          <thead><tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">Member</th><th className="px-4 py-2 text-right font-medium">Retail sales</th>
            <th className="px-4 py-2 text-right font-medium">Commission</th><th className="px-4 py-2 text-right font-medium">Booth rent</th>
            <th className="px-4 py-2 text-right font-medium">Net payout</th></tr></thead>
          <tbody>
            {(data?.rows ?? []).map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0" data-testid={`payout-row-${r.id}`}>
                <td className="px-4 py-2"><span className="font-medium">{r.name}</span> <span className="text-xs text-muted-foreground">{r.commission_rate}%</span></td>
                <td className="px-4 py-2 text-right font-mono">{fmtMoney(r.retail_sales)}</td>
                <td className="px-4 py-2 text-right font-mono">{fmtMoney(r.commission)}</td>
                <td className="px-4 py-2 text-right font-mono">{fmtMoney(r.booth_rent)}</td>
                <td className="px-4 py-2 text-right font-mono font-medium">{fmtMoney(r.net_payout)}</td>
              </tr>
            ))}
            {(data?.rows ?? []).length === 0 && <EmptyRow cols={5} text="No team members yet." />}
          </tbody>
          {(data?.rows ?? []).length > 0 && (
            <tfoot><tr className="bg-muted/40 font-semibold">
              <td className="px-4 py-2.5">Total</td>
              <td className="px-4 py-2.5 text-right font-mono">{fmtMoney(totals.sales)}</td>
              <td className="px-4 py-2.5 text-right font-mono">{fmtMoney(totals.commission)}</td>
              <td className="px-4 py-2.5 text-right font-mono">{fmtMoney(totals.rent)}</td>
              <td className="px-4 py-2.5 text-right font-mono">{fmtMoney(totals.net)}</td>
            </tr></tfoot>
          )}
        </table>
      </Panel>
    </div>
  );
}
