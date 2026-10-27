import { test } from "node:test";
import assert from "node:assert/strict";

// shortcut: set secrets before importing modules that read config at call-time
process.env.MASTER_KEY = "test-master-key-32bytes-minimum!!";
process.env.BOOTSTRAP_TOKEN = "bootstrap-test-token!!";
process.env.JWT_ACCESS_SECRET = "access-secret-test-32b!!!!!!";
process.env.JWT_REFRESH_SECRET = "refresh-secret-test-32b!!!!!";

const { encrypt, decrypt, maskKey } = await import("./crypto.js");

test("encrypt roundtrip", () => {
  const plain = "live_twitch_secret_key_abc";
  assert.equal(decrypt(encrypt(plain)), plain);
});

test("maskKey hides middle", () => {
  assert.equal(maskKey("abcdefghij"), "abc…hij");
});
