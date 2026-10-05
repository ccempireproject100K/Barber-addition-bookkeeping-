import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { apiPost } from "@/lib/api";
import { errMsg } from "@/lib/format";
import type { OkOut, PasswordResetConfirmIn, PasswordResetRequestIn } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** /forgot-password (request a link) and /reset-password?token=… (choose a new password). */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => token
      ? apiPost<OkOut>("/auth/password-reset/confirm", { token, password: pw } satisfies PasswordResetConfirmIn)
      : apiPost<OkOut>("/auth/password-reset/request", { email } satisfies PasswordResetRequestIn),
    onSuccess: (r) => { setErr(""); setMsg(r.message); },
    onError: (e) => setErr(errMsg(e)),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (token && pw !== pw2) return setErr("The two passwords don't match");
    setErr(""); m.mutate();
  };
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6">
      <form onSubmit={submit} className="w-full max-w-sm animate-rise" data-testid="reset-form" noValidate={false}>
        <h1 className="text-2xl font-semibold">{token ? "Choose a new password" : "Reset your password"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{token ? "At least 8 characters. Every other device will be signed out." : "We'll email you a link that works for 1 hour."}</p>
        {msg ? (
          <div className="mt-6 rounded-md border border-border bg-muted/40 p-4 text-sm" role="status" data-testid="reset-message">{msg}</div>
        ) : (
          <div className="mt-6 space-y-4">
            {token ? (
              <>
                <div className="space-y-1.5"><Label htmlFor="pw">New password</Label><Input id="pw" type="password" required minLength={8} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} data-testid="reset-password-input" /></div>
                <div className="space-y-1.5"><Label htmlFor="pw2">Repeat password</Label><Input id="pw2" type="password" required minLength={8} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} data-testid="reset-password2-input" /></div>
              </>
            ) : (
              <div className="space-y-1.5"><Label htmlFor="em">Account email</Label><Input id="em" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="reset-email-input" /></div>
            )}
            {err && <p className="text-sm text-destructive" role="alert" data-testid="reset-error">{err}</p>}
            <Button type="submit" className="h-10 w-full" disabled={m.isPending} data-testid="reset-submit-button">{m.isPending ? <Loader2 className="animate-spin" /> : token ? "Update password" : "Send reset link"}</Button>
          </div>
        )}
        <Link to="/login" className="mt-6 inline-block text-sm text-primary hover:underline" data-testid="reset-back-link">Back to sign in</Link>
      </form>
    </div>
  );
}
