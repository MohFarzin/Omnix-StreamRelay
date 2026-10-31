import type { FastifyInstance } from "fastify";
import {
  applyLivePreset,
  createStreamSession,
  endStreamSession,
  startStreamSession,
} from "./apply.js";
import { autoAddConnectedDestinations } from "./destinations.js";
import {
  deleteLivePreset,
  listLivePresets,
  setDefaultLivePreset,
  updateLivePreset,
  upsertLivePreset,
} from "./presets.js";
import {
  deletePresetThumbnail,
  getPresetThumbnailInfo,
  loadPresetThumbnail,
  savePresetThumbnail,
} from "./preset-thumbs.js";
import { getLiveSession } from "./session.js";
import { peekRuntime } from "./runtime.js";
import {
  deleteMedia,
  mediaStatus,
  saveMediaUpload,
  setMediaTimers,
  type MediaSlot,
} from "./media.js";
import { Readable } from "node:stream";

const MEDIA_BODY = 120 * 1024 * 1024;

export async function registerLiveRoutes(app: FastifyInstance): Promise<void> {

  for (const ct of ["video/mp4", "video/webm", "video/quicktime", "application/octet-stream"]) {
    try {
      app.addContentTypeParser(ct, { parseAs: "buffer", bodyLimit: MEDIA_BODY }, (_req, body, done) => {
        done(null, body);
      });
    } catch {
    }
  }

  app.get(
    "/api/v1/live/session",
    { logLevel: "warn" },
    async () => ({
      session: getLiveSession(),
      runtime: peekRuntime(),
      media: mediaStatus(),
    })
  );

  app.get("/api/v1/live/media", async () => mediaStatus());

  app.patch<{ Body: Record<string, unknown> }>("/api/v1/live/media/timers", async (req, reply) => {
    try {
      const body = req.body || {};
      const timers = setMediaTimers({
        startWaitMs:
          body.startWaitMs != null
            ? Number(body.startWaitMs)
            : body.startWaitSec != null
              ? Number(body.startWaitSec) * 1000
              : body.startWaitMin != null
                ? Number(body.startWaitMin) * 60_000
                : undefined,
        brbWaitMs:
          body.brbWaitMs != null
            ? Number(body.brbWaitMs)
            : body.brbWaitSec != null
              ? Number(body.brbWaitSec) * 1000
              : body.brbWaitMin != null
                ? Number(body.brbWaitMin) * 60_000
                : undefined,
        endPlayMs:
          body.endPlayMs != null
            ? Number(body.endPlayMs)
            : body.endPlaySec != null
              ? Number(body.endPlaySec) * 1000
              : undefined,
      });
      return { ok: true, timers };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{ Params: { slot: string } }>("/api/v1/live/media/:slot", {
    bodyLimit: MEDIA_BODY,
    handler: async (req, reply) => {
      try {
        const slot = String(req.params.slot || "") as MediaSlot;
        const buf = req.body as Buffer | undefined;
        if (!Buffer.isBuffer(buf) || buf.length < 1000) {
          return reply.code(400).send({ error: "POST raw video body (mp4/webm, under 120MB)" });
        }
        const saved = await saveMediaUpload(slot, Readable.from(buf));
        return { ok: true, slot, ...saved, ...mediaStatus() };
      } catch (e) {
        const err = e as Error & { statusCode?: number };
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    },
  });

  app.delete<{ Params: { slot: string } }>("/api/v1/live/media/:slot", async (req, reply) => {
    try {
      deleteMedia(String(req.params.slot) as MediaSlot);
      return { ok: true, ...mediaStatus() };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{
    Body: {
      presetId?: string;
      draft?: Record<string, unknown>;
    };
  }>("/api/v1/live/session/create", async (req, reply) => {
    try {
      return await createStreamSession({
        presetId: req.body?.presetId ? String(req.body.presetId) : undefined,
        draft: req.body?.draft,
      });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post("/api/v1/live/session/start", async (req, reply) => {
    try {
      return await startStreamSession();
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{ Body: { force?: boolean } }>("/api/v1/live/session/end", async (req, reply) => {
    try {
      return await endStreamSession({ force: Boolean(req.body?.force) });
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.get("/api/v1/live/presets", async () => listLivePresets());

  app.post<{ Body: Record<string, unknown> }>("/api/v1/live/presets", async (req, reply) => {
    try {
      const body = { ...(req.body || {}) };

      delete body.thumbnailBase64;
      const { preset, created } = upsertLivePreset(body);
      const info = getPresetThumbnailInfo(preset.id);
      return {
        ok: true,
        created,
        preset: {
          ...preset,
          hasThumbnail: Boolean(info),
          thumbnailName: info?.name,
          thumbnailBytes: info?.bytes,
        },
        ...listLivePresets(),
      };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/v1/live/presets/:id",
    async (req, reply) => {
      try {
        const id = String(req.params.id);
        const body = { ...(req.body || {}) };
        delete body.thumbnailBase64;
        const preset = updateLivePreset(id, body);
        if (body.clearThumbnail === true) deletePresetThumbnail(id);
        setDefaultLivePreset(id);
        const info = getPresetThumbnailInfo(id);
        return {
          ok: true,
          preset: {
            ...preset,
            hasThumbnail: Boolean(info),
            thumbnailName: info?.name,
            thumbnailBytes: info?.bytes,
          },
          ...listLivePresets(),
        };
      } catch (e) {
        const err = e as Error & { statusCode?: number };
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  app.put<{
    Params: { id: string };
    Body: { thumbnailBase64?: string; thumbnailMime?: string; thumbnailName?: string };
  }>(
    "/api/v1/live/presets/:id/thumbnail",
    { bodyLimit: 4 * 1024 * 1024 },
    async (req, reply) => {
      try {
        const id = String(req.params.id);
        const list = listLivePresets();
        if (!list.presets.some((p) => p.id === id)) {
          return reply.code(404).send({ error: "preset not found" });
        }
        const b64 = String(req.body?.thumbnailBase64 || "");
        if (b64.length < 100) {
          return reply.code(400).send({ error: "thumbnailBase64 required" });
        }
        const saved = savePresetThumbnail(
          id,
          b64.slice(0, 3_500_000),
          req.body?.thumbnailMime ? String(req.body.thumbnailMime).slice(0, 64) : undefined,
          req.body?.thumbnailName ? String(req.body.thumbnailName).slice(0, 120) : undefined
        );
        setDefaultLivePreset(id);
        console.log(`[live] thumbnail saved preset=${id} name=${saved.name} bytes=${saved.bytes}`);
        return {
          ok: true,
          thumbnailName: saved.name,
          thumbnailBytes: saved.bytes,
          thumbnailMime: saved.mime,
          ...listLivePresets(),
        };
      } catch (e) {
        const err = e as Error & { statusCode?: number };
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
    }
  );

  app.get<{ Params: { id: string } }>("/api/v1/live/presets/:id/thumbnail", async (req, reply) => {
    const thumb = loadPresetThumbnail(String(req.params.id));
    if (!thumb) return reply.code(404).send({ error: "no thumbnail" });
    return thumb;
  });

  app.delete<{ Params: { id: string } }>("/api/v1/live/presets/:id", async (req, reply) => {
    try {
      deleteLivePreset(String(req.params.id));
      return { ok: true, ...listLivePresets() };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/live/presets/:id/default", async (req, reply) => {
    try {
      setDefaultLivePreset(String(req.params.id));
      return { ok: true, ...listLivePresets() };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post<{
    Body: {
      presetId?: string;
      forceAll?: boolean;
      draft?: Record<string, unknown>;
      platforms?: Array<"youtube" | "twitch" | "kick">;
    };
  }>("/api/v1/live/apply", async (req, reply) => {
    try {
      const result = await applyLivePreset({
        presetId: req.body?.presetId ? String(req.body.presetId) : undefined,
        draft: req.body?.draft,
        forceAll: req.body?.forceAll !== false,
        platforms: req.body?.platforms,
      });
      return result;
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });

  app.post("/api/v1/live/destinations/auto-add", async (req, reply) => {
    try {
      const result = await autoAddConnectedDestinations();
      return { ok: true, ...result };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
  });
}
