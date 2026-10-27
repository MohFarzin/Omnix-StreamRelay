const ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const CMD_RE = /^[a-zA-Z0-9_]{1,24}$/;
const RTMP_RE = /^rtmps?:\/\/[^\s]{1,500}$/i;

export function assertTargetId(id: string): string {
  const v = id.trim();
  if (!ID_RE.test(v)) throw Object.assign(new Error("invalid target id"), { statusCode: 400 });
  return v;
}

export function assertLane(raw: unknown): "main" | "vertical" {
  const v = String(raw ?? "main").toLowerCase();
  if (v === "vertical" || v === "vert" || v === "9:16" || v === "916") return "vertical";
  return "main";
}

export function assertCommandName(name: string): string {
  const v = name.trim().toLowerCase().replace(/^!/, "");
  if (!CMD_RE.test(v)) throw Object.assign(new Error("invalid command name"), { statusCode: 400 });
  return v;
}

export function assertRtmpUrl(url: string): string {
  const v = url.trim();
  if (!RTMP_RE.test(v)) {
    throw Object.assign(new Error("rtmpUrl must start with rtmp:// or rtmps://"), { statusCode: 400 });
  }
  return v.replace(/\/$/, "");
}

export function assertStreamKey(key: string): string {
  const v = key.trim();
  if (v.length < 4 || v.length > 256) {
    throw Object.assign(new Error("streamKey length invalid"), { statusCode: 400 });
  }
  if (/[\r\n\0]/.test(v)) {
    throw Object.assign(new Error("streamKey has invalid characters"), { statusCode: 400 });
  }
  return v;
}

export function assertShortText(text: string, max = 500): string {
  const v = text.trim();
  if (!v || v.length > max) {
    throw Object.assign(new Error(`text must be 1–${max} chars`), { statusCode: 400 });
  }
  return v;
}

/** Normalize Kick / Twitch / YT server URLs so FFmpeg gets a valid app path. */
export function normalizeIngestUrl(url: string, platform: string): string {
  let u = assertRtmpUrl(url);
  const p = platform.toLowerCase();
  if (p === "kick" || /live-video\.net/i.test(u)) {
    if (u.startsWith("rtmp://")) u = u.replace(/^rtmp:\/\//i, "rtmps://");
    // Kick/IVS: explicit 443 avoids flaky default-port RTMPS in some FFmpeg builds
    u = u.replace(/^(rtmps:\/\/[^/:]+)(?::\d+)?/i, "$1:443");
    if (!/\/app$/i.test(u) && !/\/app\//i.test(u)) u = `${u}/app`;
    // strip accidental key glued onto server URL (user pasted full path)
    u = u.replace(/\/app\/.+$/i, "/app");
  }
  return u;
}
