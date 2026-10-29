import { config } from "../config.js";
import { getValidAccessToken } from "../youtube/oauth.js";
import { getLiveChatId, youtubeConnected } from "../youtube/tokens.js";
import type { ChatMessage, ChatProvider } from "./types.js";

export function createYouTubeProvider(): ChatProvider | null {
  const liveChatId = getLiveChatId();
  const apiKey = config.youtube.apiKey;
  const canOAuth = youtubeConnected();
  if (!liveChatId || (!apiKey && !canOAuth && !config.youtube.accessToken)) return null;

  let timer: NodeJS.Timeout | null = null;
  let pageToken = "";
  let stopped = false;

  async function authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    try {
      if (canOAuth || config.youtube.refreshToken) {
        headers.Authorization = `Bearer ${await getValidAccessToken()}`;
      } else if (config.youtube.accessToken) {
        headers.Authorization = `Bearer ${config.youtube.accessToken}`;
      }
    } catch {
      if (config.youtube.accessToken) {
        headers.Authorization = `Bearer ${config.youtube.accessToken}`;
      }
    }
    return headers;
  }

  async function poll(onMessage: (msg: ChatMessage) => void): Promise<void> {
    const chatId = getLiveChatId();
    if (!chatId) return;
    const params = new URLSearchParams({
      liveChatId: chatId,
      part: "snippet,authorDetails",
      maxResults: "50",
    });
    if (pageToken) params.set("pageToken", pageToken);
    if (apiKey) params.set("key", apiKey);

    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/liveChat/messages?${params}`,
      { headers: await authHeaders() }
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
    if (!stopped) {
      timer = setTimeout(() => {
        void poll(onMessage).catch(() => {
          if (!stopped) timer = setTimeout(() => void poll(onMessage), 10000);
        });
      }, wait);
    }
  }

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
      const chatId = getLiveChatId();
      if (!chatId) throw new Error("No YouTube live chat id yet — create a live via YouTube manager");
      const headers = await authHeaders();
      if (!headers.Authorization) throw new Error("YouTube send needs OAuth access token");
      const res = await fetch(
        "https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet",
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            snippet: {
              liveChatId: chatId,
              type: "textMessageEvent",
              textMessageDetails: { messageText: text },
            },
          }),
        }
      );
      if (!res.ok) throw new Error(`YouTube send ${res.status}`);
    },
  };
}
