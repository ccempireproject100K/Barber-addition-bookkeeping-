import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiPost } from "@/lib/api";
import { errMsg } from "@/lib/format";
import { beginSession } from "@/lib/session";
import type { GoogleSessionIn, Me } from "@/lib/types";

/** Lands here from Emergent Google auth with #session_id=…; exchanges it once on the backend, then opens the app. */
export default function AuthCallback() {
  const location = useLocation();
  const nav = useNavigate();
  const done = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const sid = new URLSearchParams(location.hash.slice(1)).get("session_id") ?? "";
    apiPost<Me>("/auth/google", { session_id: sid } satisfies GoogleSessionIn)
      .then(() => { beginSession(); nav("/", { replace: true }); })
      .catch((e) => { setError(errMsg(e)); toast.error(errMsg(e)); nav("/login", { replace: true }); });
  }, [location.hash, nav]);

  return (
    <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground" data-testid="auth-callback">
      {error ? <span data-testid="auth-callback-error">{error}</span> : <Loader2 className="size-5 animate-spin" />}
    </div>
  );
}
