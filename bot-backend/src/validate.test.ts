import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLane, assertTargetId, normalizeIngestUrl } from "./validate.js";

test("reject bad target id", () => {
  assert.throws(() => assertTargetId("../x"));
  assert.equal(assertTargetId("youtube"), "youtube");
});

test("kick url gets /app and rtmps :443", () => {
  const u = normalizeIngestUrl("rtmp://fa723fc1b171.global-contribute.live-video.net", "kick");
  assert.equal(u, "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app");
});

test("kick strips key glued onto server url", () => {
  const u = normalizeIngestUrl(
    "rtmps://fa723fc1b171.global-contribute.live-video.net/app/sk_us-west-2_ABC",
    "kick"
  );
  assert.equal(u, "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app");
});

test("lane parse", () => {
  assert.equal(assertLane("vertical"), "vertical");
  assert.equal(assertLane("main"), "main");
});
