import { getValidAccessToken } from "./oauth.js";
import { setLiveChatId } from "./tokens.js";

export type CreateLiveInput = {
  title: string;
  description?: string;
  privacy?: "public" | "unlisted" | "private";
  lane?: "main" | "vertical";
  /** raw base64 (no data: prefix) */
  thumbnailBase64?: string;
  thumbnailMime?: string;
  scheduledStartIso?: string;
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
};

async function ytFetch(path: string, init: RequestInit & { accessToken: string }): Promise<unknown> {
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
    const errObj = json as { error?: { message?: string } };
    throw Object.assign(new Error(errObj?.error?.message || `YouTube API ${res.status}: ${text.slice(0, 240)}`), {
      statusCode: 400,
    });
  }
  return json;
}

function splitIngest(ingestionAddress: string, streamName: string): { rtmpUrl: string; streamKey: string } {
  const base = ingestionAddress.replace(/\/$/, "");
  // YouTube returns e.g. rtmp://a.rtmp.youtube.com/live2 and streamName is the key
  if (/\/live2$/i.test(base) || /youtube\.com/i.test(base)) {
    return { rtmpUrl: base, streamKey: streamName };
  }
  return { rtmpUrl: "rtmp://a.rtmp.youtube.com/live2", streamKey: streamName };
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
  const startIso = input.scheduledStartIso || new Date(Date.now() + 60_000).toISOString();

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
        enableAutoStop: true,
        monitorStream: { enableMonitorStream: false },
      },
    }),
  })) as {
    id: string;
    snippet?: { liveChatId?: string };
  };

  const stream = (await ytFetch("liveStreams?part=snippet,cdn,status", {
    method: "POST",
    accessToken,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: { title: `${title} · ${lane}` },
      cdn: {
        frameRate: "variable",
        ingestionType: "rtmp",
        resolution: "variable",
      },
    }),
  })) as {
    id: string;
    cdn?: {
      ingestionInfo?: { streamName?: string; ingestionAddress?: string };
    };
  };

  await ytFetch(`liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(stream.id)}&part=id,contentDetails,snippet`, {
    method: "POST",
    accessToken,
  });

  const streamName = stream.cdn?.ingestionInfo?.streamName || "";
  const ingestionAddress = stream.cdn?.ingestionInfo?.ingestionAddress || "rtmp://a.rtmp.youtube.com/live2";
  if (!streamName) {
    throw Object.assign(new Error("YouTube did not return a stream key"), { statusCode: 502 });
  }
  const { rtmpUrl, streamKey } = splitIngest(ingestionAddress, streamName);

  if (input.thumbnailBase64) {
    try {
      await uploadThumbnail(accessToken, broadcast.id, input.thumbnailBase64, input.thumbnailMime || "image/jpeg");
    } catch {
      /* thumbnail is best-effort */
    }
  }

  // Transition to testing then live when possible (autoStart may handle; try testing)
  try {
    await ytFetch(`liveBroadcasts/transition?broadcastStatus=testing&id=${encodeURIComponent(broadcast.id)}&part=status`, {
      method: "POST",
      accessToken,
    });
  } catch {
    /* may fail until encoder connected — OK */
  }

  const liveChatId = broadcast.snippet?.liveChatId || null;
  if (liveChatId) setLiveChatId(liveChatId);

  return {
    broadcastId: broadcast.id,
    streamId: stream.id,
    streamKey,
    ingestionAddress,
    rtmpUrl,
    watchUrl: `https://youtu.be/${broadcast.id}`,
    liveChatId,
    lane,
  };
}

async function uploadThumbnail(
  accessToken: string,
  videoId: string,
  base64: string,
  mime: string
): Promise<void> {
  const cleaned = base64.replace(/^data:[^;]+;base64,/, "");
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length < 100 || buf.length > 2_000_000) {
    throw new Error("thumbnail size out of range");
  }
  const res = await fetch(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mime || "image/jpeg",
        "Content-Length": String(buf.length),
      },
      body: buf,
    }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`thumbnail ${res.status}: ${t.slice(0, 160)}`);
  }
}

export async function transitionLive(broadcastId: string, status: "testing" | "live" | "complete"): Promise<void> {
  const accessToken = await getValidAccessToken();
  await ytFetch(
    `liveBroadcasts/transition?broadcastStatus=${status}&id=${encodeURIComponent(broadcastId)}&part=status`,
    { method: "POST", accessToken }
  );
}
