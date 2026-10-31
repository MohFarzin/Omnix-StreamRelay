import { decrypt, encrypt } from "../crypto.js";
import { getSetting, setSetting } from "../db.js";
import { getValidAccessToken } from "./oauth.js";
import { setLiveChatId } from "./tokens.js";

const K_MAIN_ENCODER_STREAM = "youtube.main_encoder_stream_id";
const K_VERT_ENCODER_STREAM = "youtube.vertical_encoder_stream_id";
const K_MAIN_ENCODER_KEY = "youtube.main_encoder_stream_key_enc";
const K_VERT_ENCODER_KEY = "youtube.vertical_encoder_stream_key_enc";
const K_MAIN_ENCODER_RTMP = "youtube.main_encoder_rtmp";
const K_VERT_ENCODER_RTMP = "youtube.vertical_encoder_rtmp";

function streamStamp(): string {

  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type LatencyPreference = "normal" | "low" | "ultraLow";

export type CreateLiveInput = {
  title: string;
  description?: string;
  privacy?: "public" | "unlisted" | "private";
  lane?: "main" | "vertical";

  thumbnailBase64?: string;
  thumbnailMime?: string;
  scheduledStartIso?: string;

  latency?: LatencyPreference;

  categoryId?: string;

  gameTitle?: string;
};

export type CreateLiveResult = {
  broadcastId: string;
  streamId: string;
  streamKey: string;
  ingestionAddress: string;
  rtmpUrl: string;
  watchUrl: string;
  liveChatId: string | null;
  lane: "main" | "vertical";
  title: string;
  privacy: string;
  latency: LatencyPreference;
  categoryId: string | null;
  gameTitle: string | null;
  thumbnailError?: string | null;
};

export type StreamIngest = {
  streamId: string;
  streamKey: string;
  rtmpUrl: string;
  ingestionAddress: string;
};

export type DualEncoderLiveResult = {
  broadcastId: string;
  watchUrl: string;
  studioUrl: string;
  liveChatId: string | null;
  title: string;
  privacy: string;
  latency: LatencyPreference;
  categoryId: string | null;
  gameTitle: string | null;
  thumbnailError?: string | null;
  main: StreamIngest;
  vertical: StreamIngest;
};

export type ManagedLive = {
  broadcastId: string;
  title: string;
  description: string;
  privacy: string;
  lifeCycleStatus: string;
  privacyStatus: string;
  scheduledStartTime: string | null;
  watchUrl: string;
  liveChatId: string | null;
  boundStreamId: string | null;
  thumbnailUrl: string | null;
};

async function ytFetch(
  path: string,
  init: RequestInit & { accessToken: string },
  opts?: { retried?: boolean }
): Promise<unknown> {
  const { accessToken, ...rest } = init;
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(rest.headers || {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const errObj = json as { error?: { message?: string; errors?: { reason?: string }[] } };
    let msg = errObj?.error?.message || `YouTube API ${res.status}: ${text.slice(0, 240)}`;
    msg = String(msg)
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const reason = errObj?.error?.errors?.[0]?.reason || "";
    if (/quota/i.test(msg) || reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      msg =
        "YouTube API quota exceeded for today. Do not Create more lives — reuse the existing Control Room stream, or wait until quota resets (usually midnight Pacific).";
    }

    if (
      !opts?.retried &&
      (res.status === 401 || /invalid authentication credentials|unauthorized|login required/i.test(msg))
    ) {
      try {
        const fresh = await getValidAccessToken(true);
        return ytFetch(path, { ...init, accessToken: fresh }, { retried: true });
      } catch (e) {
        throw Object.assign(
          new Error(
            String((e as Error).message || "").includes("Omnix Link")
              ? (e as Error).message
              : "YouTube login expired — open Omnix Link → Disconnect YouTube → Connect YouTube again, then retry Create"
          ),
          { statusCode: 401 }
        );
      }
    }
    throw Object.assign(new Error(msg), {
      statusCode: res.status === 401 ? 401 : res.status === 403 ? 403 : 400,
    });
  }
  return json;
}

function splitIngest(ingestionAddress: string, streamName: string): { rtmpUrl: string; streamKey: string } {
  const base = ingestionAddress.replace(/\/$/, "");

  if (/\/live2$/i.test(base) || /youtube\.com/i.test(base)) {
    return { rtmpUrl: base, streamKey: streamName };
  }
  return { rtmpUrl: "rtmp://a.rtmp.youtube.com/live2", streamKey: streamName };
}

function normalizeLatency(raw: string | undefined): LatencyPreference {
  if (raw === "low" || raw === "ultraLow") return raw;
  return "normal";
}

function mapBroadcast(item: {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    scheduledStartTime?: string;
    liveChatId?: string;
    thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
  };
  status?: { lifeCycleStatus?: string; privacyStatus?: string };
  contentDetails?: { boundStreamId?: string };
}): ManagedLive | null {
  if (!item.id) return null;
  return {
    broadcastId: item.id,
    title: item.snippet?.title || "(untitled)",
    description: item.snippet?.description || "",
    privacy: item.status?.privacyStatus || "unlisted",
    lifeCycleStatus: item.status?.lifeCycleStatus || "unknown",
    privacyStatus: item.status?.privacyStatus || "unlisted",
    scheduledStartTime: item.snippet?.scheduledStartTime || null,
    watchUrl: `https://youtu.be/${item.id}`,
    liveChatId: item.snippet?.liveChatId || null,
    boundStreamId: item.contentDetails?.boundStreamId || null,
    thumbnailUrl:
      item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
  };
}

export async function listManagedLives(): Promise<ManagedLive[]> {
  const accessToken = await getValidAccessToken();
  const out: ManagedLive[] = [];
  const seen = new Set<string>();

  for (const status of ["active", "upcoming"] as const) {
    const json = (await ytFetch(
      `liveBroadcasts?part=snippet,status,contentDetails&maxResults=10&broadcastStatus=${status}`,
      { method: "GET", accessToken }
    )) as { items?: Parameters<typeof mapBroadcast>[0][] };
    for (const item of json.items || []) {
      const mapped = mapBroadcast(item);
      if (!mapped || seen.has(mapped.broadcastId)) continue;

      if (/complete|revoked|abandoned/i.test(mapped.lifeCycleStatus)) continue;
      seen.add(mapped.broadcastId);
      out.push(mapped);
    }
  }

  const filtered = out.filter((m) =>
    /^(active|live|liveStarting|testStarting|testing|ready)$/i.test(m.lifeCycleStatus)
  );
  const list = filtered.length ? filtered : out;
  list.sort((a, b) => {
    const ta = Date.parse(a.scheduledStartTime || "") || 0;
    const tb = Date.parse(b.scheduledStartTime || "") || 0;
    return tb - ta;
  });
  return list.slice(0, 4);
}

export async function getLiveIngest(broadcastId: string): Promise<{
  broadcast: ManagedLive;
  streamId: string;
  streamKey: string;
  rtmpUrl: string;
  ingestionAddress: string;
}> {
  const accessToken = await getValidAccessToken();
  const id = String(broadcastId || "").trim();
  if (!id) {
    throw Object.assign(new Error("broadcastId required"), { statusCode: 400 });
  }
  const json = (await ytFetch(
    `liveBroadcasts?part=snippet,status,contentDetails&id=${encodeURIComponent(id)}`,
    { method: "GET", accessToken }
  )) as { items?: Parameters<typeof mapBroadcast>[0][] };
  const item = json.items?.[0];
  const broadcast = item ? mapBroadcast(item) : null;
  if (!broadcast) {
    throw Object.assign(new Error("broadcast not found"), { statusCode: 404 });
  }
  const streamId = broadcast.boundStreamId;
  if (!streamId) {
    throw Object.assign(new Error("This live has no bound stream yet — create a new live instead"), {
      statusCode: 400,
    });
  }
  const streams = (await ytFetch(
    `liveStreams?part=snippet,cdn,status&id=${encodeURIComponent(streamId)}`,
    { method: "GET", accessToken }
  )) as {
    items?: {
      id?: string;
      cdn?: { ingestionInfo?: { streamName?: string; ingestionAddress?: string } };
    }[];
  };
  const stream = streams.items?.[0];
  const streamName = stream?.cdn?.ingestionInfo?.streamName || "";
  const ingestionAddress = stream?.cdn?.ingestionInfo?.ingestionAddress || "rtmp://a.rtmp.youtube.com/live2";
  if (!streamName) {
    throw Object.assign(new Error("YouTube did not return a stream key for this live"), { statusCode: 502 });
  }
  const { rtmpUrl, streamKey } = splitIngest(ingestionAddress, streamName);
  if (broadcast.liveChatId) setLiveChatId(broadcast.liveChatId);
  return { broadcast, streamId, streamKey, rtmpUrl, ingestionAddress };
}

function ingestFromStreamItem(stream: {
  id?: string;
  cdn?: { ingestionInfo?: { streamName?: string; ingestionAddress?: string } };
}): StreamIngest | null {
  const streamId = String(stream.id || "").trim();
  const streamName = stream.cdn?.ingestionInfo?.streamName || "";
  const ingestionAddress = stream.cdn?.ingestionInfo?.ingestionAddress || "rtmp://a.rtmp.youtube.com/live2";
  if (!streamId || !streamName) return null;
  const { rtmpUrl, streamKey } = splitIngest(ingestionAddress, streamName);
  return { streamId, streamKey, rtmpUrl, ingestionAddress };
}

export async function getStreamIngest(streamId: string): Promise<StreamIngest> {
  const accessToken = await getValidAccessToken();
  const id = String(streamId || "").trim();
  if (!id) {
    throw Object.assign(new Error("streamId required"), { statusCode: 400 });
  }
  const streams = (await ytFetch(
    `liveStreams?part=snippet,cdn,status&id=${encodeURIComponent(id)}`,
    { method: "GET", accessToken }
  )) as {
    items?: {
      id?: string;
      cdn?: { ingestionInfo?: { streamName?: string; ingestionAddress?: string } };
    }[];
  };
  const ingest = streams.items?.[0] ? ingestFromStreamItem(streams.items[0]) : null;
  if (!ingest) {
    throw Object.assign(new Error("YouTube stream not found or has no key"), { statusCode: 404 });
  }
  return ingest;
}

type ReusableKind = "main" | "vertical";

function reusableStreamSetting(kind: ReusableKind): string {
  return kind === "vertical" ? K_VERT_ENCODER_STREAM : K_MAIN_ENCODER_STREAM;
}

function reusableKeySetting(kind: ReusableKind): string {
  return kind === "vertical" ? K_VERT_ENCODER_KEY : K_MAIN_ENCODER_KEY;
}

function reusableRtmpSetting(kind: ReusableKind): string {
  return kind === "vertical" ? K_VERT_ENCODER_RTMP : K_MAIN_ENCODER_RTMP;
}

function cacheReusableIngest(kind: ReusableKind, ingest: StreamIngest): void {
  setSetting(reusableStreamSetting(kind), ingest.streamId);
  setSetting(reusableKeySetting(kind), encrypt(ingest.streamKey));
  setSetting(reusableRtmpSetting(kind), ingest.rtmpUrl || "rtmp://a.rtmp.youtube.com/live2");
}

function loadCachedReusableIngest(kind: ReusableKind): StreamIngest | null {
  const streamId = String(getSetting(reusableStreamSetting(kind)) || "").trim();
  const keyEnc = String(getSetting(reusableKeySetting(kind)) || "").trim();
  const rtmp = String(getSetting(reusableRtmpSetting(kind)) || "").trim() || "rtmp://a.rtmp.youtube.com/live2";
  if (!streamId || !keyEnc) return null;
  try {
    const streamKey = decrypt(keyEnc);
    if (!streamKey || /pending-youtube/i.test(streamKey)) return null;
    return {
      streamId,
      streamKey,
      rtmpUrl: rtmp,
      ingestionAddress: rtmp,
    };
  } catch {
    return null;
  }
}

function reusableStreamTitle(kind: ReusableKind, stamp: string): string {

  return kind === "vertical"
    ? `Omnix vertical encoder · ${stamp}`.slice(0, 100)
    : `Omnix main · ${stamp}`.slice(0, 100);
}

async function renameLiveStream(
  accessToken: string,
  streamId: string,
  title: string
): Promise<void> {
  const full = (await ytFetch(
    `liveStreams?part=snippet,cdn,contentDetails,status&id=${encodeURIComponent(streamId)}`,
    { method: "GET", accessToken }
  )) as {
    items?: {
      id?: string;
      snippet?: Record<string, unknown>;
      cdn?: Record<string, unknown>;
      contentDetails?: Record<string, unknown>;
      status?: Record<string, unknown>;
    }[];
  };
  const item = full.items?.[0];
  if (!item?.id || !item.cdn) return;
  const cdn = { ...item.cdn };

  if (!cdn.ingestionType) cdn.ingestionType = "rtmp";
  if (!cdn.frameRate) cdn.frameRate = "variable";
  if (!cdn.resolution) cdn.resolution = "variable";
  await ytFetch("liveStreams?part=snippet,cdn,contentDetails,status", {
    method: "PUT",
    accessToken,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: item.id,
      snippet: { ...(item.snippet || {}), title },
      cdn,
      contentDetails: item.contentDetails,
      status: item.status,
    }),
  });
}

async function ensureReusableStream(kind: ReusableKind): Promise<StreamIngest> {
  const accessToken = await getValidAccessToken();
  const settingKey = reusableStreamSetting(kind);
  const stamp = streamStamp();
  const title = reusableStreamTitle(kind, stamp);
  const saved = String(getSetting(settingKey) || "").trim();
  if (saved) {
    try {
      const ingest = await getStreamIngest(saved);
      cacheReusableIngest(kind, ingest);
      try {
        await renameLiveStream(accessToken, ingest.streamId, title);
      } catch (e) {
        console.warn(`[youtube] rename ${kind} stream failed:`, (e as Error).message);
      }
      console.log(`[youtube] reuse ${kind} stream id=${ingest.streamId} title="${title}"`);
      return ingest;
    } catch (e) {
      const cached = loadCachedReusableIngest(kind);
      if (cached) {
        console.warn(
          `[youtube] reuse ${kind} from local cache (API: ${(e as Error).message.slice(0, 120)})`
        );
        return cached;
      }
      const msg = String((e as Error).message || "");
      if (/quota/i.test(msg)) {
        throw Object.assign(
          new Error(
            "YouTube API quota exceeded — stream key is cached after the next successful Create; paste key via Edit, or wait until quota resets"
          ),
          { statusCode: 429 }
        );
      }
      console.warn(`[youtube] saved ${kind} stream missing — creating once`);
    }
  } else {
    const cached = loadCachedReusableIngest(kind);
    if (cached) return cached;
  }
  const stream = (await ytFetch("liveStreams?part=snippet,cdn,contentDetails,status", {
    method: "POST",
    accessToken,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: { title },
      cdn: {
        frameRate: "variable",
        ingestionType: "rtmp",
        resolution: "variable",
      },
      contentDetails: { isReusable: true },
    }),
  })) as {
    id: string;
    cdn?: { ingestionInfo?: { streamName?: string; ingestionAddress?: string } };
  };
  const ingest = ingestFromStreamItem(stream);
  if (!ingest) {
    throw Object.assign(new Error(`YouTube did not return a ${kind} stream key`), {
      statusCode: 502,
    });
  }
  cacheReusableIngest(kind, ingest);
  console.log(`[youtube] created reusable ${kind} stream id=${ingest.streamId} title="${title}"`);
  return ingest;
}

export async function ensureVerticalEncoderStream(): Promise<StreamIngest> {
  return ensureReusableStream("vertical");
}

export async function ensureMainEncoderStream(): Promise<StreamIngest> {
  return ensureReusableStream("main");
}

export function youtubeStudioLiveUrl(broadcastId: string): string {
  return `https://studio.youtube.com/video/${encodeURIComponent(broadcastId)}/livestreaming`;
}

export async function createDualEncoderLive(input: CreateLiveInput): Promise<DualEncoderLiveResult> {
  const accessToken = await getValidAccessToken();
  const title = String(input.title || "").trim().slice(0, 100);
  if (title.length < 1) {
    throw Object.assign(new Error("title required"), { statusCode: 400 });
  }
  const privacy = input.privacy === "public" || input.privacy === "private" ? input.privacy : "unlisted";
  const description = String(input.description || "").slice(0, 5000);
  const startIso = input.scheduledStartIso || new Date(Date.now() - 15_000).toISOString();
  const latency = normalizeLatency(input.latency);
  const categoryId = input.categoryId ? String(input.categoryId).slice(0, 12) : "";
  const gameTitle = String(input.gameTitle || "").trim().slice(0, 80);

  const main = await ensureMainEncoderStream();
  let vertical: StreamIngest;
  try {
    vertical = await ensureVerticalEncoderStream();
  } catch (ve) {

    console.warn(`[youtube] vertical Encoder before broadcast failed:`, (ve as Error).message);
    vertical = {
      streamId: "",
      streamKey: "pending-youtube-key",
      rtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
      ingestionAddress: "rtmp://a.rtmp.youtube.com/live2",
    };
  }

  const broadcast = (await ytFetch("liveBroadcasts?part=snippet,status,contentDetails", {
    method: "POST",
    accessToken,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: {
        title,
        description,
        scheduledStartTime: startIso,
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: false,
        latencyPreference: latency,
        monitorStream: { enableMonitorStream: false },
      },
    }),
  })) as {
    id: string;
    snippet?: { liveChatId?: string };
  };

  await ytFetch(
    `liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(main.streamId)}&part=id,contentDetails,snippet`,
    {
      method: "POST",
      accessToken,
    }
  );

  if (categoryId || gameTitle) {
    try {
      await applyVideoMeta(accessToken, broadcast.id, {
        title,
        description:
          gameTitle && !description.includes(gameTitle)
            ? `${description}\n\nGame: ${gameTitle}`.trim()
            : description,
        categoryId: categoryId || "20",
        gameTitle: gameTitle || undefined,
        privacy,
      });
    } catch {
    }
  }

  let thumbnailError: string | null = null;
  if (input.thumbnailBase64) {
    const delays = [800, 2500, 5000];
    for (let i = 0; i < delays.length; i++) {
      try {
        await new Promise((r) => setTimeout(r, delays[i]));
        await uploadThumbnail(
          accessToken,
          broadcast.id,
          input.thumbnailBase64,
          input.thumbnailMime || "image/jpeg"
        );
        thumbnailError = null;
        break;
      } catch (e) {
        thumbnailError = (e as Error).message;
        if (i === delays.length - 1) console.warn("[youtube] thumbnail failed:", thumbnailError);
      }
    }
  }

  const liveChatId = broadcast.snippet?.liveChatId || null;
  if (liveChatId) setLiveChatId(liveChatId);

  return {
    broadcastId: broadcast.id,
    watchUrl: `https://youtu.be/${broadcast.id}`,
    studioUrl: youtubeStudioLiveUrl(broadcast.id),
    liveChatId,
    title,
    privacy,
    latency,
    categoryId: categoryId || null,
    gameTitle: gameTitle || null,
    thumbnailError,
    main,
    vertical,
  };
}

export async function listVideoCategories(regionCode = "US"): Promise<{ id: string; title: string }[]> {
  const accessToken = await getValidAccessToken();
  const region = String(regionCode || "US")
    .trim()
    .slice(0, 2)
    .toUpperCase() || "US";
  const json = (await ytFetch(
    `videoCategories?part=snippet&regionCode=${encodeURIComponent(region)}`,
    { method: "GET", accessToken }
  )) as {
    items?: { id?: string; snippet?: { title?: string; assignable?: boolean } }[];
  };
  return (json.items || [])
    .filter((c) => c.id && c.snippet?.assignable !== false)
    .map((c) => ({ id: String(c.id), title: String(c.snippet?.title || c.id) }));
}

async function applyVideoMeta(
  accessToken: string,
  videoId: string,
  opts: { title: string; description: string; categoryId?: string; gameTitle?: string; privacy: string }
): Promise<void> {
  const categoryId = opts.categoryId ? String(opts.categoryId).slice(0, 12) : "";
  const game = String(opts.gameTitle || "").trim().slice(0, 80);
  const tags = game ? [game, "live", "Omnix"] : ["live", "Omnix"];
  const body: Record<string, unknown> = {
    id: videoId,
    snippet: {
      title: opts.title,
      description: opts.description,
      tags,
      ...(categoryId ? { categoryId } : {}),
    },
    status: {
      privacyStatus: opts.privacy,
      selfDeclaredMadeForKids: false,
    },
  };

  if (!categoryId) {

    await ytFetch("videos?part=snippet,status", {
      method: "PUT",
      accessToken,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return;
  }
  await ytFetch("videos?part=snippet,status", {
    method: "PUT",
    accessToken,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function createAndBindLive(input: CreateLiveInput): Promise<CreateLiveResult> {
  const accessToken = await getValidAccessToken();
  const title = String(input.title || "").trim().slice(0, 100);
  if (title.length < 1) {
    throw Object.assign(new Error("title required"), { statusCode: 400 });
  }
  const privacy = input.privacy === "public" || input.privacy === "private" ? input.privacy : "unlisted";
  const lane = input.lane === "vertical" ? "vertical" : "main";
  const description = String(input.description || "").slice(0, 5000);

  const startIso = input.scheduledStartIso || new Date(Date.now() - 15_000).toISOString();
  const latency = normalizeLatency(input.latency);
  const categoryId = input.categoryId ? String(input.categoryId).slice(0, 12) : "";
  const gameTitle = String(input.gameTitle || "").trim().slice(0, 80);

  const broadcast = (await ytFetch("liveBroadcasts?part=snippet,status,contentDetails", {
    method: "POST",
    accessToken,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: {
        title,
        description,
        scheduledStartTime: startIso,
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
      contentDetails: {

        enableAutoStart: true,
        enableAutoStop: false,
        latencyPreference: latency,
        monitorStream: { enableMonitorStream: false },
      },
    }),
  })) as {
    id: string;
    snippet?: { liveChatId?: string };
  };

  const bound =
    lane === "vertical" ? await ensureVerticalEncoderStream() : await ensureMainEncoderStream();

  await ytFetch(
    `liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(bound.streamId)}&part=id,contentDetails,snippet`,
    {
      method: "POST",
      accessToken,
    }
  );

  if (categoryId || gameTitle) {
    try {

      await applyVideoMeta(accessToken, broadcast.id, {
        title,
        description: gameTitle && !description.includes(gameTitle) ? `${description}\n\nGame: ${gameTitle}`.trim() : description,
        categoryId: categoryId || "20",
        gameTitle: gameTitle || undefined,
        privacy,
      });
    } catch {
    }
  }

  let thumbnailError: string | null = null;
  if (input.thumbnailBase64) {
    const delays = [800, 2500, 5000];
    for (let i = 0; i < delays.length; i++) {
      try {
        await new Promise((r) => setTimeout(r, delays[i]));
        await uploadThumbnail(
          accessToken,
          broadcast.id,
          input.thumbnailBase64,
          input.thumbnailMime || "image/jpeg"
        );
        thumbnailError = null;
        break;
      } catch (e) {
        thumbnailError = (e as Error).message;
        if (i === delays.length - 1) console.warn("[youtube] thumbnail failed:", thumbnailError);
      }
    }
  }

  const liveChatId = broadcast.snippet?.liveChatId || null;
  if (liveChatId) setLiveChatId(liveChatId);

  return {
    broadcastId: broadcast.id,
    streamId: bound.streamId,
    streamKey: bound.streamKey,
    ingestionAddress: bound.ingestionAddress,
    rtmpUrl: bound.rtmpUrl,
    watchUrl: `https://youtu.be/${broadcast.id}`,
    liveChatId,
    lane,
    title,
    privacy,
    latency,
    categoryId: categoryId || null,
    gameTitle: gameTitle || null,
    thumbnailError,
  };
}

async function uploadThumbnail(
  accessToken: string,
  videoId: string,
  base64: string,
  mime: string
): Promise<void> {
  const dataMatch = /^data:([^;]+);base64,(.*)$/s.exec(base64);
  const cleaned = (dataMatch ? dataMatch[2] : base64.replace(/^data:[^;]+;base64,/, "")).replace(/\s/g, "");
  let contentType = (dataMatch?.[1] || mime || "image/jpeg").split(";")[0].trim().toLowerCase() || "image/jpeg";

  if (contentType === "image/jpg") contentType = "image/jpeg";
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    throw new Error("thumbnail must be JPEG or PNG (WebP is not accepted by YouTube)");
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length < 100 || buf.length > 2_000_000) {
    throw new Error(`thumbnail size out of range (${buf.length} bytes)`);
  }
  const res = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": contentType,
        "Content-Length": String(buf.length),
      },
      body: buf,
    }
  );
  if (!res.ok) {
    const t = await res.text();
    const plain = t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (/quota/i.test(plain)) {
      throw new Error("thumbnail failed: YouTube API quota exceeded");
    }
    if (/verified|permission|forbidden|authorized/i.test(plain)) {
      throw new Error(
        "thumbnail failed: channel may need phone verification for custom thumbnails (YouTube Studio → Customization)"
      );
    }
    throw new Error(`thumbnail ${res.status}: ${plain.slice(0, 160)}`);
  }
}

export async function transitionLive(broadcastId: string, status: "testing" | "live" | "complete"): Promise<void> {
  const accessToken = await getValidAccessToken();
  await ytFetch(
    `liveBroadcasts/transition?broadcastStatus=${status}&id=${encodeURIComponent(broadcastId)}&part=status`,
    { method: "POST", accessToken }
  );
}

export async function getBroadcastHealth(broadcastId: string): Promise<{
  lifeCycleStatus: string;
  streamStatus: string | null;
  boundStreamId: string | null;
}> {
  const accessToken = await getValidAccessToken();
  const id = String(broadcastId || "").trim();
  const json = (await ytFetch(
    `liveBroadcasts?part=snippet,status,contentDetails&id=${encodeURIComponent(id)}`,
    { method: "GET", accessToken }
  )) as {
    items?: {
      status?: { lifeCycleStatus?: string };
      contentDetails?: { boundStreamId?: string };
    }[];
  };
  const item = json.items?.[0];
  const lifeCycleStatus = String(item?.status?.lifeCycleStatus || "unknown");
  const boundStreamId = item?.contentDetails?.boundStreamId || null;
  let streamStatus: string | null = null;
  if (boundStreamId) {
    const streams = (await ytFetch(
      `liveStreams?part=status&id=${encodeURIComponent(boundStreamId)}`,
      { method: "GET", accessToken }
    )) as { items?: { status?: { streamStatus?: string } }[] };
    streamStatus = streams.items?.[0]?.status?.streamStatus || null;
  }
  return { lifeCycleStatus, streamStatus, boundStreamId };
}

export async function tryGoLive(broadcastId: string): Promise<{ ok: boolean; detail: string }> {
  const accessToken = await getValidAccessToken();
  const id = String(broadcastId || "").trim();
  if (!id) return { ok: false, detail: "no broadcast id" };

  const health = await getBroadcastHealth(id);
  if (/live/i.test(health.lifeCycleStatus)) {
    return { ok: true, detail: `already ${health.lifeCycleStatus}` };
  }
  if (/complete|revoked|testStarting/i.test(health.lifeCycleStatus)) {
    return { ok: false, detail: `cannot go live from ${health.lifeCycleStatus}` };
  }

  try {
    const full = (await ytFetch(
      `liveBroadcasts?part=snippet,status,contentDetails&id=${encodeURIComponent(id)}`,
      { method: "GET", accessToken }
    )) as {
      items?: {
        id?: string;
        snippet?: Record<string, unknown>;
        status?: Record<string, unknown>;
        contentDetails?: Record<string, unknown>;
      }[];
    };
    const item = full.items?.[0];
    if (item?.snippet) {
      const snippet = { ...item.snippet, scheduledStartTime: new Date(Date.now() - 30_000).toISOString() };
      await ytFetch("liveBroadcasts?part=snippet,status,contentDetails", {
        method: "PUT",
        accessToken,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          snippet,
          status: item.status,
          contentDetails: item.contentDetails,
        }),
      });
    }
  } catch (e) {
    console.warn("[youtube] schedule nudge failed:", (e as Error).message);
  }

  if (health.streamStatus !== "active") {
    return {
      ok: false,
      detail: `waiting for stream (${health.streamStatus || "none"} · broadcast ${health.lifeCycleStatus})`,
    };
  }

  try {
    await transitionLive(id, "live");
    return { ok: true, detail: "transitioned to live" };
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (/redundantTransition|already/i.test(msg)) return { ok: true, detail: "already live" };

    const again = await getBroadcastHealth(id);
    if (/live/i.test(again.lifeCycleStatus)) return { ok: true, detail: `auto-started (${again.lifeCycleStatus})` };
    return { ok: false, detail: msg.slice(0, 180) };
  }
}
