import tmi from "tmi.js";
import type { ChatUserstate } from "tmi.js";
import { config } from "../config.js";
import { getSetting } from "../db.js";
import { getPlatformAccess, platformConnected } from "../oauth/platform-tokens.js";
import type { ChatMessage, ChatProvider } from "./types.js";

export function createTwitchProvider(): ChatProvider | null {
  const channel =
    getSetting("twitch_channel_override") || config.twitch.channel || "";
  const stored = getPlatformAccess("twitch");
  const accessToken = stored?.token || config.twitch.accessToken;
  if (!channel || !accessToken) return null;
  if (!platformConnected("twitch") && !config.twitch.accessToken) return null;

  let client: InstanceType<typeof tmi.Client> | null = null;

  return {
    platform: "twitch",
    async start(onMessage) {
      const token = getPlatformAccess("twitch")?.token || accessToken;
      client = new tmi.Client({
        options: { debug: false },
        identity: {
          username: channel,
          password: token.startsWith("oauth:") ? token : `oauth:${token}`,
        },
        channels: [channel],
      });
      client.on(
        "message",
        (_ch: string, tags: ChatUserstate, message: string, self: boolean) => {
          if (self) return;
          const msg: ChatMessage = {
            platform: "twitch",
            userId: String(tags["user-id"] ?? tags.username ?? "unknown"),
            user: String(tags["display-name"] || tags.username || "user"),
            text: message,
            ts: Date.now(),
          };
          onMessage(msg);
        }
      );
      await client.connect();
    },
    async stop() {
      if (client) await client.disconnect().catch(() => undefined);
      client = null;
    },
    async send(text) {
      if (!client) throw new Error("Twitch not connected");
      await client.say(channel, text);
    },
  };
}
