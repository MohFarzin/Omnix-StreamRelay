import { spawn, type ChildProcess } from "node:child_process";
import { decrypt, maskKey } from "../crypto.js";
import { getTarget, listTargets, setTargetError, type StreamTarget } from "../db.js";
import { config, ingestPath, type IngestLane } from "../config.js";
import { ingestBoth } from "./mediamtx.js";

type ProcState = {
  child: ChildProcess;
  startedAt: number;
  outboundApprox: number;
  stopping: boolean;
  /** When true, exit after stop is an OBS recycle — do not apply Kick hold-off. */
  recycle: boolean;
  laneEpoch: number;
};

const procs = new Map<string, ProcState>();
/** Don't hammer Kick/YT after a reject — exponential backoff. */
const backoffUntil = new Map<string, number>();
const failStreak = new Map<string, number>();
/** Wall-clock when lane last looked live (for stable delay). */
const ingestLiveSince: Record<IngestLane, number> = { main: 0, vertical: 0 };
/** Last MediaMTX bytesReceived — stall = OBS gone even if path still "ready". */
const lastBytesIn: Record<IngestLane, number> = { main: -1, vertical: -1 };
const bytesStallSince: Record<IngestLane, number> = { main: 0, vertical: 0 };
/** Bumps when OBS leaves or returns — running ffmpeg with old epoch is force-recycled. */
const laneEpoch: Record<IngestLane, number> = { main: 0, vertical: 0 };
const laneWasStable: Record<IngestLane, boolean> = { main: false, vertical: false };

const STABLE_MS = 2500;
const STALL_MS = 4000;

/** Prefer local RTMP remux (cleaner for FLV out) over RTSP. */
function ingestUrl(lane: IngestLane = "main"): string {
  const base = (process.env.MTX_RTMP_BASE || "rtmp://127.0.0.1:1935").replace(/\/$/, "");
  return `${base}/${ingestPath(lane)}`;
}

function destUrl(t: StreamTarget): string {
  const key = decrypt(t.stream_key_enc).replace(/^\/+/, "");
  let base = t.rtmp_url.replace(/\/$/, "");
  // Kick/IVS: RTMPS :443 + /app (OBS hides /app; FFmpeg needs it)
  if (t.platform === "kick" || /live-video\.net/i.test(base)) {
    if (base.startsWith("rtmp://")) base = base.replace(/^rtmp:\/\//i, "rtmps://");
    base = base.replace(/^(rtmps:\/\/[^/:]+)(?::\d+)?/i, "$1:443");
    base = base.replace(/\/app\/.+$/i, "/app");
    if (!/\/app$/i.test(base)) base = `${base.replace(/\/$/, "")}/app`;
  }
  if (
    base.includes("twitch.tv") ||
    base.includes("youtube.com") ||
    base.includes("googlevideo.com") ||
    base.includes("kick.com") ||
    base.includes("live-video.net")
  ) {
    return `${base}/${key}`;
  }
  return key ? `${base}/${key}` : base;
}

function redactSecrets(s: string): string {
  return s
    .replace(/rtmps?:\/\/\S+/gi, (url) =>
      url.replace(/\/([^/?\s]{6,})(?=$|\s)/, (_m, key: string) => `/${maskKey(key)}`)
    )
    .replace(/\b(?:sk_|live_)[A-Za-z0-9_-]{8,}\b/g, (k) => maskKey(k))
    .replace(/\b[a-z0-9]{4}(?:-[a-z0-9]{4}){3,}\b/gi, (k) => maskKey(k));
}

function summarizeError(buf: string): string {
  const lines = buf
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !/Non-monotonous DTS/i.test(l) &&
        !/Failed to update header/i.test(l) &&
        !/incorrect timestamps/i.test(l) &&
        !/Last message repeated/i.test(l)
    );
  const pick = lines.at(-1) || "relay disconnected";
  const clean = redactSecrets(pick.replace(/^\[.*?\]\s*/, ""));
  const hay = buf + clean;
  if (/Error closing file|Input\/output error|Broken pipe|End of file/i.test(clean) && /live-video\.net|rtmps:/i.test(hay)) {
    return "Kick dropped the link — will retry; keep OBS ≤8000 kbps CBR if this keeps looping";
  }
  if (
    /Error closing file|Input\/output error|Broken pipe|End of file/i.test(clean) &&
    /youtube\.com|googlevideo\.com/i.test(hay)
  ) {
    return "YouTube closed the ingest — open Live Control Room, confirm stream is Not ended, paste a fresh key, then On again";
  }
  return clean.slice(0, 160);
}

function scheduleBackoff(id: string, kick = false): number {
  const n = (failStreak.get(id) ?? 0) + 1;
  failStreak.set(id, n);
  // Kick: longer gaps so IVS can release the old session (avoids 5–20s flap)
  const base = kick ? 20_000 : 5_000;
  const ms = Math.min(120_000, base * 2 ** Math.min(n - 1, 3));
  backoffUntil.set(id, Date.now() + ms);
  return ms;
}

function clearBackoff(id: string): void {
  failStreak.delete(id);
  backoffUntil.delete(id);
}

function startOne(t: StreamTarget): void {
  if (procs.has(t.id)) return;
  const until = backoffUntil.get(t.id) ?? 0;
  if (Date.now() < until) return;

  const lane: IngestLane = t.lane === "vertical" ? "vertical" : "main";
  const input = ingestUrl(lane);
  const output = destUrl(t);
  const isKick = t.platform === "kick" || /live-video\.net/i.test(t.rtmp_url);
  // Default: copy like Twitch/YT (Kick shows “live” on RTMPS but blank/offline if our re-encode is wrong).
  // Escape hatch: KICK_TRANSCODE=1 → light ≤8 Mbps re-encode (old flap guard).
  const kickTranscode =
    isKick && /^(1|true|yes)$/i.test(String(process.env.KICK_TRANSCODE || "").trim());
  const readArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts+discardcorrupt",
    "-i",
    input,
  ];
  const args = kickTranscode
    ? [
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "+genpts+discardcorrupt+nobuffer",
        "-flags",
        "low_delay",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-i",
        input,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "main",
        "-pix_fmt",
        "yuv420p",
        "-b:v",
        "8000k",
        "-maxrate",
        "8000k",
        "-bufsize",
        "8000k",
        "-g",
        "120",
        "-keyint_min",
        "120",
        "-sc_threshold",
        "0",
        "-bf",
        "0",
        "-x264-params",
        "nal-hrd=cbr:force-cfr=1:ref=1:bframes=0:aud=1:rc-lookahead=0:sync-lookahead=0:sliced-threads=1",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-flvflags",
        "no_duration_filesize",
        "-flush_packets",
        "1",
        "-f",
        "flv",
        output,
      ]
    : [
        ...readArgs,
        "-c",
        "copy",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-flvflags",
        "no_duration_filesize",
        "-f",
        "flv",
        output,
      ];
  void config;
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  const state: ProcState = {
    child,
    startedAt: Date.now(),
    outboundApprox: 0,
    stopping: false,
    recycle: false,
    laneEpoch: laneEpoch[lane],
  };
  procs.set(t.id, state);
  if ((failStreak.get(t.id) ?? 0) === 0) setTargetError(t.id, null);

  let errBuf = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errBuf = (errBuf + chunk.toString()).slice(-2000);
  });
  child.on("exit", (code, signal) => {
    const wasStopping = state.stopping || signal === "SIGTERM" || signal === "SIGKILL";
    const uptime = Date.now() - state.startedAt;
    procs.delete(t.id);
    if (wasStopping) {
      // User disable / crash storms only — OBS recycle must reconnect immediately
      if (isKick && !state.recycle) backoffUntil.set(t.id, Date.now() + 8_000);
      setTargetError(t.id, null);
      return;
    }
    if (uptime >= 60_000) clearBackoff(t.id);
    if (code !== 0 && code !== null) {
      const wait = scheduleBackoff(t.id, isKick);
      const msg = summarizeError(errBuf) || `ffmpeg exited ${code}`;
      setTargetError(t.id, `${msg} (retry in ${Math.round(wait / 1000)}s)`);
    } else if (uptime < 15_000) {
      const wait = scheduleBackoff(t.id, isKick);
      setTargetError(t.id, `Relay ended early (retry in ${Math.round(wait / 1000)}s)`);
    }
  });
}

/** Clear fail streak (e.g. after user pastes a new Kick key). */
export function resetTargetBackoff(id: string): void {
  clearBackoff(id);
}

export function stopTarget(id: string, opts?: { recycle?: boolean }): void {
  const p = procs.get(id);
  if (!p) return;
  p.stopping = true;
  if (opts?.recycle) p.recycle = true;
  try {
    p.child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    if (procs.get(id)?.child === p.child) {
      try {
        p.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }, 4000);
  // Keep map entry until exit handler so reconcile won't double-spawn
  setTargetError(id, null);
}

export function stopAll(): void {
  for (const id of [...procs.keys()]) stopTarget(id);
}

export function processStatus(): Record<
  string,
  { running: boolean; uptimeSec: number; outboundApprox: number }
> {
  const out: Record<string, { running: boolean; uptimeSec: number; outboundApprox: number }> = {};
  for (const [id, p] of procs) {
    out[id] = {
      running: true,
      uptimeSec: Math.floor((Date.now() - p.startedAt) / 1000),
      outboundApprox: p.outboundApprox,
    };
  }
  return out;
}

function laneEffectivelyLive(lane: IngestLane, live: boolean, bytesIn: number): boolean {
  if (!live) {
    lastBytesIn[lane] = -1;
    bytesStallSince[lane] = 0;
    return false;
  }
  if (bytesIn > lastBytesIn[lane]) {
    lastBytesIn[lane] = bytesIn;
    bytesStallSince[lane] = 0;
    return true;
  }
  // Path still "ready" but OBS bytes frozen → treat as offline (stale Kick/YT sessions)
  if (!bytesStallSince[lane]) bytesStallSince[lane] = Date.now();
  return Date.now() - bytesStallSince[lane] < STALL_MS;
}

/** Reconcile enabled targets with ingest readiness (main + vertical lanes). */
export async function reconcile(): Promise<void> {
  const both = await ingestBoth();
  const stableNow: Record<IngestLane, boolean> = { main: false, vertical: false };

  for (const lane of ["main", "vertical"] as const) {
    const eff = laneEffectivelyLive(lane, both[lane].live, both[lane].bytesIn);
    if (eff) {
      if (!ingestLiveSince[lane]) ingestLiveSince[lane] = Date.now();
    } else {
      if (ingestLiveSince[lane] || laneWasStable[lane]) {
        laneEpoch[lane] += 1; // OBS left — invalidate running relays on this lane
      }
      ingestLiveSince[lane] = 0;
    }
    const stable = Boolean(eff && Date.now() - ingestLiveSince[lane] >= STABLE_MS);
    if (stable && !laneWasStable[lane]) {
      // OBS (or Aitum) just became stable again → same as dashboard Off→On for every dest
      laneEpoch[lane] += 1;
      for (const t of listTargets()) {
        const tLane: IngestLane = t.lane === "vertical" ? "vertical" : "main";
        if (tLane !== lane || !t.enabled) continue;
        clearBackoff(t.id);
        if (procs.has(t.id)) stopTarget(t.id, { recycle: true });
      }
    }
    laneWasStable[lane] = stable;
    stableNow[lane] = stable;
  }

  const targets = listTargets();
  for (const t of targets) {
    const lane: IngestLane = t.lane === "vertical" ? "vertical" : "main";
    const shouldRun = Boolean(t.enabled) && stableNow[lane];
    const running = procs.has(t.id);
    const st = procs.get(t.id);
    if (running && st && st.laneEpoch !== laneEpoch[lane]) {
      stopTarget(t.id, { recycle: true });
      continue;
    }
    if (shouldRun && !running) startOne(t);
    if (!shouldRun && running) stopTarget(t.id, { recycle: true });
    if (running && Date.now() - (procs.get(t.id)?.startedAt ?? 0) > 15_000) {
      clearBackoff(t.id);
      setTargetError(t.id, null);
    }
  }
  for (const id of procs.keys()) {
    if (!getTarget(id)?.enabled) stopTarget(id);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startReconcileLoop(ms = 2000): void {
  if (timer) return;
  timer = setInterval(() => {
    void reconcile().catch(() => undefined);
  }, ms);
}

export function stopReconcileLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  stopAll();
}
