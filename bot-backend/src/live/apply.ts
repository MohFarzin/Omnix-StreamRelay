import { encrypt } from "../crypto.js";
import {
  getSetting,
  getTarget,
  listTargets,
  setSetting,
  setTargetError,
  upsertTarget,
} from "../db.js";
import { getPlatformAccess, getPlatformMeta, platformConnected } from "../oauth/platform-tokens.js";
import {
  createDualEncoderLive,
  ensureMainEncoderStream,
  ensureVerticalEncoderStream,
  listManagedLives,
  youtubeStudioLiveUrl,
} from "../youtube/live.js";
import { youtubeConnected } from "../youtube/tokens.js";
import { assertStreamKey } from "../validate.js";
import { reconcile, resetTargetBackoff } from "../relay/ffmpeg.js";
import {
  getDefaultLivePreset,
  getLivePreset,
  listLivePresets,
  resolvePlatformMeta,
  type LivePreset,
  type PlatformMeta,
} from "./presets.js";
import { loadPresetThumbnail } from "./preset-thumbs.js";
import {
  bindYoutubeKeyFromBroadcast,
  ensureYoutubeDestination,
  fetchKickStreamKey,
  isPendingYoutubeKey,
  refreshPendingYoutubeKeys,
  youtubeDestLabel,
} from "./destinations.js";
import {
  clearLiveSession,
  getLiveSession,
  saveSessionYouTube,
  setSessionStatus,
} from "./session.js";
import {
  beginEnding,
  clearRuntime,
  getRuntimePhase,
  markPrepared,
  markStarted,
  peekRuntime,
} from "./runtime.js";
import { transitionLive, tryGoLive } from "../youtube/live.js";
import { listTargets as listAllTargets, setTargetEnabled } from "../db.js";
import { stopTarget } from "../relay/ffmpeg.js";
import { mediaExists, getMediaTimers } from "./media.js";

const LAST_APPLY_EPOCH = "live.manager.last_apply_epoch";

export type ApplyResult = {
  ok: boolean;
  presetId: string | null;
  results: Record<string, { ok: boolean; detail?: string }>;
};

function mergeMeta(base: PlatformMeta, overlay?: PlatformMeta): PlatformMeta {
  if (!overlay) return base;
  const out: PlatformMeta = { ...base };
  for (const key of ["title", "description", "game", "privacy", "latency", "categoryId", "lane"] as const) {
    const v = overlay[key];
    if (v != null && String(v).trim() !== "") (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

function metaFor(
  preset: LivePreset | null,
  platform: "youtube" | "twitch" | "kick",
  draft?: Partial<Record<"youtube" | "twitch" | "kick" | "aio", PlatformMeta>> & {
    mode?: string;
    custom?: Partial<Record<"youtube" | "twitch" | "kick", PlatformMeta>>;
  }
): PlatformMeta {
  const fromPreset = preset ? resolvePlatformMeta(preset, platform) : {};
  if (draft?.mode === "aio" && draft.aio) return mergeMeta(fromPreset, draft.aio);
  if (draft?.mode === "custom") {
    const fromNested = draft.custom?.[platform];
    if (fromNested) return mergeMeta(fromPreset, fromNested);
    if (draft[platform]) return mergeMeta(fromPreset, draft[platform] as PlatformMeta);
  }
  if (Object.keys(fromPreset).length) return fromPreset;
  if (draft?.aio) return draft.aio;
  return {};
}

function writeYoutubeDest(
  lane: "main" | "vertical",
  ingest: { rtmpUrl: string; streamKey: string },
  enabledDefault = 0
): void {
  const id = lane === "vertical" ? "youtube-v" : "youtube";
  const existing = getTarget(id);
  upsertTarget({
    id,
    label: existing?.label || youtubeDestLabel(lane),
    platform: "youtube",
    rtmp_url: ingest.rtmpUrl,
    stream_key_enc: encrypt(assertStreamKey(ingest.streamKey)),
    enabled: existing?.enabled ?? enabledDefault,
    lane,
  });
  resetTargetBackoff(id);
}

async function reuseExistingYouTubeLive(
  lane: "main" | "vertical",
  meta: PlatformMeta
): Promise<{ ok: boolean; detail?: string; broadcastId?: string; watchUrl?: string }> {
  let lives: Awaited<ReturnType<typeof listManagedLives>> = [];
  try {
    lives = await listManagedLives();
  } catch (e) {
    return { ok: false, detail: friendlyYtErr((e as Error).message) };
  }
  if (!lives.length) {
    return {
      ok: false,
      detail:
        "YouTube API quota exceeded and no existing Control Room live to reuse — wait until quota resets (midnight Pacific) or Use an existing live from the list",
    };
  }
  const want = String(meta.title || "").trim().toLowerCase();
  const hit =
    (want ? lives.find((l) => String(l.title || "").toLowerCase().includes(want)) : null) ||
    lives.find((l) => /active|live|testing/i.test(l.lifeCycleStatus)) ||
    lives[0];
  const bound = await bindYoutubeKeyFromBroadcast(lane, hit.broadcastId);
  if (!bound.ok) return { ok: false, detail: bound.detail || "rebind failed" };
  console.log(`[live] YouTube ${lane} reused existing live ${hit.broadcastId} (${hit.title})`);
  return {
    ok: true,
    detail: `reused ${hit.watchUrl || hit.broadcastId}`,
    broadcastId: hit.broadcastId,
    watchUrl: hit.watchUrl,
  };
}

async function applyYouTube(
  meta: PlatformMeta,
  opts: {
    thumbnailBase64?: string;
    thumbnailMime?: string;

    createYoutube?: boolean;
  } = {}
): Promise<{ ok: boolean; detail?: string }> {
  const session = getLiveSession();
  if (!opts.createYoutube) {
    if (session.youtubeMainId || session.youtubeVerticalId) {
      return {
        ok: true,
        detail: `reuse ${session.watchMain || session.youtubeMainId || ""}`,
      };
    }
    return { ok: true, detail: "skipped — Create stream first" };
  }

  if (!youtubeConnected()) return { ok: false, detail: "YouTube not connected" };
  const baseTitle = String(meta.title || "").trim();
  if (!baseTitle) return { ok: false, detail: "YouTube title required" };

  await ensureYoutubeDestination("main");
  await ensureYoutubeDestination("vertical");

  if (isPendingYoutubeKey(getTarget("youtube-v"))) {
    setSetting("youtube.vertical_encoder_stream_id", "");
    setSetting("youtube.vertical_encoder_stream_key_enc", "");
    setSetting("youtube.vertical_encoder_rtmp", "");
    console.log("[live] vertical Encoder key missing — will mint/refill on Create");
  }

  const saveDualSession = (broadcastId: string, watchUrl: string) => {
    saveSessionYouTube({
      mainId: broadcastId,

      verticalId: broadcastId,
      watchMain: watchUrl,
      watchVertical: watchUrl,
      status: "prepared",
    });
  };

  try {
    const created = await createDualEncoderLive({
      title: baseTitle.slice(0, 100),
      description: meta.description || "",
      privacy: meta.privacy || "unlisted",
      latency: meta.latency || "normal",
      categoryId: meta.categoryId,
      gameTitle: meta.game,
      thumbnailBase64: opts.thumbnailBase64,
      thumbnailMime: opts.thumbnailMime,
    });
    writeYoutubeDest("main", created.main);
    setTargetError("youtube", null);
    const vertKey = String(created.vertical?.streamKey || "");
    if (vertKey && !/pending-youtube/i.test(vertKey)) {
      writeYoutubeDest("vertical", created.vertical);
      setTargetError("youtube-v", null);
      console.log("[live] Create — vertical Encoder key written to destination");
    } else {

      try {
        const vert = await ensureVerticalEncoderStream();
        writeYoutubeDest("vertical", vert);
        setTargetError("youtube-v", null);
        console.log("[live] Create — vertical Encoder key refilled (retry)");
      } catch (ve) {
        console.warn(`[live] vertical key still missing after Create:`, (ve as Error).message);
        setTargetError(
          "youtube-v",
          "Vertical key not filled — Create again after quota resets, or Edit and paste Encoder key from Studio"
        );
      }
    }
    await reconcile();
    saveDualSession(created.broadcastId, created.watchUrl);
    const thumbNote = created.thumbnailError ? ` (thumb: ${created.thumbnailError})` : "";
    const studio = youtubeStudioLiveUrl(created.broadcastId);
    console.log(
      `[live] YouTube session saved one-video=${created.broadcastId} verticalEncoder=refilled`
    );
    return {
      ok: true,
      detail: `ok:main:${created.watchUrl} · shorts-encoder · Studio Dual stream→Encoder: ${studio}${thumbNote}`,
    };
  } catch (e) {
    const msg = friendlyYtErr((e as Error).message);
    console.warn(`[live] YouTube dual-encoder create failed:`, msg);
    if (!/quota/i.test(msg)) return { ok: false, detail: msg };

    try {
      const main = await ensureMainEncoderStream();
      writeYoutubeDest("main", main);
      setTargetError("youtube", null);
    } catch (ke) {
      console.warn(`[live] quota main key refresh failed:`, (ke as Error).message);
    }
    try {
      const vert = await ensureVerticalEncoderStream();
      writeYoutubeDest("vertical", vert);
      setTargetError("youtube-v", null);
      console.log("[live] Create — vertical Encoder key refilled into destination");
    } catch (ke) {
      console.warn(`[live] quota vertical key refresh failed:`, (ke as Error).message);
      setTargetError(
        "youtube-v",
        "Vertical key not filled (API quota) — Create again after quota resets, or Edit and paste Encoder key from Studio"
      );
    }
    await reconcile();

    const reused = await reuseExistingYouTubeLive("main", meta);
    if (reused.ok && reused.broadcastId) {

      try {
        const vert = await ensureVerticalEncoderStream();
        writeYoutubeDest("vertical", vert);
        setTargetError("youtube-v", null);
      } catch (ve) {
        console.warn(`[live] vertical refill after reuse failed:`, (ve as Error).message);
      }
      saveDualSession(reused.broadcastId, reused.watchUrl || `https://youtu.be/${reused.broadcastId}`);
      return {
        ok: true,
        detail: `reused ${reused.watchUrl || reused.broadcastId} · shorts-encoder`,
      };
    }

    const mainT = getTarget("youtube");
    const vertT = getTarget("youtube-v");
    if (mainT && !isPendingYoutubeKey(mainT)) {
      return {
        ok: true,
        detail: `keys kept${
          vertT && !isPendingYoutubeKey(vertT) ? " (main+vertical)" : " (main)"
        } · no new Control Room live (quota) — End existing Studio live or wait for quota reset`,
      };
    }
    return { ok: false, detail: reused.detail || msg };
  }
}

async function applyTwitch(meta: PlatformMeta): Promise<{ ok: boolean; detail?: string }> {
  if (!platformConnected("twitch")) return { ok: false, detail: "Twitch not connected" };
  const access = getPlatformAccess("twitch");
  const platformMeta = getPlatformMeta("twitch");
  if (!access?.token || !platformMeta.user_id) return { ok: false, detail: "Twitch token missing" };
  const clientId =
    process.env.TWITCH_CLIENT_ID ||
    String(platformMeta.client_id || "").trim() ||
    getSetting("twitch_oauth_client_id") ||
    "";
  if (!clientId) return { ok: false, detail: "TWITCH_CLIENT_ID not set on egg" };

  const title = String(meta.title || "").trim();
  if (!title) return { ok: false, detail: "Twitch title required" };

  let gameId: string | undefined;
  const game = String(meta.game || "").trim();
  if (game) {
    try {
      const gRes = await fetch(
        `https://api.twitch.tv/helix/games?name=${encodeURIComponent(game)}`,
        {
          headers: {
            Authorization: `Bearer ${access.token}`,
            "Client-Id": clientId,
          },
        }
      );
      const gJson = (await gRes.json()) as { data?: Array<{ id?: string }> };
      gameId = gJson.data?.[0]?.id;
    } catch {
    }
  }

  const patchBody: Record<string, unknown> = { title };
  if (gameId) patchBody.game_id = gameId;

  const res = await fetch(
    `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(platformMeta.user_id)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${access.token}`,
        "Client-Id": clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patchBody),
    }
  );
  if (!res.ok) {
    const t = await res.text();
    const plain = t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (res.status === 401 || /scope|authorize/i.test(plain)) {
      return {
        ok: false,
        detail:
          "Twitch needs reconnect (missing channel:manage:broadcast) — Disconnect Twitch on Omnix Link, Connect again, then Update titles",
      };
    }
    return { ok: false, detail: `Twitch ${res.status}: ${plain.slice(0, 140)}` };
  }

  if (!getTarget("twitch")) {
    try {
      const keyRes = await fetch(
        `https://api.twitch.tv/helix/streams/key?broadcaster_id=${encodeURIComponent(platformMeta.user_id)}`,
        {
          headers: {
            Authorization: `Bearer ${access.token}`,
            "Client-Id": clientId,
          },
        }
      );
      const keyJson = (await keyRes.json()) as { data?: Array<{ stream_key?: string }> };
      const streamKey = keyJson.data?.[0]?.stream_key;
      if (streamKey) {
        upsertTarget({
          id: "twitch",
          label: "Twitch · main",
          platform: "twitch",
          rtmp_url: "rtmp://live.twitch.tv/app",
          stream_key_enc: encrypt(assertStreamKey(streamKey)),
          enabled: 0,
          lane: "main",
        });
      }
    } catch {
    }
  }
  return { ok: true, detail: title };
}

async function applyKick(meta: PlatformMeta): Promise<{ ok: boolean; detail?: string }> {
  if (!platformConnected("kick")) return { ok: false, detail: "Kick not connected" };
  const access = getPlatformAccess("kick");
  if (!access?.token) return { ok: false, detail: "Kick token missing" };
  const title = String(meta.title || "").trim();
  if (!title) return { ok: false, detail: "Kick title required" };

  const res = await fetch("https://api.kick.com/public/v1/channels", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${access.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ stream_title: title }),
  });
  if (!res.ok && res.status !== 204) {
    const t = await res.text();
    return { ok: false, detail: `Kick ${res.status}: ${t.slice(0, 120)}` };
  }

  if (!getTarget("kick")) {
    const sk = await fetchKickStreamKey(access.token);
    if (sk) {
      upsertTarget({
        id: "kick",
        label: "Kick · main",
        platform: "kick",
        rtmp_url: sk.rtmpUrl,
        stream_key_enc: encrypt(assertStreamKey(sk.streamKey)),
        enabled: 0,
        lane: "main",
      });
    }
  }
  return { ok: true, detail: title };
}

export async function applyLivePreset(opts: {
  presetId?: string;
  draft?: Record<string, unknown>;

  forceAll?: boolean;
  platforms?: Array<"youtube" | "twitch" | "kick">;

  createYoutube?: boolean;
}): Promise<ApplyResult> {
  let preset: LivePreset | null = null;
  if (opts.presetId) preset = getLivePreset(opts.presetId);
  else preset = getDefaultLivePreset();

  const draft = opts.draft as
    | (Partial<Record<"youtube" | "twitch" | "kick" | "aio", PlatformMeta>> & {
        mode?: string;
        custom?: Partial<Record<"youtube" | "twitch" | "kick", PlatformMeta>>;
        thumbnailBase64?: string;
        thumbnailMime?: string;
      })
    | undefined;

  let thumbnailBase64 = draft?.thumbnailBase64
    ? String(draft.thumbnailBase64).slice(0, 2_800_000)
    : undefined;
  let thumbnailMime = draft?.thumbnailMime ? String(draft.thumbnailMime).slice(0, 64) : undefined;
  if (!thumbnailBase64 && preset) {
    const stored = loadPresetThumbnail(preset.id);
    if (stored) {
      thumbnailBase64 = stored.thumbnailBase64;
      thumbnailMime = stored.thumbnailMime;
    }
  }

  const enabledPlatforms = new Set(
    listTargets()
      .filter((t) => t.enabled)
      .map((t) => String(t.platform || "").toLowerCase())
  );

  const want = opts.platforms || (["youtube", "twitch", "kick"] as const);
  const results: ApplyResult["results"] = {};

  for (const platform of want) {

    if (!opts.forceAll && !enabledPlatforms.has(platform)) continue;

    const meta = metaFor(preset, platform, draft);
    if (!String(meta.title || "").trim()) continue;

    try {
      if (platform === "youtube") {
        results.youtube = await applyYouTube(meta, {
          createYoutube: Boolean(opts.createYoutube),
          thumbnailBase64,
          thumbnailMime,
        });
      } else if (platform === "twitch") results.twitch = await applyTwitch(meta);
      else results.kick = await applyKick(meta);
    } catch (e) {
      results[platform] = { ok: false, detail: friendlyYtErr((e as Error).message) };
    }
  }

  const ok = Object.values(results).some((r) => r.ok);
  return { ok, presetId: preset?.id || null, results };
}

function friendlyYtErr(msg: string): string {
  const plain = String(msg || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/quota/i.test(plain)) {
    return "YouTube API quota exceeded for today — stop creating new lives; End + Create tomorrow, or reuse an existing Control Room live.";
  }
  return plain.slice(0, 240);
}

export function maybeApplyDefaultOnIngest(laneEpochMain: number): void {
  const last = Number(getSetting(LAST_APPLY_EPOCH) || "0");
  if (last === laneEpochMain) return;
  const session = getLiveSession();
  if (session.status !== "live") return;
  const { defaultId } = listLivePresets();
  if (!defaultId) return;
  setSetting(LAST_APPLY_EPOCH, String(laneEpochMain));
  void applyLivePreset({
    presetId: defaultId,
    forceAll: false,
    platforms: ["twitch", "kick"],
  }).catch((e) => {
    console.warn("[live] title refresh failed:", (e as Error).message);
  });
}

export async function createStreamSession(opts: {
  draft?: Record<string, unknown>;
  presetId?: string;
}): Promise<
  ApplyResult & {
    session: ReturnType<typeof getLiveSession>;
    runtime: ReturnType<typeof peekRuntime>;

    verticalKeyMissing?: boolean;

    studioUrl?: string;
  }
> {
  const existing = getLiveSession();
  if (existing.status === "live") {
    throw Object.assign(new Error("Stream already live — End first, then Create again"), {
      statusCode: 400,
    });
  }
  if (existing.status === "prepared" && (existing.youtubeMainId || existing.youtubeVerticalId)) {

    const rebound = await refreshPendingYoutubeKeys();
    for (const t of listAllTargets()) {
      if (t.platform === "youtube" || t.platform === "twitch" || t.platform === "kick") {
        if (t.platform === "youtube" && isPendingYoutubeKey(t)) {
          setTargetEnabled(t.id, false);
          continue;
        }
        setTargetEnabled(t.id, true);
      }
    }
    await reconcile();
    const ytPending = listAllTargets().filter((t) => t.platform === "youtube" && isPendingYoutubeKey(t));

    if (ytPending.length) {

      for (const t of ytPending) {
        const lane = t.lane === "vertical" ? "vertical" : "main";
        const hasId = lane === "vertical" ? existing.youtubeVerticalId : existing.youtubeMainId;
        if (hasId) continue;
        const reused = await reuseExistingYouTubeLive(lane, { title: "" });
        if (reused.ok && reused.broadcastId) {
          saveSessionYouTube(
            lane === "vertical"
              ? { verticalId: reused.broadcastId, watchVertical: reused.watchUrl }
              : { mainId: reused.broadcastId, watchMain: reused.watchUrl }
          );
        }
      }
      await refreshPendingYoutubeKeys();
      const still = listAllTargets().filter((t) => t.platform === "youtube" && isPendingYoutubeKey(t));
      const mainStillMissing = still.some((t) => t.id === "youtube" || t.lane !== "vertical");
      if (mainStillMissing) {
        throw Object.assign(
          new Error(
            "YouTube main key still missing — Use an existing Control Room live, or wait for API quota reset"
          ),
          { statusCode: 400 }
        );
      }
    }
    const sess = getLiveSession();
    const vertMissing = isPendingYoutubeKey(getTarget("youtube-v"));
    return {
      ok: true,
      presetId: existing.presetId,
      results: {
        youtube: {
          ok: true,
          detail: `already prepared · ${existing.watchMain || existing.youtubeMainId}${
            rebound.refreshed.length ? ` · rebound ${rebound.refreshed.join(",")}` : ""
          }${vertMissing ? " · paste vertical key" : ""}`,
        },
      },
      session: sess,
      runtime: peekRuntime(),
      verticalKeyMissing: vertMissing,
      studioUrl: sess.youtubeMainId
        ? youtubeStudioLiveUrl(sess.youtubeMainId)
        : "https://studio.youtube.com/livestreaming",
    };
  }

  let presetId = opts.presetId?.trim() || undefined;
  if (!presetId) {
    const def = getDefaultLivePreset();
    if (def) presetId = def.id;
  }
  const draft = opts.draft as
    | { mode?: string; aio?: { title?: string }; custom?: { youtube?: { title?: string } } }
    | undefined;
  const draftTitle =
    draft?.mode === "custom"
      ? String(draft.custom?.youtube?.title || "").trim()
      : String(draft?.aio?.title || "").trim();
  const presetTitle = presetId
    ? (() => {
        const p = getLivePreset(presetId);
        if (!p) return "";
        return p.mode === "custom"
          ? String(p.custom?.youtube?.title || "").trim()
          : String(p.aio?.title || "").trim();
      })()
    : "";
  if (!draftTitle && !presetTitle) {
    throw Object.assign(
      new Error("Enter a stream title or set a default Live Manager preset before Create"),
      { statusCode: 400 }
    );
  }

  const result = await applyLivePreset({
    presetId,
    draft: opts.draft,
    forceAll: true,
    createYoutube: true,
  });
  console.log(
    "[live] Create results:",
    Object.entries(result.results || {})
      .map(([k, v]) => `${k}=${v.ok ? "ok" : "FAIL"}:${v.detail || ""}`)
      .join(" · ")
  );
  if (!result.ok) {
    const parts = Object.entries(result.results || {}).map(
      ([k, v]) => `${k}: ${v.ok ? "ok" : v.detail || "fail"}`
    );
    const msg =
      parts.length > 0
        ? friendlyYtErr(parts.join(" · "))
        : "Nothing to create — enter a title (and Connect Google for YouTube)";
    throw Object.assign(new Error(msg), { statusCode: 400 });
  }

  if (youtubeConnected()) {
    const yt = result.results?.youtube;
    if (!yt?.ok) {
      const main = getTarget("youtube");
      const keysOk = Boolean(main && !isPendingYoutubeKey(main));
      if (!keysOk) {
        throw Object.assign(
          new Error(
            friendlyYtErr(
              `YouTube Create failed: ${yt?.detail || "unknown"} — Twitch/Kick titles may have updated; fix YouTube then Create again`
            )
          ),
          { statusCode: 400 }
        );
      }
      console.warn(
        `[live] YouTube Create soft-ok — reusable keys present, broadcast mint failed: ${yt?.detail || "unknown"}`
      );
    }
  }
  if (presetId || result.presetId) saveSessionYouTube({ presetId: presetId || result.presetId || undefined });

  await refreshPendingYoutubeKeys();
  if (youtubeConnected()) {
    const main = getTarget("youtube");
    if (!main || isPendingYoutubeKey(main)) {
      const ytDetail = result.results?.youtube?.detail || "";

      const otherOk = ["twitch", "kick"].some((p) => result.results?.[p]?.ok);
      if (!otherOk) {
        throw Object.assign(
          new Error(
            friendlyYtErr(
              `YouTube key missing after Create${ytDetail ? ` (${ytDetail})` : ""} — reconnect Google on Omnix Link, check Live is enabled on the channel / API quota, then Create again`
            )
          ),
          { statusCode: 400 }
        );
      }
      console.warn(`[live] preparing without YouTube key (${ytDetail || "missing"}) — Twitch/Kick only`);
    }
  }
  setSessionStatus("prepared");
  markPrepared();
  for (const t of listAllTargets()) {
    if (t.platform === "youtube" || t.platform === "twitch" || t.platform === "kick") {
      if (t.platform === "youtube" && isPendingYoutubeKey(getTarget(t.id) || t)) {
        setTargetEnabled(t.id, false);
        continue;
      }
      setTargetEnabled(t.id, true);
    }
  }
  await reconcile();
  const session = getLiveSession();
  const vertPending = isPendingYoutubeKey(getTarget("youtube-v"));
  const studioUrl = session.youtubeMainId
    ? youtubeStudioLiveUrl(session.youtubeMainId)
    : "https://studio.youtube.com/livestreaming";
  return {
    ...result,
    session,
    runtime: peekRuntime(),

    verticalKeyMissing: vertPending,
    studioUrl,
  };
}

export async function startStreamSession(): Promise<{
  ok: boolean;
  session: ReturnType<typeof getLiveSession>;
  runtime: ReturnType<typeof peekRuntime>;
}> {
  const session = getLiveSession();
  if (session.status === "idle") {
    throw Object.assign(new Error("Create a stream first (Create stream)"), { statusCode: 400 });
  }

  let rebound = await refreshPendingYoutubeKeys();

  if (youtubeConnected()) {
    const main = getTarget("youtube");
    if (main && isPendingYoutubeKey(main) && !getLiveSession().youtubeMainId) {
      const reused = await reuseExistingYouTubeLive("main", { title: "" });
      if (reused.ok && reused.broadcastId) {
        saveSessionYouTube({
          mainId: reused.broadcastId,
          watchMain: reused.watchUrl,
          status: "prepared",
        });
        rebound = await refreshPendingYoutubeKeys();
      }
    }
  }
  if (rebound.refreshed.length) {
    console.log(`[live] rebound YouTube keys: ${rebound.refreshed.join(",")}`);
    for (const id of rebound.refreshed) setTargetEnabled(id, true);
  }

  markStarted();
  await reconcile();

  const ids = [
    ...new Set(
      [getLiveSession().youtubeMainId, getLiveSession().youtubeVerticalId].filter(Boolean) as string[]
    ),
  ];
  const liveOk = new Set<string>();
  const bumpYt = async (tag: string) => {
    for (const id of ids) {
      if (liveOk.has(id)) continue;
      try {
        const r = await tryGoLive(id);
        if (r.ok) {
          liveOk.add(id);
          console.log(`[live] youtube ${id} → live (${tag}): ${r.detail}`);
        } else {
          console.warn(`[live] youtube ${id} not live yet (${tag}): ${r.detail}`);
        }
      } catch (e) {
        console.warn(`[live] youtube ${id} live failed (${tag}):`, (e as Error).message);
      }
    }
  };

  for (const delay of [8_000, 18_000, 35_000, 55_000, 90_000, 150_000]) {
    setTimeout(() => {
      void bumpYt(`${delay / 1000}s`);
    }, delay);
  }
  return { ok: true, session: getLiveSession(), runtime: peekRuntime() };
}

export async function endStreamSession(opts?: {
  force?: boolean;
}): Promise<{
  ok: boolean;
  session: ReturnType<typeof getLiveSession>;
  runtime: ReturnType<typeof peekRuntime>;
  endingCredits?: boolean;
}> {
  const phase = getRuntimePhase();

  if (phase === "idle") {
    return { ok: true, session: getLiveSession(), runtime: peekRuntime() };
  }
  if (phase === "prepared" && !opts?.force) {
    return finalizeStreamSession();
  }

  if (phase === "ending" && !opts?.force) {
    return {
      ok: true,
      session: getLiveSession(),
      runtime: peekRuntime(),
      endingCredits: true,
    };
  }

  if (!opts?.force && (phase === "waiting_obs" || phase === "live" || phase === "brb")) {
    beginEnding();

    for (const t of listAllTargets()) {
      resetTargetBackoff(t.id);
    }
    if (!mediaExists("end")) {
      console.warn(
        `[live] End stream: no end media — holding ${Math.round(getMediaTimers().endPlayMs / 1000)}s then complete`
      );
    } else {
      console.log(
        `[live] End stream: playing end media for ${Math.round(getMediaTimers().endPlayMs / 1000)}s`
      );
    }
    await reconcile();
    return {
      ok: true,
      session: getLiveSession(),
      runtime: peekRuntime(),
      endingCredits: true,
    };
  }

  return finalizeStreamSession();
}

export async function finalizeStreamSession(): Promise<{
  ok: boolean;
  session: ReturnType<typeof getLiveSession>;
  runtime: ReturnType<typeof peekRuntime>;
}> {
  const session = getLiveSession();
  for (const id of [
    ...new Set([session.youtubeMainId, session.youtubeVerticalId].filter(Boolean) as string[]),
  ]) {
    try {
      await transitionLive(id, "complete");
    } catch {
    }
  }
  for (const t of listAllTargets()) {
    stopTarget(t.id);
  }
  clearRuntime();
  clearLiveSession();
  await reconcile();
  return { ok: true, session: getLiveSession(), runtime: peekRuntime() };
}
