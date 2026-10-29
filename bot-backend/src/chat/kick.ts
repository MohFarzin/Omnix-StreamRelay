import { config } from "../config.js";
import { getSetting } from "../db.js";
import { getPlatformAccess } from "../oauth/platform-tokens.js";
import type { ChatMessage, ChatProvider } from "./types.js";

/**
 * Kick via @gbrlstr/kick-flow when installed; otherwise no-op provider skipped.
 * shortcut: unofficial WS client, upgrade to official webhooks when DOMAIN + Kick app ready
 */
export function createKickProvider(): ChatProvider | null {
  const channel = getSetting("kick_channel_override") || config.kick.channel;
  const stored = getPlatformAccess("kick");
  const accessToken = stored?.token || config.kick.accessToken;
  const { clientId, clientSecret } = config.kick;
  if (!channel) return null;

  let stopHandle: (() => Promise<void>) | null = null;
  let sendImpl: ((text: string) => Promise<void>) | null = null;

  return {
    platform: "kick",
    async start(onMessage) {
      try {
        const mod = (await import("@gbrlstr/kick-flow")) as unknown as {
          KickFlow?: new (o: unknown) => unknown;
          default?: { KickFlow?: new (o: unknown) => unknown } | (new (o: unknown) => unknown);
        };
        const KickFlow =
          mod.KickFlow ??
          (typeof mod.default === "function"
            ? mod.default
            : mod.default?.KickFlow);
        if (!KickFlow) throw new Error("KickFlow export missing");

        const client = new KickFlow({
          clientId: clientId || "unused",
          clientSecret: clientSecret || "unused",
          accessToken: accessToken || undefined,
        }) as {
          chat: {
            connectToChatByChannel: (ch: string) => Promise<{
              on: (ev: string, cb: (m: Record<string, unknown>) => void) => void;
              connect: () => Promise<void>;
              disconnect?: () => Promise<void>;
            }>;
          };
        };

        const chatWS = await client.chat.connectToChatByChannel(channel);
        chatWS.on("message", (message) => {
          const sender = (message.sender ?? {}) as { id?: string | number; username?: string };
          const content = String(message.content ?? message.message ?? "");
          if (!content) return;
          const msg: ChatMessage = {
            platform: "kick",
            userId: String(sender.id ?? sender.username ?? "unknown"),
            user: String(sender.username ?? "user"),
            text: content,
            ts: Date.now(),
          };
          onMessage(msg);
        });
        await chatWS.connect();
        stopHandle = async () => {
          await chatWS.disconnect?.();
        };
        sendImpl = async (text: string) => {
          if (!accessToken) throw new Error("Kick send needs KICK_ACCESS_TOKEN");
          const res = await fetch("https://api.kick.com/public/v1/chat", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ type: "bot", content: text }),
          });
          if (!res.ok) throw new Error(`Kick send ${res.status}`);
        };
      } catch (err) {
        console.warn("[kick] provider failed to start:", (err as Error).message);
        throw err;
      }
    },
    async stop() {
      if (stopHandle) await stopHandle();
      stopHandle = null;
    },
    async send(text) {
      if (!sendImpl) throw new Error("Kick not connected");
      await sendImpl(text);
    },
  };
}
