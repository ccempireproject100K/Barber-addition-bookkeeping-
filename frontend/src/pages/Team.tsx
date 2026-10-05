import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { apiDelete, apiPatch, apiPost } from "@/lib/api";
import { errMsg } from "@/lib/format";
import { invalidateInventory } from "@/lib/invalidate";
import type { Role, TeamMember, TeamMemberCreate } from "@/lib/types";
import { can, useMe, useTeam } from "@/hooks/useMe";
import { Field, NativeSelect, PageHeader, Panel, Pill } from "@/components/Common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const ROLE_LABEL: Record<Role, string> = { admin: "Owner", staff: "Barber", accountant: "Accountant (read-only)", bookkeeper: "Bookkeeper (can correct)" };
const ROLE_OPTIONS = (Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>);
const blank: TeamMemberCreate = { name: "", email: "", password: "", role: "staff", commission_rate: 10 };

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
    mutationFn: (m: TeamMember) => apiPatch<TeamMember>(`/team/${m.id}`, { commission_rate: m.commission_rate, role: m.role }),
    onSuccess: () => { toast.success("Saved"); invalidateInventory(); }, onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiDelete(`/team/${id}`),
    onSuccess: () => { toast.success("Removed"); invalidateInventory(); }, onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Team & commission" subtitle="Barbers can sell, restock and use supplies. Only owners adjust stock, change prices or see reports." />
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
              <form className="mt-3 flex items-end gap-2" onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                upd.mutate({ ...m, commission_rate: Number(fd.get("rate")), role: fd.get("role") as Role });
              }}>
                <Field label="Retail commission %"><Input name="rate" type="number" step="0.5" min={0} max={100} defaultValue={m.commission_rate} className="w-24 font-mono" data-testid={`team-rate-${m.id}`} /></Field>
                <Field label="Role">
                  <NativeSelect name="role" defaultValue={m.role} className="w-44" data-testid={`team-role-${m.id}`}>{ROLE_OPTIONS}</NativeSelect>
                </Field>
                <Button type="submit" size="sm" variant="outline" data-testid={`team-save-${m.id}`}>Save</Button>
                {m.id !== me?.user_id && <Button type="button" size="icon-sm" variant="ghost" onClick={() => { if (confirm(`Remove ${m.name}?`)) del.mutate(m.id); }} data-testid={`team-remove-${m.id}`}><Trash2 /></Button>}
              </form>
            ) : (
              <div className="mt-3 font-mono text-xs text-muted-foreground">{m.commission_rate}% commission on retail</div>
            )}
          </Panel>
        ))}
      </div>
      {admin && (
        <Panel className="p-4">
          <div className="mb-3 text-sm font-semibold">Add a barber</div>
          <form className="grid grid-cols-2 gap-3 md:grid-cols-6 md:items-end" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="team-name-input" /></Field>
            <Field label="Email"><Input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} data-testid="team-email-input" /></Field>
            <Field label="Password"><Input required minLength={8} type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} data-testid="team-password-input" /></Field>
            <Field label="Role"><NativeSelect value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })} data-testid="team-role-input">{ROLE_OPTIONS}</NativeSelect></Field>
            <Field label="Commission %"><Input type="number" min={0} max={100} value={f.commission_rate} onChange={(e) => setF({ ...f, commission_rate: Number(e.target.value) })} data-testid="team-rate-input" /></Field>
            <Button type="submit" disabled={add.isPending} data-testid="team-add-button"><Plus /> Add</Button>
          </form>
        </Panel>
      )}
    </div>
  );
}
