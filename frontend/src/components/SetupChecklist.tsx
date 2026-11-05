import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, Scissors } from "lucide-react";
import { apiGet } from "@/lib/api";
import { Panel } from "@/components/Common";

interface SetupStep { id: string; label: string; hint: string; done: boolean; link: string }
interface SetupStatus { edition: string; steps: SetupStep[]; complete: boolean }

/** Service-shop edition onboarding checklist. Renders nothing for other editions or when complete. */
export default function SetupChecklist() {
  const { data } = useQuery({ queryKey: ["edition-setup"], queryFn: () => apiGet<SetupStatus>("/edition/setup-status") });
  if (!data || data.edition !== "service-shop" || data.complete) return null;
  const done = data.steps.filter((s) => s.done).length;
  return (
    <Panel className="p-4" data-testid="setup-checklist">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 font-medium"><Scissors className="size-4" /> Get your shop set up</div>
        <span className="text-xs text-muted-foreground">{done}/{data.steps.length} done</span>
      </div>
      <div className="grid gap-1.5 md:grid-cols-2">
        {data.steps.map((s) => (
          <Link key={s.id} to={s.link} className="flex items-start gap-2 rounded-lg border border-border p-2.5 hover:bg-muted/50">
            {s.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            <span>
              <span className={`text-sm font-medium ${s.done ? "line-through text-muted-foreground" : ""}`}>{s.label}</span>
              <span className="block text-xs text-muted-foreground">{s.hint}</span>
            </span>
          </Link>
        ))}
      </div>
    </Panel>
  );
}
