import { randomBytes } from "node:crypto";
import { getSetting, setSetting } from "../db.js";
import { restartChatEngine } from "../chat/engine.js";
import { clearYoutubeTokens, saveYoutubeTokens } from "../youtube/tokens.js";
import { clearPlatformTokens, savePlatformTokens } from "./platform-tokens.js";
import { pushTwitchDestination } from "./twitch.js";

const K_PAIR = "omnix_link_pairing_code";

export function getOrCreateLinkPairingCode(): string {
  let code = getSetting(K_PAIR);
  if (code && code.length >= 16) return code;
  code = `ol_${randomBytes(18).toString("base64url")}`;
  setSetting(K_PAIR, code);
  return code;
}

export function rotateLinkPairingCode(): string {
  const code = `ol_${randomBytes(18).toString("base64url")}`;
  setSetting(K_PAIR, code);
  return code;
}

export function verifyLinkPairingCode(code: string): boolean {
  const expected = getSetting(K_PAIR);
  return Boolean(expected && code && expected === code);
}

export async function ingestLinkPush(body: {
  pairingCode: string;
  platform: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  extra?: Record<string, string>;
  /** Outbound Omnix Link agent already authenticated via tunnel token. */
  fromAgent?: boolean;
}): Promise<{ ok: true; platform: string }> {
  if (!body.fromAgent && !verifyLinkPairingCode(String(body.pairingCode || ""))) {
    throw Object.assign(new Error("Invalid pairing code"), { statusCode: 401 });
  }
  const platform = String(body.platform || "").toLowerCase();
  const accessToken = String(body.accessToken || "");
  if (!accessToken) throw Object.assign(new Error("accessToken required"), { statusCode: 400 });

  if (platform === "youtube") {
    saveYoutubeTokens({
      accessToken,
      refreshToken: body.refreshToken || undefined,
      expiresIn: body.expiresIn ?? undefined,
    });
  } else if (platform === "twitch" || platform === "kick") {
    const extra = body.extra || {};
    savePlatformTokens(platform, {
      accessToken,
      refreshToken: body.refreshToken || undefined,
      expiresIn: body.expiresIn ?? undefined,
      meta: extra,
    });
    if (extra.channel) {
      setSetting(`${platform}_channel_override`, extra.channel);
    }
    if (platform === "twitch" && extra.user_id) {
      try {
        const keyRes = await fetch(
          `https://api.twitch.tv/helix/streams/key?broadcaster_id=${encodeURIComponent(extra.user_id)}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Client-Id": process.env.TWITCH_CLIENT_ID || "",
            },
          }
        );
        const keyJson = (await keyRes.json()) as { data?: Array<{ stream_key?: string }> };
        const streamKey = keyJson.data?.[0]?.stream_key;
        if (streamKey) await pushTwitchDestination(streamKey);
      } catch {
        /* optional */
      }
    }
    void restartChatEngine().catch(() => undefined);
  } else {
    throw Object.assign(new Error("platform must be youtube|twitch|kick"), { statusCode: 400 });
  }
  return { ok: true, platform };
}

export async function revokeLinkPlatform(platformRaw: string): Promise<{ ok: true; platform: string }> {
  const platform = String(platformRaw || "").toLowerCase();
  if (platform === "youtube") {
    clearYoutubeTokens();
  } else if (platform === "twitch" || platform === "kick") {
    clearPlatformTokens(platform);
    setSetting(`${platform}_channel_override`, "");
    void restartChatEngine().catch(() => undefined);
  } else {
    throw Object.assign(new Error("platform must be youtube|twitch|kick"), { statusCode: 400 });
  }
  return { ok: true, platform };
}
