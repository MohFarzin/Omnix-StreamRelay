import { config } from "../config.js";
import type { ChatMessage, ChatProvider } from "./types.js";

export function createYouTubeProvider(): ChatProvider | null {
  const { liveChatId, apiKey, accessToken } = config.youtube;
  if (!liveChatId || (!apiKey && !accessToken)) return null;

  let timer: NodeJS.Timeout | null = null;
  let pageToken = "";
  let stopped = false;
  let sendFn: ((text: string) => Promise<void>) | null = null;

  async function poll(onMessage: (msg: ChatMessage) => void): Promise<void> {
    const params = new URLSearchParams({
      liveChatId,
      part: "snippet,authorDetails",
      maxResults: "50",
    });
    if (pageToken) params.set("pageToken", pageToken);
    if (apiKey) params.set("key", apiKey);

    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/liveChat/messages?${params}`,
      { headers }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`YouTube chat poll ${res.status}: ${t.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      nextPageToken?: string;
      pollingIntervalMillis?: number;
      items?: Array<{
        snippet?: { type?: string; displayMessage?: string; publishedAt?: string };
        authorDetails?: { channelId?: string; displayName?: string };
      }>;
    };
    pageToken = body.nextPageToken ?? pageToken;
    for (const item of body.items ?? []) {
      if (item.snippet?.type && item.snippet.type !== "textMessageEvent") continue;
      const text = item.snippet?.displayMessage;
      if (!text) continue;
      onMessage({
        platform: "youtube",
        userId: item.authorDetails?.channelId ?? "unknown",
        user: item.authorDetails?.displayName ?? "user",
        text,
        ts: Date.now(),
      });
    }
    const wait = Math.max(body.pollingIntervalMillis ?? 5000, 2000);
    if (!stopped) timer = setTimeout(() => void poll(onMessage).catch(() => {
      if (!stopped) timer = setTimeout(() => void poll(onMessage), 10000);
    }), wait);
  }

  sendFn = async (text: string) => {
    if (!accessToken) throw new Error("YouTube send needs YOUTUBE_ACCESS_TOKEN");
    const res = await fetch(
      "https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          snippet: {
            liveChatId,
            type: "textMessageEvent",
            textMessageDetails: { messageText: text },
          },
        }),
      }
    );
    if (!res.ok) throw new Error(`YouTube send ${res.status}`);
  };

  return {
    platform: "youtube",
    async start(onMessage) {
      stopped = false;
      await poll(onMessage);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    async send(text) {
      if (!sendFn) throw new Error("YouTube not ready");
      await sendFn(text);
    },
  };
}
