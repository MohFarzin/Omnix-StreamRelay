import { config } from "../config.js";
import {
  findOrCreateViewer,
  getSetting,
  listCommands,
  type CommandRow,
} from "../db.js";
import type { ChatMessage, ChatProvider, Platform } from "./types.js";
import { createTwitchProvider } from "./twitch.js";
import { createYouTubeProvider } from "./youtube.js";
import { createKickProvider } from "./kick.js";
import { getLiveChatId, youtubeConnected } from "../youtube/tokens.js";

type HubListener = (msg: ChatMessage) => void;

const cooldowns = new Map<string, number>();
const providers: ChatProvider[] = [];
const listeners = new Set<HubListener>();

function emit(msg: ChatMessage): void {
  for (const l of listeners) l(msg);
}

export function onChat(listener: HubListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function reply(platform: Platform, text: string): Promise<void> {
  const p = providers.find((x) => x.platform === platform);
  if (p) await p.send(text);
}

async function handleMessage(msg: ChatMessage): Promise<void> {
  emit(msg);

  const { isNew } = findOrCreateViewer(msg.platform, msg.userId, msg.user);
  if (isNew) {
    const tmpl = getSetting("welcome") ?? "Welcome, {user}!";
    const welcome = tmpl.replaceAll("{user}", msg.user).replaceAll("{platform}", msg.platform);
    await reply(msg.platform, welcome).catch((e) => console.warn("welcome failed", e));
  }

  const m = msg.text.trim().match(/^!(\w+)\s*$/i);
  if (!m) return;
  const name = m[1]!.toLowerCase();
  const cmd = (listCommands() as CommandRow[]).find((c) => c.name === name && c.enabled);
  if (!cmd) return;

  const cdKey = `${msg.platform}:${name}`;
  const now = Date.now();
  const last = cooldowns.get(cdKey) ?? 0;
  if (now - last < cmd.cooldown_sec * 1000) return;
  cooldowns.set(cdKey, now);
  await reply(msg.platform, cmd.response).catch((e) => console.warn("cmd failed", e));
}

export async function startChatEngine(): Promise<void> {
  const candidates = [createTwitchProvider(), createYouTubeProvider(), createKickProvider()];
  for (const p of candidates) {
    if (!p) continue;
    try {
      await p.start((msg) => void handleMessage(msg));
      providers.push(p);
      console.log(`[chat] ${p.platform} connected`);
    } catch (e) {
      console.warn(`[chat] ${p.platform} skipped:`, (e as Error).message);
    }
  }
  if (!providers.length) {
    console.warn("[chat] no platforms connected — set TWITCH_* / YOUTUBE_* / KICK_* then restart");
  }
}

export async function stopChatEngine(): Promise<void> {
  await Promise.all(providers.map((p) => p.stop().catch(() => undefined)));
  providers.length = 0;
}

export async function restartChatEngine(): Promise<void> {
  await stopChatEngine();
  await startChatEngine();
}

export async function sendChat(text: string, platforms?: Platform[]): Promise<void> {
  const targets = platforms?.length
    ? providers.filter((p) => platforms.includes(p.platform))
    : providers;
  if (!targets.length) throw Object.assign(new Error("no chat platforms connected"), { statusCode: 400 });
  await Promise.all(targets.map((p) => p.send(text)));
}

export function activePlatforms(): Platform[] {
  return providers.map((p) => p.platform);
}

/** Why chat is empty — for dashboard notice. */
export function chatDiagnostics(): {
  connected: Platform[];
  missing: Array<{ platform: Platform; need: string }>;
} {
  const connected = activePlatforms();
  const missing: Array<{ platform: Platform; need: string }> = [];
  if (!config.twitch.channel || !config.twitch.accessToken) {
    missing.push({ platform: "twitch", need: "TWITCH_CHANNEL + TWITCH_ACCESS_TOKEN" });
  } else if (!connected.includes("twitch")) {
    missing.push({ platform: "twitch", need: "configured but failed to connect — check token" });
  }
  const ytChat = getLiveChatId();
  const ytAuth = youtubeConnected() || Boolean(config.youtube.apiKey || config.youtube.accessToken);
  if (!ytChat || !ytAuth) {
    missing.push({
      platform: "youtube",
      need: "Connect Google + Create live (or set YOUTUBE_LIVE_CHAT_ID + API/OAuth)",
    });
  } else if (!connected.includes("youtube")) {
    missing.push({ platform: "youtube", need: "configured but failed to connect — try restart chat" });
  }
  if (!config.kick.channel) {
    missing.push({ platform: "kick", need: "KICK_CHANNEL (+ optional KICK_ACCESS_TOKEN to reply)" });
  } else if (!connected.includes("kick")) {
    missing.push({ platform: "kick", need: "configured but Kick chat lib failed — check logs" });
  }
  return { connected, missing };
}
