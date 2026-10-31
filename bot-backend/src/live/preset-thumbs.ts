import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

function thumbDir(): string {
  const dir = join(config.dataDir, "presets");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function presetThumbPath(presetId: string): string {
  return join(thumbDir(), `${presetId}.thumb`);
}

export function presetThumbMetaPath(presetId: string): string {
  return join(thumbDir(), `${presetId}.thumb.json`);
}

export function hasPresetThumbnail(presetId: string): boolean {
  try {
    return existsSync(presetThumbPath(presetId)) && readFileSync(presetThumbPath(presetId)).length > 100;
  } catch {
    return false;
  }
}

export function savePresetThumbnail(
  presetId: string,
  thumbnailBase64: string,
  thumbnailMime?: string,
  thumbnailName?: string
): { bytes: number; mime: string; name: string } {
  const dataMatch = /^data:([^;]+);base64,(.*)$/s.exec(thumbnailBase64);
  const cleaned = (
    dataMatch ? dataMatch[2] : thumbnailBase64.replace(/^data:[^;]+;base64,/, "")
  ).replace(/\s/g, "");
  let mime = (dataMatch?.[1] || thumbnailMime || "image/jpeg").split(";")[0].trim().toLowerCase();
  if (mime === "image/jpg") mime = "image/jpeg";
  if (mime !== "image/jpeg" && mime !== "image/png") {
    throw Object.assign(new Error("thumbnail must be JPEG or PNG"), { statusCode: 400 });
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length < 100 || buf.length > 2_000_000) {
    throw Object.assign(new Error("thumbnail size out of range"), { statusCode: 400 });
  }
  const ext = mime === "image/png" ? "png" : "jpg";
  const name = String(thumbnailName || "")
    .trim()
    .replace(/[^\w.\- ()[\]]+/g, "_")
    .slice(0, 120) || `thumbnail.${ext}`;
  writeFileSync(presetThumbPath(presetId), buf);
  writeFileSync(presetThumbMetaPath(presetId), JSON.stringify({ mime, name, bytes: buf.length }));
  return { bytes: buf.length, mime, name };
}

export function loadPresetThumbnail(presetId: string): {
  thumbnailBase64: string;
  thumbnailMime: string;
  thumbnailName: string;
  thumbnailBytes: number;
} | null {
  if (!hasPresetThumbnail(presetId)) return null;
  const buf = readFileSync(presetThumbPath(presetId));
  let mime = "image/jpeg";
  let name = "";
  let metaBytes = 0;
  try {
    const meta = JSON.parse(readFileSync(presetThumbMetaPath(presetId), "utf8")) as {
      mime?: string;
      name?: string;
      bytes?: number;
    };
    if (meta.mime) mime = meta.mime;
    if (meta.name) name = String(meta.name).slice(0, 120);
    if (typeof meta.bytes === "number" && meta.bytes > 0) metaBytes = meta.bytes;
  } catch {}
  const bytes = metaBytes || buf.length;
  if (!name) name = mime === "image/png" ? "thumbnail.png" : "thumbnail.jpg";
  return {
    thumbnailBase64: `data:${mime};base64,${buf.toString("base64")}`,
    thumbnailMime: mime,
    thumbnailName: name,
    thumbnailBytes: bytes,
  };
}


export function getPresetThumbnailInfo(presetId: string): {
  name: string;
  bytes: number;
  mime: string;
} | null {
  if (!hasPresetThumbnail(presetId)) return null;
  try {
    const buf = readFileSync(presetThumbPath(presetId));
    let mime = "image/jpeg";
    let name = "";
    let bytes = buf.length;
    try {
      const meta = JSON.parse(readFileSync(presetThumbMetaPath(presetId), "utf8")) as {
        mime?: string;
        name?: string;
        bytes?: number;
      };
      if (meta.mime) mime = meta.mime;
      if (meta.name) name = String(meta.name).slice(0, 120);
      if (typeof meta.bytes === "number" && meta.bytes > 0) bytes = meta.bytes;
    } catch {}
    if (!name) name = mime === "image/png" ? "thumbnail.png" : "thumbnail.jpg";
    return { name, bytes, mime };
  } catch {
    return null;
  }
}

export function deletePresetThumbnail(presetId: string): void {
  for (const p of [presetThumbPath(presetId), presetThumbMetaPath(presetId)]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {}
  }
}
