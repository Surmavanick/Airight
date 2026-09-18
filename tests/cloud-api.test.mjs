import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_BODY_BYTES,
  float32LeToWav,
  handleDetection,
  handleStatus,
  normalizeImageProvider,
  normalizeTextProvider,
  normalizeVoiceProvider,
  policyBucket,
} from "../lib/cloud-api.mjs";

const env = { AIORNOT_API_KEY: "test-provider-key", ADMIN_PASSWORD: "test-console-key", AIORNOT_TIMEOUT_MS: "5000" };

function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Origin", "https://airight.example");
  return new Request(`https://airight.example${path}`, { ...options, headers });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("25/75 policy boundaries are explicit", () => {
  assert.equal(policyBucket(0.25), "likely_human");
  assert.equal(policyBucket(0.250001), "inconclusive");
  assert.equal(policyBucket(0.749999), "inconclusive");
  assert.equal(policyBucket(0.75), "likely_ai");
});

test("image response keeps the provider score and never invents a local comparison", () => {
  const result = normalizeImageProvider({
    id: "img-report",
    report: {
      ai_generated: {
        verdict: "human",
        ai: { confidence: 0.497 },
        human: { confidence: 0.503 },
        generator: { four_o: { confidence: 0.457, is_detected: false } },
      },
      meta: { width: 640, height: 480 },
    },
  });
  assert.equal(result.ai_score, 0.497);
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.providerSignals.length, 1);
  assert.equal(result.providerSignals[0].requestId, "img-report");
  assert.equal(result.model.localComparison, false);
});

test("text annotations become high-score passages", () => {
  const text = "word ".repeat(70);
  const result = normalizeTextProvider({
    id: "txt-report",
    report: { ai_text: { confidence: 0.82, is_detected: true, annotations: [["high block", 0.91], ["low block", 0.1]] } },
    metadata: { word_count: 70 },
  }, text);
  assert.equal(result.fakePercentage, 82);
  assert.equal(result.label, "likely_ai");
  assert.deepEqual(result.h, ["high block"]);
  assert.equal(result.segments.length, 2);
});

test("voice verdict confidence is converted into an AI-class score", () => {
  const result = normalizeVoiceProvider({ id: "voice-report", report: { verdict: "human", confidence: 0.91, duration: 4 } }, { sampleCount: 64_000, duration: 4 });
  assert.equal(result.ai_score, 0.09);
  assert.equal(result.verdict, "likely_human");
  assert.equal(result.providerSignals[0].requestId, "voice-report");
});

test("Float32LE audio is encoded as a valid mono PCM16 WAV", () => {
  const floats = new Float32Array([-1, -0.5, 0, 0.5, 1]);
  const wav = float32LeToWav(Buffer.from(floats.buffer), 16_000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 10);
  assert.equal(wav.readInt16LE(44), -32768);
  assert.equal(wav.readInt16LE(52), 32767);
});

test("status is readiness-only and requires console authorization", async () => {
  const locked = await handleStatus(request("/api/status"), { env });
  const lockedBody = await locked.json();
  assert.equal(locked.status, 200);
  assert.equal(lockedBody.worker.preflight.ready, true);
  assert.equal(lockedBody.authRequired, true);
  assert.equal(lockedBody.authorized, false);
  assert.equal(lockedBody.providers.image.localComparison, false);

  const unlocked = await handleStatus(request("/api/status", { headers: { "X-Admin-Key": env.ADMIN_PASSWORD } }), { env });
  assert.equal((await unlocked.json()).authorized, true);
});

test("unauthorized and invalid image requests spend no provider call", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({}); };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

  const locked = await handleDetection(request("/api/detect/image", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", "X-File-Name": "test.jpg" },
    body: jpeg,
  }), { env, fetchImpl });
  assert.equal(locked.status, 401);

  const invalid = await handleDetection(request("/api/detect/image", {
    method: "POST",
    headers: { "Content-Type": "image/png", "X-File-Name": "test.png", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: jpeg,
  }), { env, fetchImpl });
  assert.equal(invalid.status, 415);
  const truncated = await handleDetection(request("/api/detect/image", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", "X-File-Name": "test.jpg", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: jpeg,
  }), { env, fetchImpl });
  assert.equal(truncated.status, 422);
  const headerOnlyWebp = Buffer.alloc(30);
  headerOnlyWebp.write("RIFF", 0, "ascii");
  headerOnlyWebp.writeUInt32LE(22, 4);
  headerOnlyWebp.write("WEBPVP8X", 8, "ascii");
  headerOnlyWebp.writeUInt32LE(10, 16);
  headerOnlyWebp[24] = 127;
  headerOnlyWebp[27] = 127;
  const invalidWebp = await handleDetection(request("/api/detect/image", {
    method: "POST",
    headers: { "Content-Type": "image/webp", "X-File-Name": "test.webp", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: headerOnlyWebp,
  }), { env, fetchImpl });
  assert.equal(invalidWebp.status, 422);
  assert.equal(calls, 0);
});

test("valid image request sends one metered multipart call and normalizes it", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({
      id: "real-id",
      api_key: env.AIORNOT_API_KEY,
      debug: `provider=${env.AIORNOT_API_KEY}`,
      report: { ai_generated: { verdict: "ai", ai: { confidence: 0.88 }, human: { confidence: 0.12 }, generator: {} }, meta: { width: 1, height: 1 } },
    });
  };
  const jpeg = await readFile(new URL("../assets/img/hero.jpg", import.meta.url));
  const response = await handleDetection(request("/api/detect/image", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", "X-File-Name": "test.jpg", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: jpeg,
  }), { env, fetchImpl });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.ai_score, 0.88);
  assert.equal(body.data.verdict, "likely_ai");
  assert.equal(body.raw.providerResponse.api_key, "[redacted]");
  assert.equal(body.raw.providerResponse.debug, "provider=[redacted]");
  assert.doesNotMatch(JSON.stringify(body), new RegExp(env.AIORNOT_API_KEY));
  assert.match(captured.url, /\/v2\/image\/sync\?only=ai_generated&external_id=aright-/);
  assert.ok(captured.init.body.get("image") instanceof Blob);
  assert.equal(captured.init.headers.Authorization, `Bearer ${env.AIORNOT_API_KEY}`);
});

test("TXT document delegates to the annotated text endpoint", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), init };
    return jsonResponse({
      id: "text-id",
      report: { ai_text: { confidence: 0.4, is_detected: false, annotations: [] } },
      metadata: { word_count: 70 },
    });
  };
  const text = "This is a sufficiently long plain text sample for the official detector. ".repeat(6);
  const response = await handleDetection(request("/api/detect/file", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-File-Name": "sample.txt", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: text,
  }), { env, fetchImpl });
  assert.equal(response.status, 200);
  assert.match(captured.url, /\/v2\/text\/sync\?include_annotations=true&external_id=aright-/);
  assert.ok(captured.init.body instanceof FormData);
  assert.equal(captured.init.body.get("text"), text.trim());
});

test("too-few-word text is rejected before a provider call", async () => {
  let calls = 0;
  const text = `${"longword ".repeat(62)}${"x".repeat(300)}`;
  const response = await handleDetection(request("/api/detect/text", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: JSON.stringify({ text }),
  }), { env, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });
  assert.equal(response.status, 422);
  assert.equal(calls, 0);
});

test("large non-ASCII text response stays below Vercel's 4 MiB safety budget", async () => {
  const block = "ა".repeat(7_000);
  const text = Array.from({ length: 64 }, () => block).join(" ");
  const response = await handleDetection(request("/api/detect/text", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: JSON.stringify({ text }),
  }), {
    env,
    fetchImpl: async () => jsonResponse({
      id: "large-text-id",
      report: { ai_text: { confidence: 0.8, is_detected: true, annotations: [[text, 0.8]] } },
      metadata: { word_count: 64 },
    }),
  });
  const body = await response.text();
  const parsed = JSON.parse(body);
  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(body, "utf8") < MAX_BODY_BYTES);
  assert.equal(parsed.data.annotationsTruncated, true);
  assert.equal(parsed.data.flaggedTotal, 1);
  assert.equal(parsed.data.annotationStats.totalCharacters, text.length);
});

test("body limit is enforced before a provider call", async () => {
  let calls = 0;
  const response = await handleDetection(request("/api/detect/image", {
    method: "POST",
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(MAX_BODY_BYTES + 1),
      "X-Admin-Key": env.ADMIN_PASSWORD,
    },
    body: Buffer.from([0xff, 0xd8, 0xff]),
  }), { env, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

test("cross-origin calls are rejected before provider access", async () => {
  let calls = 0;
  const response = await handleDetection(new Request("https://airight.example/api/detect/text", {
    method: "POST",
    headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: JSON.stringify({ text: "word ".repeat(70) }),
  }), { env, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});
