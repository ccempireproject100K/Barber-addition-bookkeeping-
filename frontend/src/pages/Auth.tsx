import InternationalFields from "@/components/InternationalFields";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Boxes, ArrowRight, Loader2 } from "lucide-react";
import { apiPost } from "@/lib/api";
import { beginSession } from "@/lib/session";
import { errMsg } from "@/lib/format";
import type { Me, SignupIn } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const TICKER = [
  ["EL-USB-C30", "+240", "in"], ["IN-BRG-6204", "−22", "out"], ["PK-BOX-S", "−48", "out"],
  ["AP-TEE-BLK-L", "+120", "in"], ["EL-SSD-1TB", "−1", "out"], ["PK-MAILER", "−55", "out"],
];

export default function Auth({ mode }: { mode: "login" | "signup" }) {
  const nav = useNavigate();
  const [form, setForm] = useState<SignupIn>({ company_name: "", name: "", email: "", password: "", currency: "USD", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", locale: "en-US" });
  const [error, setError] = useState("");
  const set = (k: keyof SignupIn) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const m = useMutation({
    mutationFn: () =>
      mode === "login"
        ? apiPost<Me>("/auth/login", { email: form.email, password: form.password })
        : apiPost<Me>("/auth/signup", form),
    onSuccess: () => { beginSession(); nav("/", { replace: true }); },
    onError: (e) => setError(errMsg(e)),
  });

  const googleSignIn = () => {
    // REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
    const redirectUrl = window.location.origin + "/";
    window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  const submit = (e: React.FormEvent) => { e.preventDefault(); setError(""); m.mutate(); };

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr] bg-background">
      <section className="relative hidden lg:flex flex-col justify-between overflow-hidden border-r border-border bg-[#070B12] p-12 text-slate-100">
        <div className="absolute inset-0 grid-bg opacity-40" />
        <div className="absolute -left-32 top-1/3 size-[520px] rounded-full bg-blue-600/20 blur-[120px]" />
        <div className="relative flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-md bg-blue-600"><Boxes className="size-5" /></div>
          <span className="font-heading text-lg font-semibold">Barber's Ledger</span>
        </div>
        <div className="relative max-w-lg">
          <div className="label-caps !text-slate-400">Books + stock for barbershops</div>
          <h1 className="mt-4 text-5xl font-semibold leading-[1.05]">
            Every unit, <span className="text-blue-400">accounted for.</span>
          </h1>
          <p className="mt-5 text-slate-400 text-base leading-relaxed">
            Products, stock movements, suppliers and purchase orders in one workspace — with built-in forecasting
            that tells you what to reorder before you run out.
          </p>
        </div>
        <div className="relative rounded-lg border border-slate-800 bg-slate-950/60 backdrop-blur p-4 font-mono text-xs">
          <div className="mb-3 flex items-center justify-between text-slate-500">
            <span>movement.stream</span>
            <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />live</span>
          </div>
          {TICKER.map(([sku, d, t], i) => (
            <div key={sku} className="flex justify-between py-1 border-t border-slate-800/70 animate-rise" style={{ animationDelay: `${i * 80}ms` }}>
              <span className="text-slate-300">{sku}</span>
              <span className={t === "in" ? "text-emerald-400" : "text-amber-400"}>{d}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex items-center justify-center p-6 md:p-12">
        <form onSubmit={submit} className="w-full max-w-sm animate-rise" data-testid={`${mode}-form`}>
          <div className="lg:hidden mb-8 flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground"><Boxes className="size-4" /></div>
            <span className="font-heading font-semibold">Barber's Ledger</span>
          </div>
          <h2 className="text-3xl font-semibold">{mode === "login" ? "Sign in" : "Create your workspace"}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {mode === "login" ? "Welcome back. Enter your credentials." : "Your own isolated shop workspace in seconds."}
          </p>

          <div className="mt-8 space-y-4">
            {mode === "signup" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="company">Company name</Label>
                  <Input id="company" required value={form.company_name} onChange={set("company_name")} data-testid="signup-company-input" placeholder="Northwind Supply Co." />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="name">Your name</Label>
                  <Input id="name" required value={form.name} onChange={set("name")} data-testid="signup-name-input" placeholder="Dana Whitfield" />
                </div>
              </>
            )}
            {mode === "signup" && <InternationalFields value={form} onChange={(key, value) => setForm({ ...form, [key]: value })} />}
            <div className="space-y-1.5">
              <Label htmlFor="email">Work email</Label>
              <Input id="email" type="email" required value={form.email} onChange={set("email")} data-testid={`${mode}-email-input`} placeholder="demo@example.invalid" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required minLength={mode === "signup" ? 8 : 1} value={form.password} onChange={set("password")} data-testid={`${mode}-password-input`} placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"} />
            </div>
            {mode === "login" && <Link to="/forgot-password" className="block text-right text-xs text-primary hover:underline" data-testid="login-forgot-link">Forgot password?</Link>}
            {error && <p data-testid={`${mode}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full h-10" disabled={m.isPending} data-testid={`${mode}-submit-button`}>
              {m.isPending ? <Loader2 className="animate-spin" /> : <>{mode === "login" ? "Sign in" : "Create workspace"} <ArrowRight /></>}
            </Button>
          </div>

          <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
          <Button type="button" variant="outline" className="h-10 w-full" onClick={googleSignIn} data-testid={`${mode}-google-button`}>
            <GoogleIcon /> Continue with Google
          </Button>

          <p className="mt-6 text-sm text-muted-foreground">
            {mode === "login" ? "New to Barber's Ledger? " : "Already have a workspace? "}
            <Link to={mode === "login" ? "/signup" : "/login"} className="text-primary hover:underline" data-testid={`${mode}-switch-link`}>
              {mode === "login" ? "Create a workspace" : "Sign in"}
            </Link>
          </p>
          {mode === "login" && import.meta.env.VITE_SHOW_DEMO_LOGIN !== "false" && (
            <div className="mt-8 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground font-mono" data-testid="demo-credentials">
              demo workspace only · demo@example.invalid / Owner123! — never use demo passwords for real data
            </div>
          )}
        </form>
      </section>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1.66 4.1-5.5 4.1-3.31 0-6-2.74-6-6.1s2.69-6.1 6-6.1c1.88 0 3.15.8 3.87 1.49l2.64-2.54C16.84 3.4 14.64 2.4 12 2.4 6.7 2.4 2.4 6.7 2.4 12s4.3 9.6 9.6 9.6c5.54 0 9.21-3.89 9.21-9.38 0-.63-.07-1.11-.15-1.6H12z" />
    </svg>
  );
}
