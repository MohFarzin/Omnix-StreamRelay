import { getSetting, setSetting } from "../db.js";
import { deletePresetThumbnail, getPresetThumbnailInfo, hasPresetThumbnail } from "./preset-thumbs.js";

const PRESET_KEY = "live.manager.presets";
const DEFAULT_KEY = "live.manager.default_id";

export type LiveMode = "aio" | "custom";

export type PlatformMeta = {
  title?: string;
  description?: string;
  game?: string;
  privacy?: "public" | "unlisted" | "private";
  latency?: "normal" | "low" | "ultraLow";
  categoryId?: string;
  lane?: "main" | "vertical";
};

export type LivePreset = {
  id: string;
  name: string;
  mode: LiveMode;
  aio?: PlatformMeta;
  custom?: {
    youtube?: PlatformMeta;
    twitch?: PlatformMeta;
    kick?: PlatformMeta;
  };
  updatedAt: string;
};

function readAll(): LivePreset[] {
  try {
    const raw = getSetting(PRESET_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LivePreset[];
    return Array.isArray(parsed) ? parsed.slice(0, 40) : [];
  } catch {
    return [];
  }
}

function writeAll(list: LivePreset[]): void {
  setSetting(PRESET_KEY, JSON.stringify(list.slice(0, 40)));
}

export type LivePresetPublic = LivePreset & {
  hasThumbnail: boolean;
  thumbnailName?: string;
  thumbnailBytes?: number;
};

export function listLivePresets(): { presets: LivePresetPublic[]; defaultId: string | null } {
  const presets = readAll().map((p) => {
    const info = getPresetThumbnailInfo(p.id);
    return {
      ...p,
      hasThumbnail: hasPresetThumbnail(p.id),
      thumbnailName: info?.name,
      thumbnailBytes: info?.bytes,
    };
  });
  const defaultId = getSetting(DEFAULT_KEY) || presets[0]?.id || null;
  return {
    presets,
    defaultId: defaultId && presets.some((p) => p.id === defaultId) ? defaultId : null,
  };
}

export function getLivePreset(id: string): LivePreset | null {
  return readAll().find((p) => p.id === id) || null;
}

export function getDefaultLivePreset(): LivePreset | null {
  const { presets, defaultId } = listLivePresets();
  if (!defaultId) return null;
  return presets.find((p) => p.id === defaultId) || null;
}

function normalizeMeta(raw: Record<string, unknown> | undefined): PlatformMeta {
  if (!raw || typeof raw !== "object") return {};
  const privacyRaw = String(raw.privacy ?? "");
  const privacy =
    privacyRaw === "public" || privacyRaw === "private" || privacyRaw === "unlisted"
      ? privacyRaw
      : undefined;
  const latencyRaw = String(raw.latency ?? "");
  const latency =
    latencyRaw === "low" || latencyRaw === "ultraLow" || latencyRaw === "normal"
      ? latencyRaw
      : undefined;
  const lane = raw.lane === "vertical" ? "vertical" : raw.lane === "main" ? "main" : undefined;
  return {
    title: String(raw.title ?? "").slice(0, 140) || undefined,
    description: String(raw.description ?? "").slice(0, 5000) || undefined,
    game: String(raw.game ?? "").slice(0, 80) || undefined,
    privacy,
    latency,
    categoryId: String(raw.categoryId ?? "").slice(0, 12) || undefined,
    lane,
  };
}

function applyPresetBody(preset: LivePreset, body: Record<string, unknown>): void {
  if (typeof body.name === "string" && body.name.trim()) {
    preset.name = body.name.trim().slice(0, 60);
  }
  if (body.mode === "aio" || body.mode === "custom") preset.mode = body.mode;
  if (preset.mode === "aio" && body.aio) {
    preset.aio = normalizeMeta(body.aio as Record<string, unknown>);
    preset.custom = undefined;
  }
  if (preset.mode === "custom" && body.custom) {
    const custom = body.custom as Record<string, unknown>;
    preset.custom = {
      youtube: normalizeMeta(custom.youtube as Record<string, unknown> | undefined),
      twitch: normalizeMeta(custom.twitch as Record<string, unknown> | undefined),
      kick: normalizeMeta(custom.kick as Record<string, unknown> | undefined),
    };
    preset.aio = undefined;
  }

  if (preset.mode === "aio" && !body.aio && body.title) {
    preset.aio = normalizeMeta(body as Record<string, unknown>);
  }
  preset.updatedAt = new Date().toISOString();
}

export function createLivePreset(body: Record<string, unknown>): LivePreset {
  const name = String(body.name ?? "Preset").trim().slice(0, 60) || "Preset";
  const mode: LiveMode = body.mode === "custom" ? "custom" : "aio";
  const preset: LivePreset = {
    id: `lm_${Date.now().toString(36)}`,
    name,
    mode,
    updatedAt: new Date().toISOString(),
  };
  applyPresetBody(preset, { ...body, name, mode });
  const list = readAll();
  list.unshift(preset);
  writeAll(list);
  setSetting(DEFAULT_KEY, preset.id);
  return preset;
}

export function updateLivePreset(id: string, body: Record<string, unknown>): LivePreset {
  const list = readAll();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) throw Object.assign(new Error("preset not found"), { statusCode: 404 });
  const cur = list[idx];
  applyPresetBody(cur, body);
  list[idx] = cur;
  writeAll(list);
  return cur;
}

export function upsertLivePreset(body: Record<string, unknown>): {
  preset: LivePreset;
  created: boolean;
} {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const name = String(body.name ?? "Preset").trim().slice(0, 60) || "Preset";
  const list = readAll();
  let idx = id ? list.findIndex((p) => p.id === id) : -1;
  if (idx < 0) {
    const want = name.toLowerCase();
    idx = list.findIndex((p) => String(p.name || "").trim().toLowerCase() === want);
  }
  if (idx >= 0) {
    applyPresetBody(list[idx], { ...body, name });
    writeAll(list);
    setSetting(DEFAULT_KEY, list[idx].id);
    return { preset: list[idx], created: false };
  }
  const preset = createLivePreset({ ...body, name });
  return { preset, created: true };
}

export function deleteLivePreset(id: string): void {
  const next = readAll().filter((p) => p.id !== id);
  writeAll(next);
  deletePresetThumbnail(id);
  if (getSetting(DEFAULT_KEY) === id) {
    setSetting(DEFAULT_KEY, next[0]?.id || "");
  }
}

export function setDefaultLivePreset(id: string): void {
  const p = getLivePreset(id);
  if (!p) throw Object.assign(new Error("preset not found"), { statusCode: 404 });
  setSetting(DEFAULT_KEY, id);
}

export function resolvePlatformMeta(preset: LivePreset, platform: "youtube" | "twitch" | "kick"): PlatformMeta {
  if (preset.mode === "aio") return preset.aio || {};
  return preset.custom?.[platform] || {};
}
