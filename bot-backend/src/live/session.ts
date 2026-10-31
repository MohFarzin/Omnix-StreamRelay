import { getSetting, setSetting } from "../db.js";

const K_STATUS = "live.session.status";
const K_YT_MAIN = "live.session.yt_main";
const K_YT_VERT = "live.session.yt_vertical";
const K_WATCH_MAIN = "live.session.watch_main";
const K_WATCH_VERT = "live.session.watch_vertical";
const K_PRESET = "live.session.preset_id";

export type SessionStatus = "idle" | "prepared" | "live";

export type LiveSession = {
  status: SessionStatus;
  youtubeMainId: string | null;
  youtubeVerticalId: string | null;
  watchMain: string | null;
  watchVertical: string | null;
  presetId: string | null;
};

export function getLiveSession(): LiveSession {
  const statusRaw = getSetting(K_STATUS) || "idle";
  const status: SessionStatus =
    statusRaw === "prepared" || statusRaw === "live" ? statusRaw : "idle";
  return {
    status,
    youtubeMainId: getSetting(K_YT_MAIN) || null,
    youtubeVerticalId: getSetting(K_YT_VERT) || null,
    watchMain: getSetting(K_WATCH_MAIN) || null,
    watchVertical: getSetting(K_WATCH_VERT) || null,
    presetId: getSetting(K_PRESET) || null,
  };
}

export function isSessionLive(): boolean {

  return getLiveSession().status === "live";
}

export function setSessionStatus(status: SessionStatus): void {
  setSetting(K_STATUS, status);
}

export function saveSessionYouTube(opts: {
  mainId?: string;
  verticalId?: string;
  watchMain?: string;
  watchVertical?: string;
  presetId?: string;
  status?: SessionStatus;
}): void {
  if (opts.mainId != null) setSetting(K_YT_MAIN, opts.mainId);
  if (opts.verticalId != null) setSetting(K_YT_VERT, opts.verticalId);
  if (opts.watchMain != null) setSetting(K_WATCH_MAIN, opts.watchMain);
  if (opts.watchVertical != null) setSetting(K_WATCH_VERT, opts.watchVertical);
  if (opts.presetId != null) setSetting(K_PRESET, opts.presetId);
  if (opts.status) setSetting(K_STATUS, opts.status);
}

export function clearLiveSession(): void {
  setSetting(K_STATUS, "idle");
  setSetting(K_YT_MAIN, "");
  setSetting(K_YT_VERT, "");
  setSetting(K_WATCH_MAIN, "");
  setSetting(K_WATCH_VERT, "");
  setSetting(K_PRESET, "");
}
