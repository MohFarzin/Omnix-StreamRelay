import { config } from "../config.js";
import { getSetting } from "../db.js";
import { getPlatformAccess } from "../oauth/platform-tokens.js";
import type { ChatMessage, ChatProvider } from "./types.js";

async function resolveChatroomId(channel: string): Promise<number | null> {
  const slug = channel.replace(/^@/, "").trim().toLowerCase();
  if (!slug) return null;
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "OmnixStreamRelay/1.0",
      },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      chatroom?: { id?: number };
      id?: number;
    };
    const id = j.chatroom?.id;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

export function createKickProvider(): ChatProvider | null {
  if (/^(0|false|off|no)$/i.test(String(process.env.KICK_CHAT || "1").trim())) {
    return null;
  }
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
      const chatroomId = await resolveChatroomId(channel);
      if (!chatroomId) {
        throw new Error(
          `Kick chatroom not found for "${channel}" (public API). Chat ingest skipped — video relay still works.`
        );
      }

      try {
        const mod = (await import("@gbrlstr/kick-flow")) as unknown as {
          KickFlow?: new (o: unknown) => unknown;
          default?: { KickFlow?: new (o: unknown) => unknown } | (new (o: unknown) => unknown);
        };
        const KickFlow =
          mod.KickFlow ??
          (typeof mod.default === "function" ? mod.default : mod.default?.KickFlow);
        if (!KickFlow) throw new Error("KickFlow export missing");

        process.env.PUPPETEER_SKIP_DOWNLOAD = "1";

        const client = new KickFlow({
          clientId: clientId || "unused",
          clientSecret: clientSecret || "unused",
          accessToken: accessToken || undefined,
        }) as {
          chat: {
            connectToChatByChatroomId?: (id: number) => Promise<{
              on: (ev: string, cb: (m: Record<string, unknown>) => void) => void;
              connect: () => Promise<void>;
              disconnect?: () => Promise<void>;
            }>;
            connectToChatByChannel: (ch: string) => Promise<{
              on: (ev: string, cb: (m: Record<string, unknown>) => void) => void;
              connect: () => Promise<void>;
              disconnect?: () => Promise<void>;
            }>;
          };
        };

        let chatWS: {
          on: (ev: string, cb: (m: Record<string, unknown>) => void) => void;
          connect: () => Promise<void>;
          disconnect?: () => Promise<void>;
        };

        if (typeof client.chat.connectToChatByChatroomId === "function") {
          chatWS = await client.chat.connectToChatByChatroomId(chatroomId);
        } else {

          throw new Error(
            "Kick chat needs connectToChatByChatroomId (no Chrome in egg). Set KICK_CHAT=0 or upgrade kick-flow."
          );
        }

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
            body: JSON.stringify({ type: "bot", content: text, chatroom_id: chatroomId }),
          });
          if (!res.ok) throw new Error(`Kick send ${res.status}`);
        };
      } catch (err) {
        const msg = (err as Error).message || String(err);
        if (/Chrome|puppeteer|chatroom/i.test(msg)) {
          console.warn("[kick] chat skipped (no browser in egg):", msg.slice(0, 160));
        } else {
          console.warn("[kick] provider failed to start:", msg.slice(0, 160));
        }
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
