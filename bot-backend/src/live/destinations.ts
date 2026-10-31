import { decrypt, encrypt } from "../crypto.js";
import { getSetting, getTarget, setSetting, upsertTarget, type StreamTarget } from "../db.js";
import { getPlatformAccess, getPlatformMeta, platformConnected } from "../oauth/platform-tokens.js";
import { youtubeConnected } from "../youtube/tokens.js";
import { assertStreamKey } from "../validate.js";
import { reconcile, resetTargetBackoff } from "../relay/ffmpeg.js";
import { normalizeIngestUrl } from "../validate.js";
import {
  ensureMainEncoderStream,
  ensureVerticalEncoderStream,
  getLiveIngest,
} from "../youtube/live.js";
import { getLiveSession } from "./session.js";

const YT_PLACEHOLDER = "pending-youtube-key";

export function youtubeDestLabel(lane: "main" | "vertical"): string {
  return lane === "vertical" ? "YouTube · Shorts encoder" : "YouTube · main";
}

export function isPendingYoutubeKey(t: StreamTarget | null | undefined): boolean {
  if (!t || t.platform !== "youtube") return false;
  try {
    const k = decrypt(t.stream_key_enc);
    return !k || /pending-youtube/i.test(k);
  } catch {
    return true;
  }
}

function writeYoutubeIngest(
  lane: "main" | "vertical",
  ingest: { rtmpUrl: string; streamKey: string },
  enabledDefault?: number
): string {
  const id = lane === "vertical" ? "youtube-v" : "youtube";
  const existing = getTarget(id);
  upsertTarget({
    id,
    label: existing?.label || youtubeDestLabel(lane),
    platform: "youtube",
    rtmp_url: ingest.rtmpUrl,
    stream_key_enc: encrypt(assertStreamKey(ingest.streamKey)),
    enabled: enabledDefault ?? existing?.enabled ?? 0,
    lane,
  });
  resetTargetBackoff(id);
  return id;
}

export async function bindYoutubeKeyFromBroadcast(
  lane: "main" | "vertical",
  broadcastId: string
): Promise<{ ok: boolean; detail?: string }> {
  try {
    if (lane === "vertical") {
      const ingest = await ensureVerticalEncoderStream();
      writeYoutubeIngest("vertical", ingest);
      return { ok: true, detail: broadcastId ? `https://youtu.be/${broadcastId}` : ingest.streamId };
    }

    try {
      const ingest = await ensureMainEncoderStream();
      writeYoutubeIngest("main", ingest);
      return {
        ok: true,
        detail: broadcastId ? `https://youtu.be/${broadcastId}` : ingest.streamId,
      };
    } catch (e) {
      if (!broadcastId) throw e;
      const ingest = await getLiveIngest(broadcastId);
      writeYoutubeIngest("main", { rtmpUrl: ingest.rtmpUrl, streamKey: ingest.streamKey });
      return { ok: true, detail: ingest.broadcast.watchUrl || broadcastId };
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

export async function refreshPendingYoutubeKeys(): Promise<{
  refreshed: string[];
  failed: string[];
}> {
  const session = getLiveSession();
  const refreshed: string[] = [];
  const failed: string[] = [];

  const pairs: Array<{ lane: "main" | "vertical"; broadcastId: string | null }> = [
    { lane: "main", broadcastId: session.youtubeMainId },
    { lane: "vertical", broadcastId: session.youtubeVerticalId || session.youtubeMainId },
  ];
  for (const { lane, broadcastId } of pairs) {
    const id = lane === "vertical" ? "youtube-v" : "youtube";
    const t = getTarget(id);
    if (!t) continue;
    if (!isPendingYoutubeKey(t)) continue;

    const r = await bindYoutubeKeyFromBroadcast(lane, broadcastId || "");
    if (r.ok) refreshed.push(id);
    else {
      failed.push(id);
      console.warn(`[live] rebind ${id} failed:`, r.detail);
    }
  }
  return { refreshed, failed };
}

function twitchClientId(): string {
  return (
    process.env.TWITCH_CLIENT_ID ||
    getSetting("twitch_oauth_client_id") ||
    getPlatformMeta("twitch").client_id ||
    ""
  );
}

export async function ensureTwitchDestination(streamKey: string): Promise<{ id: string; created: boolean }> {
  const id = "twitch";
  const existing = getTarget(id);
  upsertTarget({
    id,
    label: existing?.label || "Twitch · main",
    platform: "twitch",
    rtmp_url: "rtmp://live.twitch.tv/app",
    stream_key_enc: encrypt(assertStreamKey(streamKey)),
    enabled: existing?.enabled ?? 0,
    lane: "main",
  });
  resetTargetBackoff(id);
  await reconcile();
  return { id, created: !existing };
}

export async function ensureKickDestination(opts: {
  rtmpUrl: string;
  streamKey: string;
}): Promise<{ id: string; created: boolean }> {
  const id = "kick";
  const existing = getTarget(id);
  let rtmpUrl = opts.rtmpUrl;
  try {
    rtmpUrl = normalizeIngestUrl(opts.rtmpUrl, "kick");
  } catch {
  }
  upsertTarget({
    id,
    label: existing?.label || "Kick · main",
    platform: "kick",
    rtmp_url: rtmpUrl,
    stream_key_enc: encrypt(assertStreamKey(opts.streamKey)),
    enabled: existing?.enabled ?? 0,
    lane: "main",
  });
  resetTargetBackoff(id);
  await reconcile();
  return { id, created: !existing };
}

export async function ensureYoutubeDestination(lane: "main" | "vertical" = "main"): Promise<{
  id: string;
  created: boolean;
}> {
  const id = lane === "vertical" ? "youtube-v" : "youtube";
  const existing = getTarget(id);
  if (existing) {

    if (existing.label !== youtubeDestLabel(lane) && /youtube|vertical/i.test(existing.label || "")) {
      upsertTarget({
        id,
        label: youtubeDestLabel(lane),
        platform: existing.platform,
        rtmp_url: existing.rtmp_url,
        stream_key_enc: existing.stream_key_enc,
        enabled: existing.enabled,
        lane: existing.lane === "vertical" ? "vertical" : "main",
      });
    }
    return { id, created: false };
  }
  upsertTarget({
    id,
    label: youtubeDestLabel(lane),
    platform: "youtube",
    rtmp_url: "rtmp://a.rtmp.youtube.com/live2",
    stream_key_enc: encrypt(YT_PLACEHOLDER),
    enabled: 0,
    lane,
  });
  return { id, created: true };
}

async function fetchTwitchStreamKey(): Promise<string> {
  const meta = getPlatformMeta("twitch");
  const access = getPlatformAccess("twitch");
  const clientId = twitchClientId();

  if (meta.stream_key) return meta.stream_key;
  if (!access?.token || !meta.user_id) return "";
  if (!clientId) return "";
  const keyRes = await fetch(
    `https://api.twitch.tv/helix/streams/key?broadcaster_id=${encodeURIComponent(meta.user_id)}`,
    {
      headers: {
        Authorization: `Bearer ${access.token}`,
        "Client-Id": clientId,
      },
    }
  );
  if (!keyRes.ok) {
    const t = await keyRes.text();
    throw new Error(`Twitch key ${keyRes.status}: ${t.slice(0, 120)}`);
  }
  const keyJson = (await keyRes.json()) as { data?: Array<{ stream_key?: string }> };
  return keyJson.data?.[0]?.stream_key || "";
}

export async function autoAddConnectedDestinations(): Promise<{
  added: string[];
  skipped: string[];
  errors: Record<string, string>;
}> {
  const added: string[] = [];
  const skipped: string[] = [];
  const errors: Record<string, string> = {};

  if (youtubeConnected()) {
    for (const lane of ["main", "vertical"] as const) {
      const r = await ensureYoutubeDestination(lane);
      if (r.created) added.push(r.id);
      else skipped.push(r.id);
    }
  } else {
    skipped.push("youtube", "youtube-v");
  }

  if (platformConnected("twitch")) {
    try {
      const streamKey = await fetchTwitchStreamKey();
      if (streamKey) {
        const r = await ensureTwitchDestination(streamKey);
        if (r.created) added.push("twitch");
        else {

          await ensureTwitchDestination(streamKey);
          skipped.push("twitch");
        }
      } else if (getTarget("twitch")) skipped.push("twitch");
      else {
        errors.twitch = twitchClientId()
          ? "Twitch stream key empty — reconnect Twitch on Omnix Link"
          : "Twitch Client ID missing on egg — reconnect Twitch on Omnix Link (sends key)";
      }
    } catch (e) {
      errors.twitch = (e as Error).message;
    }
  } else skipped.push("twitch");

  if (platformConnected("kick")) {
    try {
      const access = getPlatformAccess("kick");
      const meta = getPlatformMeta("kick");
      if (!access?.token) {
        errors.kick = "Kick not connected";
      } else {
        let sk =
          meta.stream_key && meta.rtmp_url
            ? { streamKey: meta.stream_key, rtmpUrl: meta.rtmp_url }
            : meta.stream_key
              ? {
                  streamKey: meta.stream_key,
                  rtmpUrl: meta.rtmp_url || "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app",
                }
              : await fetchKickStreamKey(access.token);
        if (sk) {
          const existed = Boolean(getTarget("kick"));
          await ensureKickDestination(sk);
          if (existed) skipped.push("kick");
          else added.push("kick");
        } else if (getTarget("kick")) skipped.push("kick");
        else {
          errors.kick =
            "Kick stream key unavailable — enable streamkey:read, reconnect Kick on Omnix Link, or paste URL+key once";
        }
      }
    } catch (e) {
      errors.kick = (e as Error).message;
    }
  } else skipped.push("kick");

  return { added: [...new Set(added)], skipped: [...new Set(skipped)], errors };
}

export async function fetchKickStreamKey(
  accessToken: string
): Promise<{ rtmpUrl: string; streamKey: string } | null> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

  try {
    const res = await fetch("https://api.kick.com/public/v1/channels", { headers });
    if (res.ok) {
      const body = (await res.json()) as {
        data?: Array<{ stream?: { key?: string; url?: string; stream_key?: string; rtmp_url?: string } }>;
      };
      const stream = body.data?.[0]?.stream || {};
      const streamKey = stream.key || stream.stream_key || "";
      let rtmpUrl = stream.url || stream.rtmp_url || "";
      if (streamKey) {
        if (rtmpUrl) {
          try {
            rtmpUrl = normalizeIngestUrl(rtmpUrl, "kick");
          } catch {
          }
        }
        return {
          rtmpUrl: rtmpUrl || "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app",
          streamKey,
        };
      }
    }
  } catch {
  }

  for (const url of [
    "https://api.kick.com/public/v1/stream-key",
    "https://api.kick.com/public/v1/streamkey",
  ]) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        data?:
          | { url?: string; key?: string; stream_key?: string; rtmp_url?: string }
          | Array<{ url?: string; key?: string; stream_key?: string; rtmp_url?: string }>;
      };
      const row = Array.isArray(body.data) ? body.data[0] : body.data;
      if (!row) continue;
      const streamKey = row.stream_key || row.key || "";
      let rtmpUrl = row.rtmp_url || row.url || "";
      if (!streamKey) continue;
      if (rtmpUrl) {
        try {
          rtmpUrl = normalizeIngestUrl(rtmpUrl, "kick");
        } catch {
        }
      }
      return {
        rtmpUrl: rtmpUrl || "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app",
        streamKey,
      };
    } catch {
    }
  }
  return null;
}

export function rememberPlatformHandoff(
  platform: "twitch" | "kick",
  extra: Record<string, string>
): void {
  if (platform === "twitch" && extra.client_id) {
    setSetting("twitch_oauth_client_id", extra.client_id);
  }
}
