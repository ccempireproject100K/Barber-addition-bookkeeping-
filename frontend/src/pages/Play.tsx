import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Crown, Scissors, Trophy, Zap } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg } from "@/lib/format";
import type { GameInfo, ScoreIn, ScoreOut } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Fade Rush: 30-second tap game for the waiting room / client's phone.
 * 9 chairs; stray hair tufts pop up — tap to clip (+10, combo multiplier). Golden tufts +50.
 * Don't nick an ear (red) — -30 and combo reset. Gets faster as time runs down.
 */
type Kind = "tuft" | "gold" | "ear";
interface Cell { kind: Kind; until: number; id: number }
const ROUND = 30_000;

export default function Play() {
  const { tenantId = "" } = useParams();
  const { data: info, refetch } = useQuery({ queryKey: ["game", tenantId], queryFn: () => apiGet<GameInfo>(`/game/${tenantId}`) });
  const [phase, setPhase] = useState<"idle" | "play" | "done">("idle");
  const [cells, setCells] = useState<(Cell | null)[]>(Array(9).fill(null));
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(1);
  const [left, setLeft] = useState(ROUND);
  const [fx, setFx] = useState<{ i: number; t: string; id: number } | null>(null);
  const [name, setName] = useState(() => localStorage.getItem("fade-rush-name") ?? "");
  const [result, setResult] = useState<ScoreOut | null>(null);
  const [err, setErr] = useState("");
  const start = useRef(0);
  const seq = useRef(0);
  const scoreRef = useRef(0);

  useEffect(() => { document.title = "Fade Rush"; }, []);

  const begin = () => {
    setScore(0); scoreRef.current = 0; setCombo(1); setResult(null); setErr(""); setCells(Array(9).fill(null));
    start.current = Date.now(); setLeft(ROUND); setPhase("play");
  };

  useEffect(() => {
    if (phase !== "play") return;
    const t = setInterval(() => {
      const now = Date.now();
      const elapsed = now - start.current;
      setLeft(Math.max(0, ROUND - elapsed));
      if (elapsed >= ROUND) { setPhase("done"); return; }
      const speed = 1 - elapsed / ROUND; // 1 -> 0
      setCells((cs) => {
        const next = cs.map((c) => (c && c.until > now ? c : null));
        if (Math.random() < 0.45 + (1 - speed) * 0.35) {
          const free = next.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
          if (free.length) {
            const r = Math.random();
            const kind: Kind = r < 0.08 ? "gold" : r < 0.27 ? "ear" : "tuft";
            next[free[Math.floor(Math.random() * free.length)]] = { kind, id: ++seq.current, until: now + (kind === "gold" ? 650 : 600 + speed * 700) };
          }
        }
        return next;
      });
    }, 120);
    return () => clearInterval(t);
  }, [phase]);

  const hit = (i: number) => {
    if (phase !== "play") return;
    const c = cells[i];
    if (!c) { setCombo(1); return; }
    let pts = 0;
    if (c.kind === "ear") { pts = -30; setCombo(1); }
    else { pts = (c.kind === "gold" ? 50 : 10) * combo; setCombo((x) => Math.min(x + 1, 8)); }
    scoreRef.current = Math.max(0, scoreRef.current + pts);
    setScore(scoreRef.current);
    setFx({ i, t: pts > 0 ? `+${pts}` : `${pts}`, id: c.id });
    navigator.vibrate?.(pts > 0 ? 15 : 80);
    setCells((cs) => cs.map((x, j) => (j === i ? null : x)));
  };

  const submit = useCallback(async () => {
    if (!name.trim()) { setErr("Enter a name for the leaderboard"); return; }
    localStorage.setItem("fade-rush-name", name.trim());
    try {
      const r = await apiPost<ScoreOut>(`/game/${tenantId}/score`, { name: name.trim(), score: scoreRef.current, duration_ms: Math.min(40_000, Date.now() - start.current) } satisfies ScoreIn);
      setResult(r); void refetch();
    } catch (e) { setErr(errMsg(e)); }
  }, [name, tenantId, refetch]);

  return (
    <div className="min-h-screen bg-[#0b1020] text-white" data-testid="game-page">
      <div className="mx-auto max-w-md px-4 py-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-white/50">{info?.shop ?? "…"}</div>
            <h1 className="font-heading text-3xl font-bold tracking-tight">Fade <span className="text-amber-400">Rush</span></h1>
          </div>
          <Scissors className="size-8 text-amber-400" />
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-center font-mono">
          <div className="rounded-lg bg-white/5 p-2"><div className="text-[10px] text-white/50">SCORE</div><div className="text-xl font-bold" data-testid="game-score">{score}</div></div>
          <div className="rounded-lg bg-white/5 p-2"><div className="text-[10px] text-white/50">COMBO</div><div className="flex items-center justify-center gap-1 text-xl font-bold text-amber-400" data-testid="game-combo"><Zap className="size-4" />x{combo}</div></div>
          <div className="rounded-lg bg-white/5 p-2"><div className="text-[10px] text-white/50">TIME</div><div className={cn("text-xl font-bold", left < 5000 && "text-red-400")} data-testid="game-time">{Math.ceil(left / 1000)}</div></div>
        </div>

        <div className="relative mt-4 grid select-none grid-cols-3 gap-3" data-testid="game-board">
          {cells.map((c, i) => (
            <button key={i} onPointerDown={() => hit(i)} data-testid={`game-cell-${i}`} data-kind={c?.kind ?? "empty"}
              className="relative aspect-square touch-manipulation rounded-2xl bg-gradient-to-b from-white/10 to-white/5 ring-1 ring-white/10 transition-transform duration-75 active:scale-95">
              <div className="absolute inset-[18%] rounded-full bg-[#c58c63] shadow-inner" />
              <div className="absolute inset-x-[22%] top-[14%] h-[22%] rounded-t-full bg-[#1d140f]" />
              {c && (
                <div key={c.id} className="absolute inset-0 grid place-items-center animate-rise">
                  {c.kind === "ear" ? <div className="size-10 rounded-full border-4 border-red-500 bg-[#e0a37c]" /> :
                    <div className={cn("text-4xl", c.kind === "gold" ? "drop-shadow-[0_0_10px_rgba(251,191,36,0.9)]" : "")}>{c.kind === "gold" ? "✨" : "〰️"}</div>}
                </div>
              )}
              {fx?.i === i && <div key={fx.id} className={cn("pointer-events-none absolute inset-x-0 top-1 text-center font-mono text-lg font-bold animate-rise", fx.t.startsWith("-") ? "text-red-400" : "text-emerald-300")}>{fx.t}</div>}
            </button>
          ))}
          {phase !== "play" && (
            <div className="absolute inset-0 grid place-items-center rounded-2xl bg-[#0b1020]/85 p-4 backdrop-blur-sm">
              {phase === "idle" ? (
                <div className="text-center">
                  <p className="text-sm text-white/70">Tap stray hair to clip it. Gold = bonus. <span className="text-red-400">Don't nick the ears!</span></p>
                  <p className="mt-2 text-xs text-amber-300" data-testid="game-reward-rule">Score {info?.target ?? 600}+ → {info?.reward_pct ?? 10}% off retail · #1 this week → {info?.top_reward_pct ?? 20}%</p>
                  <button onClick={begin} data-testid="game-start-button" className="mt-4 rounded-full bg-amber-400 px-8 py-3 font-bold text-black transition-transform duration-150 hover:scale-105">Start 30s round</button>
                </div>
              ) : (
                <div className="w-full text-center" data-testid="game-over">
                  <div className="text-xs uppercase tracking-widest text-white/50">Final score</div>
                  <div className="font-heading text-5xl font-bold text-amber-400">{score}</div>
                  {!result ? (
                    <div className="mt-3 flex gap-2">
                      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="Your name" data-testid="game-name-input"
                        className="h-10 flex-1 rounded-lg bg-white/10 px-3 text-sm outline-none ring-1 ring-white/20 focus:ring-amber-400" />
                      <button onClick={() => void submit()} data-testid="game-submit-button" className="rounded-lg bg-amber-400 px-4 text-sm font-bold text-black">Save</button>
                    </div>
                  ) : (
                    <div className="mt-3 space-y-2" data-testid="game-result">
                      <div className="text-sm">Rank #{result.rank} this week {result.best && <Crown className="inline size-4 text-amber-400" />}</div>
                      {result.code && <div className="rounded-lg border-2 border-dashed border-amber-400 p-3 font-mono text-2xl font-bold tracking-widest text-amber-300" data-testid="game-reward-code">{result.code}</div>}
                      <div className="text-xs text-white/60">{result.message}</div>
                    </div>
                  )}
                  {err && <div className="mt-2 text-xs text-red-400" data-testid="game-error">{err}</div>}
                  <button onClick={begin} data-testid="game-again-button" className="mt-4 text-sm text-amber-300 underline">Play again</button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 rounded-xl bg-white/5 p-4" data-testid="game-leaderboard">
          <div className="flex items-center gap-2 text-sm font-semibold"><Trophy className="size-4 text-amber-400" /> This week · {info?.week}</div>
          <ol className="mt-2 space-y-1 font-mono text-sm">
            {(info?.leaderboard ?? []).map((r, i) => (
              <li key={r.name} className="flex justify-between"><span>{i === 0 ? "👑 " : `${i + 1}. `}{r.name}</span><span className="text-amber-300">{r.score}</span></li>
            ))}
            {!info?.leaderboard.length && <li className="text-white/50">No scores yet — be the first.</li>}
          </ol>
        </div>
      </div>
    </div>
  );
}
