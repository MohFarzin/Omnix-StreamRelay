import { createWriteStream, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { config } from "../config.js";
import { getSetting, setSetting } from "../db.js";

const K_TIMERS = "live.media.timers";

export type MediaSlot = "start" | "idle" | "end";

export type MediaTimers = {

  startWaitMs: number;

  brbWaitMs: number;

  endPlayMs: number;
};

const DEFAULT_TIMERS: MediaTimers = {
  startWaitMs: 50 * 60_000,
  brbWaitMs: 30 * 60_000,
  endPlayMs: 45_000,
};

const MIN_MS = 5_000;
const MAX_MS = 10 * 60 * 60_000;

function mediaDir(): string {
  const dir = join(config.dataDir, "media");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function mediaPath(slot: MediaSlot): string {
  return join(mediaDir(), `${slot}.mp4`);
}

export function mediaExists(slot: MediaSlot): boolean {
  try {
    return existsSync(mediaPath(slot)) && statSync(mediaPath(slot)).size > 1000;
  } catch {
    return false;
  }
}

export function getMediaTimers(): MediaTimers {
  try {
    const raw = getSetting(K_TIMERS);
    if (!raw) return { ...DEFAULT_TIMERS };
    const j = JSON.parse(raw) as Partial<MediaTimers>;
    return {
      startWaitMs: clampMs(j.startWaitMs, DEFAULT_TIMERS.startWaitMs),
      brbWaitMs: clampMs(j.brbWaitMs, DEFAULT_TIMERS.brbWaitMs),
      endPlayMs: clampMs(j.endPlayMs, DEFAULT_TIMERS.endPlayMs),
    };
  } catch {
    return { ...DEFAULT_TIMERS };
  }
}

function clampMs(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_MS, Math.max(MIN_MS, Math.floor(n)));
}

export function setMediaTimers(partial: Partial<MediaTimers>): MediaTimers {
  const cur = getMediaTimers();
  const next: MediaTimers = {
    startWaitMs: partial.startWaitMs != null ? clampMs(partial.startWaitMs, cur.startWaitMs) : cur.startWaitMs,
    brbWaitMs: partial.brbWaitMs != null ? clampMs(partial.brbWaitMs, cur.brbWaitMs) : cur.brbWaitMs,
    endPlayMs: partial.endPlayMs != null ? clampMs(partial.endPlayMs, cur.endPlayMs) : cur.endPlayMs,
  };
  setSetting(K_TIMERS, JSON.stringify(next));
  return next;
}

export async function saveMediaUpload(slot: MediaSlot, stream: Readable): Promise<{ bytes: number; path: string }> {
  if (slot !== "start" && slot !== "idle" && slot !== "end") {
    throw Object.assign(new Error("slot must be start, idle, or end"), { statusCode: 400 });
  }
  const dest = mediaPath(slot);
  const tmp = `${dest}.part`;
  try {
    if (existsSync(tmp)) unlinkSync(tmp);
  } catch {
  }
  await pipeline(stream, createWriteStream(tmp));
  const st = statSync(tmp);
  if (st.size < 1000) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw Object.assign(new Error("uploaded media too small"), { statusCode: 400 });
  }
  if (st.size > 120 * 1024 * 1024) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw Object.assign(new Error("media must be under 120MB"), { statusCode: 400 });
  }
  try {
    if (existsSync(dest)) unlinkSync(dest);
  } catch {
  }
  const { renameSync } = await import("node:fs");
  renameSync(tmp, dest);
  invalidateFillerCache(dest);

  void import("../relay/ffmpeg.js")
    .then((m) => m.bakeAllFillerCaches(dest))
    .catch((e) => console.warn("[media] filler bake failed:", (e as Error).message));
  return { bytes: st.size, path: dest };
}

export function fillerCachePath(file: string, vertical = false): string {
  return vertical ? `${file}.relay.v.flv` : `${file}.relay.flv`;
}

export function invalidateFillerCache(file: string): void {
  for (const cache of [fillerCachePath(file, false), fillerCachePath(file, true)]) {
    try {
      if (existsSync(cache)) unlinkSync(cache);
    } catch {
    }
  }
}

export function deleteMedia(slot: MediaSlot): void {
  const p = mediaPath(slot);
  invalidateFillerCache(p);
  if (existsSync(p)) unlinkSync(p);
}

export function mediaStatus(): {
  timers: MediaTimers;
  files: Record<MediaSlot, { present: boolean; bytes: number }>;
} {
  const files = {} as Record<MediaSlot, { present: boolean; bytes: number }>;
  for (const slot of ["start", "idle", "end"] as const) {
    const p = mediaPath(slot);
    let bytes = 0;
    try {
      if (existsSync(p)) bytes = statSync(p).size;
    } catch {
      bytes = 0;
    }
    files[slot] = { present: bytes > 1000, bytes };
  }
  return { timers: getMediaTimers(), files };
}
