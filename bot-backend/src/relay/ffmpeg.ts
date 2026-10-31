import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { decrypt, maskKey } from "../crypto.js";
import { getTarget, listTargets, setTargetError, type StreamTarget } from "../db.js";
import { config, ingestPath, type IngestLane } from "../config.js";
import { ingestBoth } from "./mediamtx.js";

type ProcState = {
  child: ChildProcess;
  startedAt: number;
  outboundApprox: number;
  stopping: boolean;
  recycle: boolean;
  laneEpoch: number;

  sourceKey: string;
};

const procs = new Map<string, ProcState>();
const backoffUntil = new Map<string, number>();
const failStreak = new Map<string, number>();
const ingestLiveSince: Record<IngestLane, number> = { main: 0, vertical: 0 };
const lastBytesIn: Record<IngestLane, number> = { main: -1, vertical: -1 };
const bytesStallSince: Record<IngestLane, number> = { main: 0, vertical: 0 };
const laneEpoch: Record<IngestLane, number> = { main: 0, vertical: 0 };
const laneWasStable: Record<IngestLane, boolean> = { main: false, vertical: false };
const youtubeWarmupDone = new Set<string>();

let lastRelayMode: "off" | "ingest" | "filler" = "off";

const STABLE_MS = 2000;

const STALL_MS_EPOCH = 60_000;

const STALL_MS_SESSION = 6_000;
const YT_START_MS = 4500;

const YT_INGEST_RECONNECT_MS = 6000;
const bytesStallSinceSession: Record<IngestLane, number> = { main: 0, vertical: 0 };
const lastBytesInSession: Record<IngestLane, number> = { main: -1, vertical: -1 };

function ingestUrl(lane: IngestLane = "main"): string {
  const base = (process.env.MTX_RTMP_BASE || "rtmp://127.0.0.1:1935").replace(/\/$/, "");
  return `${base}/${ingestPath(lane)}`;
}

function isKick(t: StreamTarget): boolean {
  return t.platform === "kick" || /live-video\.net/i.test(t.rtmp_url);
}

function isTwitch(t: StreamTarget): boolean {
  return t.platform === "twitch" || /twitch\.tv/i.test(t.rtmp_url);
}

function isYouTube(t: StreamTarget): boolean {
  return t.platform === "youtube" || /youtube\.com|googlevideo\.com/i.test(t.rtmp_url);
}

function envFlag(name: string): boolean {
  return /^(1|true|yes)$/i.test(String(process.env[name] || "").trim());
}

type CfrPub = { child: ChildProcess; input: string; stopping: boolean; startedAt: number };
let cfrPub: CfrPub | null = null;

function cfrRtmpUrl(): string {
  const base = (process.env.MTX_RTMP_BASE || "rtmp://127.0.0.1:1935").replace(/\/$/, "");
  return `${base}/live/omnix_cfr`;
}

function stopCfrPublisher(): void {
  if (!cfrPub) return;
  cfrPub.stopping = true;
  try {
    cfrPub.child.kill("SIGTERM");
  } catch {
  }
  cfrPub = null;
}

function cfr1080p60Args(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts+discardcorrupt",
    "-i",
    input,
    "-vf",
    "fps=60,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    "7500k",
    "-maxrate",
    "7500k",
    "-bufsize",
    "7500k",
    "-g",
    "120",
    "-keyint_min",
    "120",
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-threads",
    "2",
    "-x264-params",
    "nal-hrd=cbr:force-cfr=1:ref=1:bframes=0:aud=1:rc-lookahead=0:sync-lookahead=0:keyint=120:min-keyint=120",
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
    "-f",
    "flv",
    output,
  ];
}

function ensureCfrPublisher(input: string): boolean {
  if (cfrPub && !cfrPub.stopping && cfrPub.input === input && !cfrPub.child.killed) {
    return true;
  }
  if (cfrPub) stopCfrPublisher();
  const out = cfrRtmpUrl();
  const child = spawn("ffmpeg", cfr1080p60Args(input, out), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const state: CfrPub = { child, input, stopping: false, startedAt: Date.now() };
  cfrPub = state;
  child.on("exit", () => {
    if (cfrPub?.child === child) cfrPub = null;
  });
  child.on("error", () => {
    if (cfrPub?.child === child) cfrPub = null;
  });
  console.log(`[relay] CFR publisher → ${out} (1080p60 · ≤7500k · Kick/Twitch)`);
  return true;
}

function needsPlatformCfr(t: StreamTarget): boolean {
  return (isKick(t) && envFlag("KICK_TRANSCODE")) || (isTwitch(t) && envFlag("TWITCH_TRANSCODE"));
}

function copyFlvArgs(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts+discardcorrupt",
    "-avoid_negative_ts",
    "make_zero",
    "-i",
    input,
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
}

function destUrl(t: StreamTarget): string {
  const key = decrypt(t.stream_key_enc).replace(/^\/+/, "");
  let base = t.rtmp_url.replace(/\/$/, "");
  if (isKick(t)) {
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
  const base = kick ? 20_000 : 5_000;
  const ms = Math.min(120_000, base * 2 ** Math.min(n - 1, 3));
  backoffUntil.set(id, Date.now() + ms);
  return ms;
}

function clearBackoff(id: string): void {
  failStreak.delete(id);
  backoffUntil.delete(id);
}

type FillerPub = {
  child: ChildProcess;
  file: string;
  stopping: boolean;
  startedAt: number;
  mode: "copy" | "encode";
  vertical: boolean;
};
let fillerPub: FillerPub | null = null;
let fillerPubV: FillerPub | null = null;

const fillerBakeBusy = new Set<string>();

function fillerRtmpUrl(vertical = false): string {
  const base = (process.env.MTX_RTMP_BASE || `rtmp://127.0.0.1:${config.rtmpPort || 1935}`).replace(
    /\/$/,
    ""
  );
  return `${base}/live/${vertical ? "omnix_filler_v" : "omnix_filler"}`;
}

function fillerCacheFor(file: string, vertical = false): string {
  return vertical ? `${file}.relay.v.flv` : `${file}.relay.flv`;
}

function cacheHasAudio(cache: string): boolean {
  try {
    const r = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        cache,
      ],
      { encoding: "utf8", timeout: 8_000 }
    );
    return /audio/i.test(String(r.stdout || ""));
  } catch {
    return false;
  }
}

function fillerCacheFresh(file: string, cache: string): boolean {
  try {

    return (
      existsSync(cache) &&
      statSync(cache).mtimeMs >= statSync(file).mtimeMs &&
      statSync(cache).size > 10_000 &&
      cacheHasAudio(cache)
    );
  } catch {
    return false;
  }
}

export function bakeFillerCache(file: string, vertical = false): boolean {
  if (!existsSync(file)) return false;
  const cache = fillerCacheFor(file, vertical);
  if (fillerCacheFresh(file, cache)) return true;
  const busyKey = `${file}:${vertical ? "v" : "m"}`;
  if (fillerBakeBusy.has(busyKey)) return false;
  fillerBakeBusy.add(busyKey);
  const tmp = `${cache}.part`;
  try {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
    }
    const vf = vertical
      ? "fps=15,scale=480:854:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2,setsar=1"
      : "fps=15,scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1";
    const hasAudio = fillerHasAudio(file);

    const bakeSecs = "30";

    const vencode = [
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "fastdecode",
      "-profile:v",
      "baseline",
      "-level",
      "3.0",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      "-x264-params",
      "keyint=30:min-keyint=30:scenecut=0:bframes=0:ref=1",
      "-b:v",
      "500k",
      "-maxrate",
      "500k",
      "-bufsize",
      "1000k",
      "-g",
      "30",
      "-bf",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-t",
      bakeSecs,
      "-flvflags",
      "no_duration_filesize",
      "-f",
      "flv",
      tmp,
    ];
    const args = hasAudio
      ? [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-t",
          bakeSecs,
          "-i",
          file,
          "-vf",
          vf,
          ...vencode,
        ]
      : [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-t",
          bakeSecs,
          "-i",
          file,
          "-f",
          "lavfi",
          "-t",
          bakeSecs,
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=44100",
          "-filter_complex",
          `[0:v]${vf}[v]`,
          "-map",
          "[v]",
          "-map",
          "1:a",
          "-shortest",
          ...vencode,
        ];
    const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 90_000 });
    if (r.status !== 0 || !existsSync(tmp) || statSync(tmp).size < 10_000 || !cacheHasAudio(tmp)) {
      console.warn(
        `[relay] filler bake${vertical ? " (9:16)" : ""} failed:`,
        (r.stderr || r.error || "unknown").toString().slice(0, 200)
      );
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
      }
      return false;
    }
    try {
      if (existsSync(cache)) unlinkSync(cache);
    } catch {
    }
    renameSync(tmp, cache);
    console.log(
      "[relay] filler cache ready",
      cache.split(/[/\\]/).pop(),
      `${Math.round(statSync(cache).size / 1024)}KB`,
      hasAudio ? "aac" : "silent-aac"
    );
    return true;
  } catch (e) {
    console.warn("[relay] filler bake error:", (e as Error).message);
    return false;
  } finally {
    fillerBakeBusy.delete(busyKey);
  }
}

export function bakeAllFillerCaches(file: string): boolean {
  const a = bakeFillerCache(file, false);
  const b = bakeFillerCache(file, true);
  return a && b;
}

function resolveFillerLoop(file: string, vertical = false): { path: string; copy: boolean } {
  const cache = fillerCacheFor(file, vertical);
  if (fillerCacheFresh(file, cache)) return { path: cache, copy: true };

  if (bakeFillerCache(file, vertical)) return { path: cache, copy: true };
  return { path: file, copy: false };
}

function stopOneFiller(which: "main" | "vertical"): void {
  const cur = which === "vertical" ? fillerPubV : fillerPub;
  if (!cur) return;
  cur.stopping = true;
  try {
    cur.child.kill("SIGTERM");
  } catch {
  }
  if (which === "vertical") fillerPubV = null;
  else fillerPub = null;
}

function stopFillerPublisher(): void {
  stopOneFiller("main");
  stopOneFiller("vertical");
}

function fillerHasAudio(file: string): boolean {
  try {
    const r = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        file,
      ],
      { encoding: "utf8", timeout: 8_000 }
    );
    return /audio/i.test(String(r.stdout || ""));
  } catch {
    return false;
  }
}

function ensureOneFillerPublisher(file: string, vertical: boolean): boolean {
  const cur = vertical ? fillerPubV : fillerPub;
  if (
    cur &&
    cur.file === file &&
    cur.vertical === vertical &&
    !cur.stopping &&
    cur.child.exitCode == null &&
    !cur.child.killed
  ) {
    return true;
  }
  stopOneFiller(vertical ? "vertical" : "main");
  const out = fillerRtmpUrl(vertical);
  const loop = resolveFillerLoop(file, vertical);
  let args: string[];
  let mode: "copy" | "encode" = "encode";
  if (loop.copy) {

    mode = "copy";
    args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-re",
      "-stream_loop",
      "-1",
      "-i",
      loop.path,
      "-c",
      "copy",
      "-flvflags",
      "no_duration_filesize",
      "-f",
      "flv",
      out,
    ];
  } else {
    const hasAudio = fillerHasAudio(file);
    const vf = vertical
      ? "fps=15,scale=480:854:force_original_aspect_ratio=decrease,pad=480:854:(ow-iw)/2:(oh-ih)/2,setsar=1"
      : "fps=15,scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1";
    const vencode = [
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "baseline",
      "-level",
      "3.0",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      "-x264-params",
      "threads=1:sliced-threads=0:sync-lookahead=0:rc-lookahead=0:bframes=0:ref=1:aq-mode=0:scenecut=0:keyint=30:min-keyint=30",
      "-b:v",
      "500k",
      "-maxrate",
      "500k",
      "-bufsize",
      "1000k",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-bf",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-flvflags",
      "no_duration_filesize",
      "-f",
      "flv",
      out,
    ];
    args = hasAudio
      ? [
          "-hide_banner",
          "-loglevel",
          "error",
          "-re",
          "-stream_loop",
          "-1",
          "-i",
          file,
          "-vf",
          vf,
          ...vencode,
        ]
      : [
          "-hide_banner",
          "-loglevel",
          "error",
          "-re",
          "-stream_loop",
          "-1",
          "-i",
          file,
          "-f",
          "lavfi",
          "-stream_loop",
          "-1",
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=48000",
          "-filter_complex",
          `[0:v]${vf}[v]`,
          "-map",
          "[v]",
          "-map",
          "1:a",
          ...vencode,
        ];
    if (!vertical) {
      console.log(`[relay] filler audio=${hasAudio ? "from-file" : "silent-aac"} (live encode fallback)`);
    }
  }
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  const state: FillerPub = {
    child,
    file,
    stopping: false,
    startedAt: Date.now(),
    mode,
    vertical,
  };
  if (vertical) fillerPubV = state;
  else fillerPub = state;
  child.on("exit", () => {
    if (vertical) {
      if (fillerPubV?.child === child) fillerPubV = null;
    } else if (fillerPub?.child === child) fillerPub = null;
  });
  child.on("error", () => {
    if (vertical) {
      if (fillerPubV?.child === child) fillerPubV = null;
    } else if (fillerPub?.child === child) fillerPub = null;
  });
  console.log(
    `[relay] filler publisher → ${out} (${file.split(/[/\\]/).pop()} · ${vertical ? "9:16" : "16:9"} · ${mode})`
  );
  return true;
}

function ensureFillerPublisher(file: string): boolean {
  const a = ensureOneFillerPublisher(file, false);

  const needV = Boolean(getTarget("youtube-v")?.enabled);
  if (!needV) {
    stopOneFiller("vertical");
    return a;
  }
  return a && ensureOneFillerPublisher(file, true);
}

function startOne(
  t: StreamTarget,
  opts: { sourceKey: string; inputOverride?: string } = { sourceKey: "ingest" }
): void {
  if (procs.has(t.id)) return;
  const until = backoffUntil.get(t.id) ?? 0;
  if (Date.now() < until) return;

  const lane: IngestLane = t.lane === "vertical" ? "vertical" : "main";
  const input = opts.inputOverride || ingestUrl(lane);
  const output = destUrl(t);
  const kick = isKick(t);
  const yt = isYouTube(t);
  const fromFiller = Boolean(opts.inputOverride);

  const viaCfr = Boolean(opts.inputOverride) && /\/live\/omnix_cfr$/i.test(opts.inputOverride || "");

  const args = fromFiller && yt
    ? [
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "+genpts+discardcorrupt",
        "-analyzeduration",
        "2000000",
        "-probesize",
        "2000000",
        "-i",
        input,
        "-c",
        "copy",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-flush_packets",
        "1",
        "-flvflags",
        "no_duration_filesize",
        "-f",
        "flv",
        output,
      ]
    : copyFlvArgs(input, output);
  let keyPlain = "";
  try {
    keyPlain = decrypt(t.stream_key_enc);
  } catch {
    setTargetError(t.id, "YouTube key corrupt — Create stream again");
    return;
  }
  if (!keyPlain || /pending-youtube/i.test(keyPlain)) {

    setTargetError(t.id, null);
    console.warn(`[relay] skip ${t.id}: placeholder key (Create stream or Use existing live)`);
    return;
  }
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  const state: ProcState = {
    child,
    startedAt: Date.now(),
    outboundApprox: 0,
    stopping: false,
    recycle: false,
    laneEpoch: laneEpoch[lane],
    sourceKey: opts.sourceKey,
  };
  procs.set(t.id, state);
  if ((failStreak.get(t.id) ?? 0) === 0) setTargetError(t.id, null);
  console.log(
    `[relay] start ${t.id} (${t.platform}/${lane}) src=${opts.sourceKey}${
      viaCfr ? " via cfr1080p60" : fromFiller ? " via filler" : ""
    }`
  );

  let errBuf = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errBuf = (errBuf + chunk.toString()).slice(-2000);
  });
  child.on("error", () => {
    if (procs.get(t.id)?.child === child) procs.delete(t.id);
  });
  child.on("exit", (code, signal) => {
    const wasStopping = state.stopping || signal === "SIGTERM" || signal === "SIGKILL";
    const uptime = Date.now() - state.startedAt;
    procs.delete(t.id);
    if (wasStopping) {
      if (kick && !state.recycle) backoffUntil.set(t.id, Date.now() + 8_000);
      setTargetError(t.id, null);
      return;
    }

    if (kick) {
      const wait = scheduleBackoff(t.id, true);
      const msg =
        summarizeError(errBuf) ||
        (uptime < 45_000
          ? "Kick dropped early — use OBS ≤8000 kbps CBR, keyframe 2s (or set KICK_TRANSCODE=1)"
          : "Kick disconnected");
      setTargetError(t.id, `${msg} (retry in ${Math.round(wait / 1000)}s)`);
      return;
    }
    if (uptime >= 60_000) clearBackoff(t.id);
    if (code !== 0 && code !== null) {
      const wait = scheduleBackoff(t.id, false);
      const msg = summarizeError(errBuf) || `ffmpeg exited ${code}`;
      setTargetError(t.id, `${msg} (retry in ${Math.round(wait / 1000)}s)`);
    } else if (uptime < 15_000) {
      const wait = scheduleBackoff(t.id, false);
      setTargetError(t.id, `Relay ended early (retry in ${Math.round(wait / 1000)}s)`);
    }
  });
}

function pruneRelayMaps(): void {
  const now = Date.now();
  const alive = new Set(listTargets().map((t) => t.id));
  for (const id of [...backoffUntil.keys()]) {
    if (!alive.has(id) || (backoffUntil.get(id) ?? 0) <= now) backoffUntil.delete(id);
  }
  for (const id of [...failStreak.keys()]) {
    if (!alive.has(id)) failStreak.delete(id);
  }
}

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
  }
  setTimeout(() => {
    if (procs.get(id)?.child === p.child) {
      try {
        p.child.kill("SIGKILL");
      } catch {
      }
    }
  }, 4000);
  setTargetError(id, null);
}

export function stopAll(): void {
  stopFillerPublisher();
  stopCfrPublisher();
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

function laneLiveWithStall(
  lane: IngestLane,
  live: boolean,
  bytesIn: number,
  stallMs: number,
  lastBytes: Record<IngestLane, number>,
  stallSince: Record<IngestLane, number>
): boolean {

  if (!live) {
    if (lastBytes[lane] >= 0) {
      if (!stallSince[lane]) stallSince[lane] = Date.now();
      if (Date.now() - stallSince[lane] < stallMs) return true;
    }
    lastBytes[lane] = -1;
    stallSince[lane] = 0;
    return false;
  }
  if (bytesIn > lastBytes[lane]) {
    lastBytes[lane] = bytesIn;
    stallSince[lane] = 0;
    return true;
  }
  if (!stallSince[lane]) stallSince[lane] = Date.now();
  return Date.now() - stallSince[lane] < stallMs;
}

function laneEffectivelyLive(lane: IngestLane, live: boolean, bytesIn: number): boolean {
  return laneLiveWithStall(lane, live, bytesIn, STALL_MS_EPOCH, lastBytesIn, bytesStallSince);
}

function laneLiveForSession(lane: IngestLane, live: boolean, bytesIn: number): boolean {
  return laneLiveWithStall(
    lane,
    live,
    bytesIn,
    STALL_MS_SESSION,
    lastBytesInSession,
    bytesStallSinceSession
  );
}

function clearYoutubeWarmups(): void {
  youtubeWarmupDone.clear();
}

export async function reconcile(): Promise<void> {
  pruneRelayMaps();
  const both = await ingestBoth();
  const stableNow: Record<IngestLane, boolean> = { main: false, vertical: false };
  const sessionLive: Record<IngestLane, boolean> = { main: false, vertical: false };
  for (const lane of ["main", "vertical"] as const) {
    const eff = laneEffectivelyLive(lane, both[lane].live, both[lane].bytesIn);
    sessionLive[lane] = laneLiveForSession(lane, both[lane].live, both[lane].bytesIn);
    if (eff) {
      if (!ingestLiveSince[lane]) ingestLiveSince[lane] = Date.now();
    } else {
      if (ingestLiveSince[lane] || laneWasStable[lane]) {
        laneEpoch[lane] += 1;
        clearYoutubeWarmups();
      }
      ingestLiveSince[lane] = 0;
    }
    const stable = Boolean(eff && Date.now() - ingestLiveSince[lane] >= STABLE_MS);
    laneWasStable[lane] = stable;
    stableNow[lane] = stable;
  }

  const obsPresent = Boolean(sessionLive.main || sessionLive.vertical);
  let runtimeSource: { mode: "off" | "ingest" | "filler"; slot?: string } = { mode: "off" };
  let sessionForward = false;
  try {
    const { tickRuntime } = await import("../live/runtime.js");
    const rt = tickRuntime(obsPresent, () =>
      import("../live/apply.js")
        .then((m) => m.finalizeStreamSession())
        .then(() => undefined)
    );
    sessionForward = rt.phase === "waiting_obs" || rt.phase === "live" || rt.phase === "brb" || rt.phase === "ending";
    if (rt.source.mode === "filler") {
      runtimeSource = { mode: "filler", slot: rt.source.slot };
    } else if (rt.source.mode === "ingest") {
      runtimeSource = { mode: "ingest" };
    }
  } catch {
    try {
      const { isSessionLive } = await import("../live/session.js");
      sessionForward = isSessionLive();
      runtimeSource = { mode: sessionForward && obsPresent ? "ingest" : "off" };
    } catch {
      sessionForward = true;
      runtimeSource = { mode: obsPresent ? "ingest" : "off" };
    }
  }

  const prevRelayMode = lastRelayMode;
  lastRelayMode = runtimeSource.mode;

  let fillerFile = "";
  if (runtimeSource.mode === "filler" && runtimeSource.slot) {
    try {
      const { mediaPath, mediaExists } = await import("../live/media.js");
      const slot = runtimeSource.slot as "start" | "idle" | "end";
      if (mediaExists(slot)) fillerFile = mediaPath(slot);
      else runtimeSource = { mode: "off" };
    } catch {
      runtimeSource = { mode: "off" };
    }
  }

  const wantFiller = runtimeSource.mode === "filler" && Boolean(fillerFile);
  const fillerSlot = wantFiller ? runtimeSource.slot : null;
  const needVerticalFiller = Boolean(getTarget("youtube-v")?.enabled);

  const kickHoldBrb = wantFiller && fillerSlot === "idle";
  const fillerFileChanging =
    wantFiller &&
    Boolean(fillerFile) &&
    (!fillerPub ||
      fillerPub.file !== fillerFile ||
      fillerPub.stopping ||
      (needVerticalFiller &&
        (!fillerPubV || fillerPubV.file !== fillerFile || fillerPubV.stopping)));
  const leavingIngestForFiller = wantFiller && prevRelayMode === "ingest";

  if (fillerFileChanging || leavingIngestForFiller) {
    for (const id of [...procs.keys()]) {
      const t = getTarget(id);
      if (kickHoldBrb && t && isKick(t)) continue;
      clearBackoff(id);
      stopTarget(id, { recycle: true });
    }
  }
  if (wantFiller) {
    ensureFillerPublisher(fillerFile);
    stopCfrPublisher();

    for (const t of listTargets()) clearBackoff(t.id);
  } else {
    stopFillerPublisher();
  }

  const ingestMode = runtimeSource.mode === "ingest";
  const wantCfr =
    ingestMode &&
    stableNow.main &&
    listTargets().some((t) => Boolean(t.enabled) && needsPlatformCfr(t) && t.lane !== "vertical");
  if (wantCfr) {
    ensureCfrPublisher(ingestUrl("main"));
  } else if (!wantFiller) {
    stopCfrPublisher();
  }
  const cfrWarm = Boolean(cfrPub && Date.now() - cfrPub.startedAt >= 1500);

  const fillerAgeMain = fillerPub ? Date.now() - fillerPub.startedAt : 0;
  const fillerAgeV = fillerPubV ? Date.now() - fillerPubV.startedAt : 0;
  const fillerAge =
    needVerticalFiller && fillerPubV
      ? Math.min(fillerAgeMain, fillerAgeV)
      : fillerAgeMain;

  const fillerWarm =
    wantFiller &&
    Boolean(fillerPub) &&
    (!needVerticalFiller || Boolean(fillerPubV)) &&
    fillerAge >= 2000;
  const ytFillerNeedMs = runtimeSource.slot === "start" ? 6000 : 2500;
  const fillerWarmYt =
    wantFiller &&
    Boolean(fillerPub) &&
    (!needVerticalFiller || Boolean(fillerPubV)) &&
    fillerAge >= ytFillerNeedMs;

  for (const t of listTargets()) {
    const lane: IngestLane = t.lane === "vertical" ? "vertical" : "main";
    const yt = isYouTube(t);
    const wantIngest = runtimeSource.mode === "ingest";
    const ytReady =
      !yt ||
      Boolean(fillerWarmYt) ||
      (wantIngest && Date.now() - ingestLiveSince[lane] >= YT_START_MS);

    const laneOk =
      (Boolean(fillerWarm) && (lane === "main" || yt)) ||
      (wantIngest && stableNow[lane]);
    const kick = isKick(t);

    if (kick && sessionForward && kickHoldBrb) continue;
    if (kick && sessionForward && wantFiller === false && !wantIngest) continue;
    const shouldRun = sessionForward && Boolean(t.enabled) && laneOk && ytReady;
    const sourceKey = wantFiller
      ? `filler:${runtimeSource.slot}`
      : wantIngest
        ? `ingest:${laneEpoch[lane]}`
        : "off";
    const running = procs.has(t.id);
    const st = procs.get(t.id);

    if (running && st && st.sourceKey !== sourceKey) {

      if (kick && kickHoldBrb) continue;
      clearBackoff(t.id);
      stopTarget(t.id, { recycle: true });
      continue;
    }

    if (
      wantIngest &&
      shouldRun &&
      running &&
      yt &&
      st &&
      /^(1|true|yes)$/i.test(String(process.env.YT_INGEST_RECONNECT || "").trim())
    ) {
      const warmKey = `yt-ingest:${t.id}:${laneEpoch[lane]}`;
      const up = Date.now() - st.startedAt;
      if (up >= YT_INGEST_RECONNECT_MS && !youtubeWarmupDone.has(warmKey)) {
        youtubeWarmupDone.add(warmKey);
        clearBackoff(t.id);
        stopTarget(t.id, { recycle: true });
        continue;
      }
    }

    if (shouldRun && !running) {

      if (wantIngest && needsPlatformCfr(t) && lane === "main" && !cfrWarm) continue;
      clearBackoff(t.id);
      startOne(t, {
        sourceKey,

        inputOverride: fillerWarm
          ? fillerRtmpUrl(lane === "vertical")
          : wantIngest && needsPlatformCfr(t) && lane === "main" && cfrWarm
            ? cfrRtmpUrl()
            : undefined,
      });
    }
    if (!shouldRun && running) {
      if (kick && kickHoldBrb) {
      } else {
        stopTarget(t.id, { recycle: true });
      }
    }

    if (!sessionForward && yt && /key not ready/i.test(String(t.last_error || ""))) {
      setTargetError(t.id, null);
    }
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
let reconcileBusy = false;

export function startReconcileLoop(ms = 1500): void {
  if (timer) return;
  timer = setInterval(() => {
    if (reconcileBusy) return;
    reconcileBusy = true;
    void reconcile()
      .catch(() => undefined)
      .finally(() => {
        reconcileBusy = false;
      });
  }, ms);
}

export function stopReconcileLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  stopAll();
}
