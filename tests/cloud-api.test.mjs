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
const backupEnv = {
  ...env,
  AIORNOT_API_KEY_BACKUP: `${env.AIORNOT_API_KEY}-backup`,
  AIORNOT_MAX_REQUESTS_PER_MINUTE: "1000",
  AIORNOT_MAX_CONCURRENT: "8",
};

const validText = "This is a sufficiently long plain text sample for the official detector. ".repeat(6);

function textRequest(text = validText) {
  return request("/api/detect/text", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: JSON.stringify({ text }),
  });
}

function textProviderPayload(id = "text-id", confidence = 0.82) {
  return {
    id,
    report: { ai_text: { confidence, is_detected: confidence >= 0.5, annotations: [] } },
    metadata: { word_count: 70 },
  };
}

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
  assert.equal(lockedBody.providers.audio.configured, false);
  assert.equal(lockedBody.capabilities.audioSpeech, false);

  const unlocked = await handleStatus(request("/api/status", { headers: { "X-Admin-Key": env.ADMIN_PASSWORD } }), { env });
  assert.equal((await unlocked.json()).authorized, true);
});

test("hosted audio is fail-closed unless the account capability is explicitly enabled", async () => {
  let calls = 0;
  const response = await handleDetection(request("/api/detect/audio", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Sample-Rate": "16000", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: Buffer.from(new Float32Array([0, 0.1, -0.1]).buffer),
  }), { env, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.type, "AUDIO_DETECTOR_UNAVAILABLE");
  assert.match(body.error, /local Spectra-AASIST3/i);
  assert.equal(calls, 0);

  const enabledStatus = await handleStatus(request("/api/status"), {
    env: { ...env, AIORNOT_AUDIO_ENABLED: "true" },
  });
  const enabledBody = await enabledStatus.json();
  assert.equal(enabledBody.providers.audio.configured, true);
  assert.equal(enabledBody.capabilities.audioSpeech, true);
});

test("provider model-disabled 403 is not mislabeled as a bad API key", async () => {
  const enabledEnv = { ...env, AIORNOT_AUDIO_ENABLED: "true" };
  const samples = new Float32Array(16_000);
  const response = await handleDetection(request("/api/detect/audio", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Sample-Rate": "16000", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: Buffer.from(samples.buffer),
  }), {
    env: enabledEnv,
    fetchImpl: async () => jsonResponse({ detail: "model ai_voice disabled for plan_version 14" }, 403),
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.type, "PROVIDER_MODEL_UNAVAILABLE");
  assert.match(body.error, /voice detection is not enabled/i);
  assert.doesNotMatch(body.error, /rejected the configured API key/i);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(env.AIORNOT_API_KEY));
});

test("generic provider 403 is reported as access denial, not invalid credentials", async () => {
  const enabledEnv = { ...env, AIORNOT_AUDIO_ENABLED: "true" };
  const samples = new Float32Array(16_000);
  const response = await handleDetection(request("/api/detect/audio", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Sample-Rate": "16000", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: Buffer.from(samples.buffer),
  }), {
    env: enabledEnv,
    fetchImpl: async () => jsonResponse({ detail: "Forbidden for this account", api_key: env.AIORNOT_API_KEY }, 403),
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.type, "PROVIDER_ACCESS_DENIED");
  assert.match(body.error, /account plan enables the requested model/i);
  assert.doesNotMatch(body.error, /rejected the configured API key/i);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(env.AIORNOT_API_KEY));
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
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
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
  }), { env: backupEnv, fetchImpl });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(body.data.ai_score, 0.88);
  assert.equal(body.data.verdict, "likely_ai");
  assert.equal(body.raw.providerResponse.api_key, "[redacted]");
  assert.equal(body.raw.providerResponse.debug, "provider=[redacted]");
  assert.equal(body.raw.providerExecution.credentialSlot, "primary");
  assert.equal(body.raw.providerExecution.failoverUsed, false);
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

test("backup status is boolean-only, deduplicated, and still requires a primary credential", async () => {
  const configured = await handleStatus(request("/api/status"), { env: backupEnv });
  const configuredText = await configured.text();
  const configuredBody = JSON.parse(configuredText);
  assert.equal(configuredBody.ready, true);
  assert.equal(configuredBody.providerFailover.configured, true);
  assert.doesNotMatch(configuredText, new RegExp(backupEnv.AIORNOT_API_KEY));
  assert.doesNotMatch(configuredText, new RegExp(backupEnv.AIORNOT_API_KEY_BACKUP));

  const duplicate = await handleStatus(request("/api/status"), {
    env: { ...backupEnv, AIORNOT_API_KEY_BACKUP: backupEnv.AIORNOT_API_KEY },
  });
  assert.equal((await duplicate.json()).providerFailover.configured, false);

  const backupOnly = await handleStatus(request("/api/status"), {
    env: { ...backupEnv, AIORNOT_API_KEY: "" },
  });
  const backupOnlyBody = await backupOnly.json();
  assert.equal(backupOnlyBody.ready, false);
  assert.equal(backupOnlyBody.providerFailover.configured, false);
});

test("401 failover rebuilds image multipart and records sanitized backup execution", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return new Response("unauthorized", { status: 401 });
    return jsonResponse({
      id: "backup-image-id",
      debug: `${backupEnv.AIORNOT_API_KEY}|${backupEnv.AIORNOT_API_KEY_BACKUP}`,
      report: { ai_generated: { verdict: "ai", ai: { confidence: 0.91 }, human: { confidence: 0.09 }, generator: {} } },
    });
  };
  const jpeg = await readFile(new URL("../assets/img/hero.jpg", import.meta.url));
  const response = await handleDetection(request("/api/detect/image", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", "X-File-Name": "test.jpg", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: jpeg,
  }), { env: backupEnv, fetchImpl });
  const body = await response.json();
  const serialized = JSON.stringify(body);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${backupEnv.AIORNOT_API_KEY}`);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${backupEnv.AIORNOT_API_KEY_BACKUP}`);
  assert.notEqual(calls[0].init.body, calls[1].init.body);
  assert.ok(calls[0].init.body.get("image") instanceof Blob);
  assert.ok(calls[1].init.body.get("image") instanceof Blob);
  assert.equal(body.raw.providerExecution.credentialSlot, "backup");
  assert.equal(body.raw.providerExecution.attemptCount, 2);
  assert.equal(body.raw.providerExecution.failoverUsed, true);
  assert.equal(body.raw.providerExecution.failoverReason, "PROVIDER_AUTH_FAILED");
  assert.doesNotMatch(serialized, new RegExp(backupEnv.AIORNOT_API_KEY));
  assert.doesNotMatch(serialized, new RegExp(backupEnv.AIORNOT_API_KEY_BACKUP));
});

test("402 and 403 provider rejections use the backup with explicit internal reasons", async () => {
  for (const scenario of [
    { status: 402, payload: { error: "credits" }, reason: "PROVIDER_CREDITS_UNAVAILABLE" },
    { status: 403, payload: { error: "forbidden" }, reason: "PROVIDER_ACCESS_DENIED" },
  ]) {
    const calls = [];
    const response = await handleDetection(textRequest(), {
      env: backupEnv,
      fetchImpl: async (_url, init) => {
        calls.push(init);
        return calls.length === 1
          ? jsonResponse(scenario.payload, scenario.status)
          : jsonResponse(textProviderPayload(`backup-${scenario.status}`));
      },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.Authorization, `Bearer ${backupEnv.AIORNOT_API_KEY}`);
    assert.equal(calls[1].headers.Authorization, `Bearer ${backupEnv.AIORNOT_API_KEY_BACKUP}`);
    assert.equal(calls[0].body.get("text"), validText.trim());
    assert.equal(calls[1].body.get("text"), validText.trim());
    assert.equal(body.raw.providerExecution.failoverReason, scenario.reason);
  }
});

test("ambiguous or shared failures never trigger credential failover", async () => {
  const scenarios = [
    { name: "input", responder: () => jsonResponse({ error: "bad input" }, 422), type: "PROVIDER_REJECTED_INPUT" },
    { name: "rate", responder: () => jsonResponse({ error: "rate" }, 429), type: "PROVIDER_RATE_LIMIT" },
    { name: "server", responder: () => jsonResponse({ error: "server" }, 503), type: "PROVIDER_HTTP_503" },
    { name: "invalid-json", responder: () => new Response("not-json", { status: 200 }), type: "INVALID_PROVIDER_RESPONSE" },
    { name: "network", responder: () => { throw new Error("network down"); }, type: "PROVIDER_UNREACHABLE" },
    { name: "timeout", responder: () => { const error = new Error("timeout"); error.name = "TimeoutError"; throw error; }, type: "PROVIDER_TIMEOUT" },
  ];
  for (const scenario of scenarios) {
    let calls = 0;
    const response = await handleDetection(textRequest(), {
      env: backupEnv,
      fetchImpl: async () => {
        calls += 1;
        return scenario.responder();
      },
    });
    const body = await response.json();
    assert.equal(calls, 1, `${scenario.name} should not use the backup credential`);
    assert.equal(body.type, scenario.type);
  }
});

test("both rejected credentials return one generic sanitized failure", async () => {
  const authorizations = [];
  const response = await handleDetection(textRequest(), {
    env: backupEnv,
    fetchImpl: async (_url, init) => {
      authorizations.push(init.headers.Authorization);
      const key = authorizations.length === 1 ? backupEnv.AIORNOT_API_KEY : backupEnv.AIORNOT_API_KEY_BACKUP;
      return jsonResponse({ authorization: key, detail: `rejected ${key}` }, authorizations.length === 1 ? 401 : 403);
    },
  });
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(authorizations.length, 2);
  assert.equal(body.type, "PROVIDER_ACCESS_DENIED");
  assert.doesNotMatch(text, new RegExp(backupEnv.AIORNOT_API_KEY));
  assert.doesNotMatch(text, new RegExp(backupEnv.AIORNOT_API_KEY_BACKUP));
});
