import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FolderOpen, Mic, MicOff, Music2, Pause, Play, Radio, SkipBack, SkipForward, Volume1, Volume2, X, Youtube, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Track { title: string; src: string; live?: boolean; id?: string }
interface YTVideo { id: string; title: string }

type Source = "radio" | "youtube" | "files";

// Free, listener-supported public streams (no keys, no accounts).
// Professional-casual lineup: mellow background music suited to office work.
const STATIONS: Track[] = [
  { title: "SomaFM · Groove Salad (chill)", src: "https://ice1.somafm.com/groovesalad-128-mp3", live: true },
  { title: "SomaFM · Lush (mellow vocals)", src: "https://ice1.somafm.com/lush-128-mp3", live: true },
  { title: "SomaFM · Sonic Universe (nu-jazz)", src: "https://ice1.somafm.com/sonicuniverse-128-mp3", live: true },
  { title: "SomaFM · Deep Space One (ambient)", src: "https://ice1.somafm.com/deepspaceone-128-mp3", live: true },
  { title: "Radio Paradise · Main mix", src: "https://stream.radioparadise.com/mp3-128", live: true },
];

// ---------- tiny localStorage helpers ----------
function loadJSON<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; }
  catch { return fallback; }
}
function saveJSON(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ }
}

// ---------- IndexedDB: uploaded audio persists on the device ----------
function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open("musicplayer", 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("tracks", { keyPath: "id" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}
async function idbAll(): Promise<{ id: string; name: string; blob: Blob }[]> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction("tracks", "readonly").objectStore("tracks").getAll();
    req.onsuccess = () => resolve((req.result ?? []) as { id: string; name: string; blob: Blob }[]);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(rec: { id: string; name: string; blob: Blob }): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    tx.objectStore("tracks").put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDel(id: string): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    tx.objectStore("tracks").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- YouTube helpers (no API key needed) ----------
function ytIdFromUrl(url: string): string | null {
  const m = url.trim().match(/(?:youtube\.com\/(?:watch\?[^#]*v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
async function ytTitleFor(url: string, id: string): Promise<string> {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (r.ok) { const j = await r.json(); if (j.title) return String(j.title); }
  } catch { /* fall through */ }
  return `YouTube video ${id}`;
}

// Minimal Web Speech API typing (not in TS's DOM lib).
export interface SpeechRes { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>; resultIndex: number }
export interface Recognizer { continuous: boolean; interimResults: boolean; lang: string; start(): void; stop(): void; onresult: ((e: SpeechRes) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null }
type RecCtor = new () => Recognizer;
export const getRec = (): RecCtor | undefined => (window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: RecCtor }).webkitSpeechRecognition;

/** Floating music player: free internet radio, YouTube, or your own files — with hands-free voice commands. */
export default function MusicPlayer() {
  const audio = useRef<HTMLAudioElement>(new Audio());
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source>("radio");
  const [idx, setIdx] = useState(0); // radio index
  const [playing, setPlaying] = useState(false);
  const [vol, setVol] = useState(0.6);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const rec = useRef<Recognizer | null>(null);
  const wantListen = useRef(false);

  // uploads (persisted on-device via IndexedDB when available)
  const [upList, setUpList] = useState<Track[]>([]);
  const [upIdx, setUpIdx] = useState(0);
  const [idbOk, setIdbOk] = useState(true);
  const upRef = useRef<Track[]>([]);
  upRef.current = upList;

  // youtube (playlist persisted in localStorage)
  const [ytList, setYtList] = useState<YTVideo[]>(() => loadJSON<YTVideo[]>("mp.youtube", []));
  const [ytIdx, setYtIdx] = useState(0);
  const [ytUrl, setYtUrl] = useState("");
  const [ytAdding, setYtAdding] = useState(false);
  const ytWrapRef = useRef<HTMLDivElement>(null);
  const ytPlayer = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [ytApiReady, setYtApiReady] = useState(false);
  const wantPlay = useRef(false);

  const track = source === "radio" ? STATIONS[idx] : source === "files" ? upList[upIdx] : undefined;
  const nowTitle = source === "youtube"
    ? (ytList[ytIdx]?.title ?? "Paste a YouTube link below")
    : (track?.title ?? (source === "files" ? "Add audio files from this device" : "—"));
  const nowSub = source === "youtube"
    ? `YouTube${playing ? " · playing" : ""}`
    : `${track?.live ? "Live stream" : source === "files" ? (idbOk ? `${upList.length} file(s) · saved on this device` : "stays on this device for this session") : ""}${playing ? " · playing" : ""}`;

  const load = useCallback((t: Track | undefined, autoplay: boolean) => {
    const a = audio.current;
    if (!t) return;
    if (a.src !== t.src) a.src = t.src;
    if (autoplay) a.play().then(() => setPlaying(true)).catch(() => { setPlaying(false); toast.error("Couldn't play that — try another station or file"); });
  }, []);

  useEffect(() => { audio.current.volume = vol; }, [vol]);
  useEffect(() => {
    const a = audio.current;
    const onEnd = () => {
      if (source === "radio") setIdx((i) => (i + 1) % STATIONS.length);
      else if (source === "files") setUpIdx((i) => (upList.length ? (i + 1) % upList.length : 0));
    };
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    a.addEventListener("ended", onEnd); a.addEventListener("pause", onPause); a.addEventListener("play", onPlay);
    return () => { a.removeEventListener("ended", onEnd); a.removeEventListener("pause", onPause); a.removeEventListener("play", onPlay); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, upList.length]);
  // radio/files: advancing the index while playing loads the new track
  useEffect(() => { if (playing && source !== "youtube") load(track, true); }, [idx, upIdx]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { upRef.current.forEach((f) => URL.revokeObjectURL(f.src)); }, []);

  // hydrate persisted uploads
  useEffect(() => {
    (async () => {
      try {
        const recs = await idbAll();
        setUpList(recs.map((r) => ({ id: r.id, title: r.name, src: URL.createObjectURL(r.blob) })));
      } catch { setIdbOk(false); }
    })();
  }, []);

  // create the YouTube player once (kept mounted, hidden when on other tabs)
  useEffect(() => {
    if (source !== "youtube") return;
    let cancelled = false;
    (async () => {
      try {
        if (!(window as any).YT?.Player) { // eslint-disable-line @typescript-eslint/no-explicit-any
          await new Promise<void>((res, rej) => {
            const tag = document.createElement("script");
            tag.src = "https://www.youtube.com/iframe_api";
            tag.onerror = () => rej(new Error("yt api"));
            (window as any).onYouTubeIframeAPIReady = () => res(); // eslint-disable-line @typescript-eslint/no-explicit-any
            document.head.appendChild(tag);
            setTimeout(() => rej(new Error("timeout")), 15000);
          });
        }
        if (cancelled) return;
        setYtApiReady(true);
        if (!ytPlayer.current && ytWrapRef.current) {
          ytPlayer.current = new (window as any).YT.Player(ytWrapRef.current, { // eslint-disable-line @typescript-eslint/no-explicit-any
            height: "180",
            width: "100%",
            videoId: ytList[ytIdx]?.id,
            playerVars: { rel: 0 },
            events: {
              onStateChange: (e: any) => setPlaying(e.data === 1), // eslint-disable-line @typescript-eslint/no-explicit-any
              onError: () => toast.error("That YouTube video can't be played here"),
            },
          });
        }
      } catch { if (!cancelled) toast.error("Couldn't load the YouTube player"); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // switching tabs pauses the other audio
  useEffect(() => {
    if (source === "youtube") audio.current.pause();
    else ytPlayer.current?.pauseVideo?.();
  }, [source]);

  // selecting another YouTube video loads it (autoplays)
  useEffect(() => {
    if (source !== "youtube" || !ytPlayer.current) return;
    const v = ytList[ytIdx];
    if (v) ytPlayer.current.loadVideoById(v.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytIdx, ytApiReady]);

  const play = () => {
    if (source === "youtube") {
      if (!ytList.length) { toast.info("Add a YouTube link first"); return; }
      wantPlay.current = true;
      const v = ytList[ytIdx];
      if (v && ytPlayer.current) ytPlayer.current.loadVideoById(v.id);
      return;
    }
    load(track, true);
  };
  const pause = () => {
    if (source === "youtube") { wantPlay.current = false; ytPlayer.current?.pauseVideo?.(); return; }
    audio.current.pause();
  };
  const next = () => {
    if (source === "youtube") { wantPlay.current = true; setYtIdx((i) => (ytList.length ? (i + 1) % ytList.length : 0)); return; }
    if (source === "files") setUpIdx((i) => (upList.length ? (i + 1) % upList.length : 0));
    else setIdx((i) => (i + 1) % STATIONS.length);
  };
  const prev = () => {
    if (source === "youtube") { wantPlay.current = true; setYtIdx((i) => (ytList.length ? (i - 1 + ytList.length) % ytList.length : 0)); return; }
    if (source === "files") setUpIdx((i) => (upList.length ? (i - 1 + upList.length) % upList.length : 0));
    else setIdx((i) => (i - 1 + STATIONS.length) % STATIONS.length);
  };
  const louder = () => onVol(Math.min(1, +(vol + 0.15).toFixed(2)));
  const quieter = () => onVol(Math.max(0, +(vol - 0.15).toFixed(2)));
  const onVol = (v: number) => {
    setVol(v);
    ytPlayer.current?.setVolume?.(Math.round(v * 100));
  };

  const command = useCallback((raw: string) => {
    const t = raw.toLowerCase();
    setHeard(raw.trim());
    if (/\b(pause|stop)\b/.test(t)) pause();
    else if (/\b(next|skip)\b/.test(t)) { next(); if (!playing) play(); }
    else if (/\b(previous|back)\b/.test(t)) prev();
    else if (/\b(louder|volume up|turn it up)\b/.test(t)) louder();
    else if (/\b(quieter|softer|volume down|turn it down)\b/.test(t)) quieter();
    else if (/\b(youtube)\b/.test(t)) setSource("youtube");
    else if (/\b(radio|station)\b/.test(t)) setSource("radio");
    else if (/\b(my music|my files|playlist)\b/.test(t)) setSource("files");
    else if (/\b(play|resume|start)\b/.test(t)) play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, upList, ytList, track]);

  const toggleVoice = () => {
    const Ctor = getRec();
    if (!Ctor) { toast.error("Voice commands need Chrome, Edge or Safari"); return; }
    if (listening) { wantListen.current = false; rec.current?.stop(); setListening(false); return; }
    const r = new Ctor();
    r.continuous = true; r.interimResults = false; r.lang = navigator.language || "en-US";
    r.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) command(e.results[i][0].transcript); };
    r.onerror = (e) => { if (e.error === "not-allowed") { wantListen.current = false; setListening(false); toast.error("Microphone permission denied"); } };
    r.onend = () => { if (wantListen.current) { try { r.start(); } catch { /* restarting */ } } };
    rec.current = r; wantListen.current = true;
    r.start(); setListening(true);
    toast.info('Say "play", "pause", "next", "louder", "quieter", "radio", "youtube" or "my music"');
  };
  useEffect(() => { if (rec.current) rec.current.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) command(e.results[i][0].transcript); }; }, [command]);
  useEffect(() => () => { wantListen.current = false; rec.current?.stop(); }, []);

  const pick = (fl: FileList | null) => {
    if (!fl?.length) return;
    const items = [...fl].filter((f) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|ogg|wav|flac)$/i.test(f.name));
    if (!items.length) { toast.error("No audio files in that selection"); return; }
    const rnd = () => ((crypto as unknown as { randomUUID?: () => string }).randomUUID?.() ?? Math.random().toString(36).slice(2));
    const made: Track[] = items.map((f) => {
      const id = rnd();
      const title = f.name.replace(/\.[^.]+$/, "");
      idbPut({ id, name: title, blob: f }).catch(() => setIdbOk(false));
      return { id, title, src: URL.createObjectURL(f) };
    });
    setUpIdx(upList.length);
    setUpList([...upList, ...made]);
    setSource("files");
    toast.success(idbOk ? "Saved on this device" : "Added for this session");
  };

  const removeUpload = (id?: string) => {
    const t = upList.find((x) => x.id === id);
    if (t) URL.revokeObjectURL(t.src);
    setUpList(upList.filter((x) => x.id !== id));
    if (id) idbDel(id).catch(() => { /* already gone */ });
    setUpIdx(0);
  };

  const addYT = async () => {
    const raw = ytUrl.trim();
    const id = ytIdFromUrl(raw);
    if (!id) { toast.error("That doesn't look like a YouTube link"); return; }
    if (ytList.some((v) => v.id === id)) { toast.info("Already in your list"); setYtUrl(""); return; }
    setYtAdding(true);
    const title = await ytTitleFor(raw, id);
    const nextList = [...ytList, { id, title }];
    if (!ytList.length) setYtIdx(0);
    setYtList(nextList);
    saveJSON("mp.youtube", nextList);
    setYtUrl("");
    setYtAdding(false);
  };

  const removeYT = (id: string) => {
    const nextList = ytList.filter((v) => v.id !== id);
    setYtList(nextList);
    saveJSON("mp.youtube", nextList);
    setYtIdx(0);
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} data-testid="music-open-button" aria-label="Open music player"
        className={cn("fixed bottom-4 right-4 z-30 grid size-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform duration-150 hover:scale-105 print:hidden", playing && "animate-pulse-dot")}>
        <Music2 className="size-5" />
      </button>
    );
  }

  return (
    <div className="fixed inset-x-3 bottom-3 z-30 rounded-xl border border-border bg-card/95 p-3 shadow-2xl backdrop-blur-xl sm:left-auto sm:right-4 sm:w-80 print:hidden" data-testid="music-player">
      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-md bg-muted p-0.5">
          {(["radio", "youtube", "files"] as const).map((s) => (
            <button key={s} onClick={() => setSource(s)} data-testid={`music-source-${s}`}
              className={cn("flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors duration-150", source === s ? "bg-card shadow-sm" : "text-muted-foreground")}>
              {s === "radio" ? <><Radio className="size-3" /> Radio</> : s === "youtube" ? <><Youtube className="size-3" /> YouTube</> : <><FolderOpen className="size-3" /> My music</>}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon-xs" onClick={() => setOpen(false)} data-testid="music-minimize-button" aria-label="Minimise"><X /></Button>
      </div>

      <div className="mt-3 min-h-10">
        <div className="truncate text-sm font-medium" data-testid="music-now-playing">{nowTitle}</div>
        <div className="text-[11px] text-muted-foreground">{nowSub}</div>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <Button variant="ghost" size="icon-sm" onClick={prev} data-testid="music-prev-button"><SkipBack /></Button>
        <Button size="icon" className="rounded-full" onClick={() => (playing ? pause() : play())} disabled={source === "youtube" ? !ytList.length : !track} data-testid="music-play-button">{playing ? <Pause /> : <Play />}</Button>
        <Button variant="ghost" size="icon-sm" onClick={next} data-testid="music-next-button"><SkipForward /></Button>
        <Button variant="ghost" size="icon-sm" onClick={quieter} data-testid="music-quieter-button"><Volume1 /></Button>
        <input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => onVol(Number(e.target.value))} className="w-16 accent-[var(--primary)]" data-testid="music-volume-slider" aria-label="Volume" />
        <Button variant="ghost" size="icon-sm" onClick={louder} data-testid="music-louder-button"><Volume2 /></Button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Button variant={listening ? "default" : "outline"} size="sm" className="flex-1" onClick={toggleVoice} data-testid="music-voice-button">
          {listening ? <><Mic className="animate-pulse-dot" /> Listening…</> : <><MicOff /> Voice control</>}
        </Button>
        {source === "files" && (
          <label className="cursor-pointer">
            <input type="file" accept="audio/*" multiple className="sr-only" onChange={(e) => pick(e.target.files)} data-testid="music-file-input" />
            <span className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-sm hover:bg-muted"><FolderOpen className="size-4" /> Add</span>
          </label>
        )}
      </div>
      {heard && <div className="mt-1 truncate text-[11px] text-muted-foreground" data-testid="music-heard">Heard: "{heard}"</div>}

      {/* YouTube panel */}
      <div className={cn(source === "youtube" ? "" : "hidden")}>
        <div ref={ytWrapRef} className="mt-2 overflow-hidden rounded-lg bg-black" data-testid="music-yt-player" />
      </div>
      {source === "youtube" && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-1.5">
            <input value={ytUrl} onChange={(e) => setYtUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addYT(); }}
              placeholder="Paste a YouTube link" data-testid="music-yt-input"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm" />
            <Button size="sm" onClick={() => void addYT()} disabled={ytAdding} data-testid="music-yt-add">{ytAdding ? "…" : "Add"}</Button>
          </div>
          {ytList.length > 0 && (
            <div className="max-h-28 space-y-0.5 overflow-y-auto border-t border-border pt-2">
              {ytList.map((v, i) => (
                <div key={v.id} className={cn("flex items-center gap-1 rounded px-1", i === ytIdx && "bg-primary/10")}>
                  <button onClick={() => { setYtIdx(i); wantPlay.current = true; if (ytPlayer.current) ytPlayer.current.loadVideoById(v.id); }} data-testid={`music-yt-track-${i}`}
                    className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-muted">
                    <span className={cn(i === ytIdx && "font-medium")}>{v.title}</span>
                  </button>
                  <Button variant="ghost" size="icon-xs" onClick={() => removeYT(v.id)} aria-label={`Remove ${v.title}`} data-testid={`music-yt-remove-${i}`}><Trash2 className="size-3" /></Button>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Your YouTube list is saved on this device.</p>
        </div>
      )}

      {/* radio station list */}
      {source === "radio" && STATIONS.length > 1 && (
        <div className="mt-2 max-h-28 space-y-0.5 overflow-y-auto border-t border-border pt-2">
          {STATIONS.map((t, i) => (
            <button key={t.src} onClick={() => { setIdx(i); load(t, true); }} data-testid={`music-track-${i}`}
              className={cn("block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors duration-150 hover:bg-muted", i === idx && "bg-primary/10 font-medium")}>{t.title}</button>
          ))}
        </div>
      )}

      {/* uploaded files list */}
      {source === "files" && (
        <div className="mt-2 space-y-2">
          {upList.length > 0 && (
            <div className="max-h-28 space-y-0.5 overflow-y-auto border-t border-border pt-2">
              {upList.map((t, i) => (
                <div key={t.id ?? t.src} className={cn("flex items-center gap-1 rounded px-1", i === upIdx && "bg-primary/10")}>
                  <button onClick={() => { setUpIdx(i); load(t, true); }} data-testid={`music-file-track-${i}`}
                    className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-muted">
                    <span className={cn(i === upIdx && "font-medium")}>{t.title}</span>
                  </button>
                  <Button variant="ghost" size="icon-xs" onClick={() => removeUpload(t.id)} aria-label={`Remove ${t.title}`} data-testid={`music-file-remove-${i}`}><Trash2 className="size-3" /></Button>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {idbOk ? "Uploads are stored on this device and survive restarts." : "Uploads stay on this device for this session."}
          </p>
        </div>
      )}
    </div>
  );
}
