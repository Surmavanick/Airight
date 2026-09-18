import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const TEXT_MIN_CHARS = 250;
export const TEXT_MIN_WORDS = 64;
export const TEXT_MAX_CHARS = 500_000;
export const AUDIO_SAMPLE_RATE = 16_000;

const IMAGE_ENDPOINT = "https://api.aiornot.com/v2/image/sync";
const TEXT_ENDPOINT = "https://api.aiornot.com/v2/text/sync";
const VOICE_ENDPOINT = "https://api.aiornot.com/v1/reports/voice";
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const DETECT_KINDS = new Set(["text", "file", "image", "audio"]);
const POLICY = "Provider-only screening: <=25% likely human, >=75% likely AI, otherwise inconclusive";
const usage = globalThis.__arightProviderUsage || { active: 0, timestamps: [] };
globalThis.__arightProviderUsage = usage;

export class ApiError extends Error {
  constructor(message, status = 500, code = "INTERNAL_ERROR") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function finiteScore(value, label = "score") {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new ApiError(`AI or Not returned an invalid ${label}.`, 502, "INVALID_PROVIDER_RESPONSE");
  }
  return score;
}

export function policyBucket(score) {
  if (score >= 0.75) return "likely_ai";
  if (score <= 0.25) return "likely_human";
  return "inconclusive";
}

function policyLabel(modality, bucket) {
  const subject = { image: "image", text: "text", audio: "voice" }[modality] || "asset";
  if (bucket === "likely_ai") return `AI or Not found a high AI-${subject} signal`;
  if (bucket === "likely_human") return `AI or Not found a low AI-${subject} signal`;
  return `AI or Not's ${subject} result is inconclusive — manual review required`;
}

function getConfig(env = process.env) {
  const parsedTimeout = Number(env.AIORNOT_TIMEOUT_MS);
  const parsedRate = Number(env.AIORNOT_MAX_REQUESTS_PER_MINUTE);
  const parsedConcurrent = Number(env.AIORNOT_MAX_CONCURRENT);
  return {
    apiKey: String(env.AIORNOT_API_KEY || "").trim(),
    adminPassword: String(env.ADMIN_PASSWORD || ""),
    audioEnabled: /^(1|true|yes|on)$/i.test(String(env.AIORNOT_AUDIO_ENABLED || "").trim()),
    timeoutMs: Number.isFinite(parsedTimeout) ? clamp(parsedTimeout, 5_000, 125_000) : 120_000,
    maxRequestsPerMinute: Number.isFinite(parsedRate) ? Math.max(1, Math.floor(parsedRate)) : 12,
    maxConcurrent: Number.isFinite(parsedConcurrent) ? Math.max(1, Math.floor(parsedConcurrent)) : 2,
  };
}

function reserveProviderRequest(config, now = Date.now()) {
  usage.timestamps = usage.timestamps.filter((timestamp) => now - timestamp < 60_000);
  if (usage.active >= config.maxConcurrent) throw new ApiError("Too many detector checks are running. Wait for one to finish.", 429, "APP_CONCURRENCY_LIMIT");
  if (usage.timestamps.length >= config.maxRequestsPerMinute) throw new ApiError("Aright's provider request limit was reached. Wait before retrying.", 429, "APP_RATE_LIMIT");
  usage.active += 1;
  usage.timestamps.push(now);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    usage.active = Math.max(0, usage.active - 1);
  };
}

function constantTimeEqual(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthorized(request, config) {
  return Boolean(config.adminPassword) && constantTimeEqual(request.headers.get("x-admin-key"), config.adminPassword);
}

function requestOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return "";
  if (origin === "null") throw new ApiError("This API must be opened from its deployed site.", 403, "ORIGIN_FORBIDDEN");
  let expected;
  try {
    expected = new URL(request.url).origin;
  } catch {
    throw new ApiError("Invalid request URL.", 400, "INVALID_URL");
  }
  if (origin !== expected) throw new ApiError("Cross-origin model requests are not allowed.", 403, "ORIGIN_FORBIDDEN");
  return origin;
}

function responseHeaders(request, extra = {}) {
  const headers = {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
    ...extra,
  };
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    try {
      if (origin === new URL(request.url).origin) headers["Access-Control-Allow-Origin"] = origin;
    } catch {
      // The request will be rejected separately; do not emit CORS headers.
    }
  }
  return headers;
}

function jsonResponse(request, status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(request, extraHeaders),
  });
}

function errorResponse(request, error) {
  if (error instanceof ApiError) {
    return jsonResponse(request, error.status, { error: error.message, type: error.code });
  }
  return jsonResponse(request, 500, {
    error: "The analysis could not be completed. Try again later.",
    type: "INTERNAL_ERROR",
  });
}

function preflight(request) {
  try {
    const origin = requestOrigin(request);
    return new Response(null, {
      status: 204,
      headers: responseHeaders(request, {
        ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-File-Name, X-Sample-Rate",
        "Access-Control-Max-Age": "600",
      }),
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}

function requireCloudConfig(config) {
  if (!config.apiKey) {
    throw new ApiError("The cloud detector is not configured.", 503, "PROVIDER_NOT_CONFIGURED");
  }
  if (!config.adminPassword) {
    throw new ApiError("The cloud console is locked until ADMIN_PASSWORD is configured.", 503, "ADMIN_PASSWORD_REQUIRED");
  }
}

function requireAuthorization(request, config) {
  if (!isAuthorized(request, config)) {
    throw new ApiError("The console access key is missing or wrong.", 401, "UNAUTHORIZED");
  }
}

export function safeFileName(header, fallback = "upload") {
  let name = fallback;
  try {
    name = decodeURIComponent(String(header || fallback));
  } catch {
    name = fallback;
  }
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 180) || fallback;
}

async function readBytes(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError("Hosted uploads are limited to 4 MB.", 413, "BODY_TOO_LARGE");
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) {
    throw new ApiError("Hosted uploads are limited to 4 MB.", 413, "BODY_TOO_LARGE");
  }
  return bytes;
}

function canonicalImageMime(value) {
  const mime = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mime === "image/jpg" || mime === "image/pjpeg" ? "image/jpeg" : mime;
}

export function imageMimeFromBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

function jpegDimensions(bytes) {
  const eoi = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]));
  if (bytes.length < 32 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || eoi < 16) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let dimensions = null;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (sof.has(marker) && length >= 7) {
      dimensions = { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    if (marker === 0xda) {
      const scanStart = offset + length;
      return dimensions && eoi >= scanStart + 2 ? dimensions : null;
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes) {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const declaredSize = bytes.readUInt32LE(4) + 8;
  if (declaredSize !== bytes.length) return null;
  let offset = 12;
  let dimensions = null;
  let imagePayload = false;
  while (offset + 8 <= bytes.length) {
    const chunk = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    const end = data + size;
    const paddedEnd = end + (size & 1);
    if (end > bytes.length || paddedEnd > bytes.length) return null;
    if (chunk === "VP8X" && size >= 10) {
      dimensions = {
        width: 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16),
        height: 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16),
      };
    } else if (chunk === "VP8 " && size >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      dimensions ||= { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
      imagePayload = true;
    } else if (chunk === "VP8L" && size >= 5 && bytes[data] === 0x2f) {
      dimensions ||= {
        width: 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8),
        height: 1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10),
      };
      imagePayload = true;
    } else if (chunk === "ANMF" && size >= 16) {
      imagePayload = true;
    }
    offset = paddedEnd;
  }
  return offset === bytes.length && imagePayload ? dimensions : null;
}

function pngDimensions(bytes) {
  if (bytes.length < 45) return null;
  let offset = 8;
  let dimensions = null;
  let sawData = false;
  let first = true;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = offset + 8;
    const next = data + length + 4;
    if (next > bytes.length) return null;
    if (first && (type !== "IHDR" || length !== 13)) return null;
    if (type === "IHDR") dimensions = { width: bytes.readUInt32BE(data), height: bytes.readUInt32BE(data + 4) };
    if (type === "IDAT") sawData = true;
    if (type === "IEND") return length === 0 && sawData && next === bytes.length ? dimensions : null;
    first = false;
    offset = next;
  }
  return null;
}

export function imageDimensionsFromBytes(bytes, mime) {
  if (mime === "image/png") return pngDimensions(bytes);
  if (mime === "image/jpeg") return jpegDimensions(bytes);
  if (mime === "image/webp") return webpDimensions(bytes);
  return null;
}

function validateImage(bytes, declaredMime) {
  const mime = canonicalImageMime(declaredMime);
  if (!IMAGE_MIME.has(mime)) {
    throw new ApiError("Image checks support JPG, PNG, or WEBP.", 415, "UNSUPPORTED_MEDIA_TYPE");
  }
  if (imageMimeFromBytes(bytes) !== mime) {
    throw new ApiError("The uploaded bytes do not match the declared image type.", 415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const dimensions = imageDimensionsFromBytes(bytes, mime);
  if (!dimensions || !dimensions.width || !dimensions.height) {
    throw new ApiError("The image is truncated or malformed.", 422, "INVALID_IMAGE");
  }
  if (dimensions.width < 128 || dimensions.height < 128) {
    throw new ApiError("The image must be at least 128 by 128 pixels.", 422, "IMAGE_TOO_SMALL");
  }
  return mime;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function externalId(bytes) {
  return `aright-${sha256(bytes).slice(0, 24)}`;
}

function parseProviderJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError("AI or Not returned an invalid response.", 502, "INVALID_PROVIDER_RESPONSE");
  }
}

function sanitizeProviderPayload(value, secret, depth = 0) {
  if (depth > 12) return "[truncated]";
  if (typeof value === "string") return secret && value.includes(secret) ? value.replaceAll(secret, "[redacted]") : value;
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderPayload(item, secret, depth + 1));
  if (!value || typeof value !== "object") return value;
  const clean = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (/^(authorization|api[_-]?key|access[_-]?token|secret)$/i.test(key)) clean[key] = "[redacted]";
    else clean[key] = sanitizeProviderPayload(item, secret, depth + 1);
  }
  return clean;
}

function providerHttpError(status, payload) {
  const detail = (() => {
    try {
      return JSON.stringify(payload || {}).toLowerCase();
    } catch {
      return "";
    }
  })();
  const modelDisabled = status === 403 && (
    /model[^\n]{0,120}disabled/.test(detail) ||
    /disabled[^\n]{0,120}(model|plan)/.test(detail) ||
    /plan_version/.test(detail)
  );
  if (modelDisabled) {
    const voice = /ai[_ -]?voice|voice/.test(detail);
    return new ApiError(
      voice
        ? "AI or Not voice detection is not enabled for this account plan. Use Aright's local Spectra-AASIST3 console for speech screening."
        : "The requested AI or Not detector model is not enabled for this account plan.",
      503,
      "PROVIDER_MODEL_UNAVAILABLE",
    );
  }
  if (status === 401) return new ApiError("AI or Not rejected the configured API key.", 502, "PROVIDER_AUTH_FAILED");
  if (status === 403) return new ApiError("AI or Not denied access to this detector. Check that the account plan enables the requested model.", 502, "PROVIDER_ACCESS_DENIED");
  if (status === 402) return new ApiError("AI or Not credits are unavailable. Check the provider account balance.", 402, "PROVIDER_CREDITS_UNAVAILABLE");
  if (status === 413) return new ApiError("AI or Not rejected this upload as too large.", 413, "PROVIDER_FILE_TOO_LARGE");
  if (status === 415 || status === 422 || status === 400) return new ApiError("AI or Not could not analyze this content.", 422, "PROVIDER_REJECTED_INPUT");
  if (status === 429) return new ApiError("AI or Not's rate or credit limit was reached. Wait before retrying.", 429, "PROVIDER_RATE_LIMIT");
  return new ApiError("AI or Not could not complete the analysis.", 502, `PROVIDER_HTTP_${status}`);
}

async function callProvider(url, init, config, fetchImpl) {
  let response;
  const release = reserveProviderRequest(config);
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${config.apiKey}`, ...(init.headers || {}) },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new ApiError(
      timedOut ? "AI or Not took too long to respond." : "AI or Not is temporarily unreachable.",
      timedOut ? 504 : 502,
      timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE",
    );
  } finally {
    release();
  }
  const payload = sanitizeProviderPayload(parseProviderJson(await response.text()), config.apiKey);
  if (!response.ok) throw providerHttpError(response.status, payload);
  return payload;
}

function normalizeGeneratorSignals(value) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .map(([id, item]) => {
      const raw = item && typeof item === "object" ? item.confidence : item;
      const confidence = Number(raw);
      if (!Number.isFinite(confidence)) return null;
      return {
        id,
        confidence: clamp(confidence),
        isDetected: Boolean(item && typeof item === "object" ? item.is_detected : confidence >= 0.5),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);
}

export function normalizeImageProvider(payload) {
  const report = payload?.report?.ai_generated;
  if (!report || !report.ai) throw new ApiError("AI or Not returned an incomplete image report.", 502, "INVALID_PROVIDER_RESPONSE");
  const aiScore = finiteScore(report.ai.confidence, "image score");
  const humanValue = Number(report?.human?.confidence);
  const humanScore = Number.isFinite(humanValue) && humanValue >= 0 && humanValue <= 1 ? humanValue : null;
  const bucket = policyBucket(aiScore);
  const requestId = typeof payload.id === "string" ? payload.id : "";
  const providerVerdict = typeof report.verdict === "string" ? report.verdict : "";
  const meta = payload?.report?.meta && typeof payload.report.meta === "object" ? payload.report.meta : null;
  return {
    ai_score: Number(aiScore.toFixed(6)),
    label: policyLabel("image", bucket),
    verdict: bucket,
    providerVerdict,
    disagreement: false,
    providerSignals: [{
      id: "aiornot-v2-image",
      name: "AI or Not",
      ai_score: Number(aiScore.toFixed(6)),
      human_score: humanScore == null ? null : Number(humanScore.toFixed(6)),
      verdict: bucket,
      rawVerdict: providerVerdict,
      requestId,
    }],
    generators: normalizeGeneratorSignals(report.generator),
    c2pa: payload?.report?.c2pa && typeof payload.report.c2pa === "object" ? payload.report.c2pa : null,
    dimensions: meta && Number.isFinite(Number(meta.width)) && Number.isFinite(Number(meta.height))
      ? { width: Number(meta.width), height: Number(meta.height) }
      : null,
    model: {
      id: "AI or Not v2 image",
      provider: "AI or Not",
      policy: POLICY,
      scoreSemantics: "AI-class model score from one external provider; a screening signal, not proof of authorship",
      localComparison: false,
    },
  };
}

function normalizeAnnotations(value, maxTextCharacters = 60_000) {
  if (!Array.isArray(value)) return [];
  let remaining = maxTextCharacters;
  return value
    .map((item) => {
      if (remaining <= 0) return null;
      if (!Array.isArray(item) || typeof item[0] !== "string") return null;
      const score = Number(item[1]);
      if (!Number.isFinite(score) || score < 0 || score > 1) return null;
      const text = item[0].trim().slice(0, remaining);
      remaining -= text.length;
      return { text, score: Number(score.toFixed(6)) };
    })
    .filter((item) => item?.text);
}

function annotationStats(value) {
  const stats = { totalBlocks: 0, totalCharacters: 0, highScoreBlocks: 0, highScoreWords: 0 };
  if (!Array.isArray(value)) return stats;
  for (const item of value) {
    if (!Array.isArray(item) || typeof item[0] !== "string") continue;
    const score = Number(item[1]);
    if (!Number.isFinite(score) || score < 0 || score > 1) continue;
    stats.totalBlocks += 1;
    stats.totalCharacters += item[0].length;
    if (score >= 0.75) {
      stats.highScoreBlocks += 1;
      stats.highScoreWords += item[0].trim().split(/\s+/).filter(Boolean).length;
    }
  }
  return stats;
}

export function normalizeTextProvider(payload, sourceText = "") {
  const report = payload?.report?.ai_text;
  if (!report) throw new ApiError("AI or Not returned an incomplete text report.", 502, "INVALID_PROVIDER_RESPONSE");
  const aiScore = finiteScore(report.confidence, "text score");
  const bucket = policyBucket(aiScore);
  const stats = annotationStats(report.annotations);
  const annotations = normalizeAnnotations(report.annotations);
  const flagged = annotations.filter((item) => item.score >= 0.75).map((item) => item.text);
  const wordCount = Number(payload?.metadata?.word_count);
  const textWords = Number.isFinite(wordCount) ? wordCount : sourceText.trim().split(/\s+/).filter(Boolean).length;
  const retainedCharacters = annotations.reduce((sum, item) => sum + item.text.length, 0);
  return {
    fakePercentage: Number((aiScore * 100).toFixed(1)),
    feedback: policyLabel("text", bucket),
    label: bucket,
    h: flagged,
    segments: annotations,
    textWords,
    aiWords: stats.highScoreWords,
    flaggedTotal: stats.highScoreBlocks,
    annotationStats: { ...stats, retainedBlocks: annotations.length, retainedCharacters },
    annotationsTruncated: stats.totalBlocks > annotations.length || stats.totalCharacters > retainedCharacters,
    input_text: sourceText.slice(0, 60_000),
    model: {
      id: "AI or Not v2 text",
      provider: "AI or Not",
      policy: POLICY,
      scoreSemantics: "AI-text model score from one external provider; a screening signal, not proof of authorship",
      requestId: typeof payload.id === "string" ? payload.id : "",
    },
  };
}

export function float32LeToWav(bytes, sampleRate = AUDIO_SAMPLE_RATE) {
  if (sampleRate !== AUDIO_SAMPLE_RATE) {
    throw new ApiError("Cloud voice checks require 16 kHz audio samples.", 422, "INVALID_SAMPLE_RATE");
  }
  if (!bytes.length || bytes.length % 4 !== 0) {
    throw new ApiError("The decoded audio samples are empty or malformed.", 422, "INVALID_AUDIO_SAMPLES");
  }
  const sampleCount = bytes.length / 4;
  const output = Buffer.allocUnsafe(44 + sampleCount * 2);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + sampleCount * 2, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(sampleCount * 2, 40);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getFloat32(index * 4, true);
    if (!Number.isFinite(sample)) throw new ApiError("The decoded audio contains invalid samples.", 422, "INVALID_AUDIO_SAMPLES");
    const bounded = clamp(sample, -1, 1);
    const pcm = Math.round(bounded < 0 ? bounded * 32768 : bounded * 32767);
    output.writeInt16LE(pcm, 44 + index * 2);
  }
  return output;
}

export function normalizeVoiceProvider(payload, input = {}) {
  const report = payload?.report;
  if (!report || typeof report.verdict !== "string") {
    throw new ApiError("AI or Not returned an incomplete voice report.", 502, "INVALID_PROVIDER_RESPONSE");
  }
  const confidence = finiteScore(report.confidence, "voice confidence");
  const providerVerdict = report.verdict.toLowerCase();
  const aiScore = providerVerdict === "ai" ? confidence : providerVerdict === "human" ? 1 - confidence : 0.5;
  const bucket = policyBucket(aiScore);
  const requestId = typeof payload.id === "string" ? payload.id : "";
  const durationValue = Number(report.duration);
  return {
    ai_score: Number(aiScore.toFixed(6)),
    label: policyLabel("audio", bucket),
    verdict: bucket,
    providerVerdict,
    disagreement: false,
    providerSignals: [{
      id: "aiornot-v1-voice",
      name: "AI or Not Voice",
      ai_score: Number(aiScore.toFixed(6)),
      human_score: Number((1 - aiScore).toFixed(6)),
      verdict: bucket,
      rawVerdict: providerVerdict,
      requestId,
    }],
    segments: [],
    duration: Number.isFinite(durationValue) ? durationValue : input.duration,
    inputChecks: {
      browserDecoded: true,
      inputEncoding: "Float32LE mono",
      providerEncoding: "PCM16 WAV mono",
      sampleRate: AUDIO_SAMPLE_RATE,
      sampleCount: input.sampleCount,
    },
    model: {
      id: "AI or Not v1 voice",
      provider: "AI or Not",
      scope: "speech only",
      policy: POLICY,
      scoreSemantics: "Verdict confidence converted to an AI-class score; a screening signal, not proof of authorship",
      localComparison: false,
    },
  };
}

function rawRecord(modality, payload, normalized) {
  let providerResponse = payload;
  if (modality === "text" && Buffer.byteLength(JSON.stringify(payload), "utf8") > 2_000_000) {
    const compactAnnotations = normalizeAnnotations(payload?.report?.ai_text?.annotations, 120_000)
      .map((item) => [item.text, item.score]);
    providerResponse = {
      ...payload,
      report: {
        ...payload?.report,
        ai_text: { ...payload?.report?.ai_text, annotations: compactAnnotations },
      },
      aright_compaction: "Provider annotations were size-bounded for the Vercel evidence response.",
    };
  }
  return {
    provider: "AI or Not",
    modality,
    analyzedAt: new Date().toISOString(),
    decisionPolicy: POLICY,
    requestId: typeof payload?.id === "string" ? payload.id : "",
    model: normalized.model,
    providerResponse,
  };
}

async function detectImage(request, bytes, config, fetchImpl) {
  if (!bytes.length) throw new ApiError("No image data was uploaded.", 400, "EMPTY_UPLOAD");
  const mime = validateImage(bytes, request.headers.get("content-type"));
  const fileName = safeFileName(request.headers.get("x-file-name"), `image.${mime.split("/")[1]}`);
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mime }), fileName);
  const url = new URL(IMAGE_ENDPOINT);
  url.searchParams.set("only", "ai_generated");
  url.searchParams.set("external_id", externalId(bytes));
  const payload = await callProvider(url, { method: "POST", body: form }, config, fetchImpl);
  const data = normalizeImageProvider(payload);
  return { data, raw: rawRecord("image", payload, data) };
}

function validateText(text) {
  const value = String(text || "").trim();
  if (value.length < TEXT_MIN_CHARS) {
    throw new ApiError(`AI or Not text checks require at least ${TEXT_MIN_CHARS} characters.`, 422, "TEXT_TOO_SHORT");
  }
  if (value.length > TEXT_MAX_CHARS) {
    throw new ApiError(`AI or Not text checks accept at most ${TEXT_MAX_CHARS.toLocaleString("en-US")} characters.`, 413, "TEXT_TOO_LONG");
  }
  const words = value.split(/\s+/).filter(Boolean).length;
  if (words < TEXT_MIN_WORDS) {
    throw new ApiError(`AI or Not text checks require about ${TEXT_MIN_WORDS} words.`, 422, "TEXT_TOO_FEW_WORDS");
  }
  return value;
}

async function detectText(text, config, fetchImpl) {
  const value = validateText(text);
  // AI or Not's published examples currently show urlencoded text, but the
  // live v2 endpoint rejects that body as multipart-without-a-boundary. The
  // multipart contract below was verified against the production endpoint.
  const body = new FormData();
  body.set("text", value);
  const url = new URL(TEXT_ENDPOINT);
  url.searchParams.set("include_annotations", "true");
  url.searchParams.set("external_id", externalId(Buffer.from(value, "utf8")));
  const payload = await callProvider(url, {
    method: "POST",
    body,
  }, config, fetchImpl);
  const data = normalizeTextProvider(payload, value);
  return { data, raw: rawRecord("text", payload, data) };
}

async function detectJsonText(bytes, config, fetchImpl) {
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ApiError("Send text as JSON with a text field.", 400, "INVALID_JSON");
  }
  return detectText(payload?.text, config, fetchImpl);
}

async function detectTextFile(request, bytes, config, fetchImpl) {
  if (!bytes.length) throw new ApiError("No text file was uploaded.", 400, "EMPTY_UPLOAD");
  const name = safeFileName(request.headers.get("x-file-name"), "upload.txt");
  if (!name.toLowerCase().endsWith(".txt")) {
    throw new ApiError("The hosted document endpoint supports UTF-8 .txt files only.", 415, "UNSUPPORTED_DOCUMENT_TYPE");
  }
  const mime = String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (mime && mime !== "text/plain" && mime !== "application/octet-stream") {
    throw new ApiError("The hosted document endpoint supports UTF-8 .txt files only.", 415, "UNSUPPORTED_DOCUMENT_TYPE");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new ApiError("The .txt file must use UTF-8 encoding.", 422, "INVALID_TEXT_ENCODING");
  }
  if (text.includes("\u0000")) throw new ApiError("The uploaded file does not look like plain text.", 422, "INVALID_TEXT_FILE");
  return detectText(text, config, fetchImpl);
}

async function detectAudio(request, bytes, config, fetchImpl) {
  if (!bytes.length) throw new ApiError("No decoded audio samples were uploaded.", 400, "EMPTY_UPLOAD");
  const mime = String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (mime && mime !== "application/octet-stream") {
    throw new ApiError("Audio must be browser-decoded Float32 samples.", 415, "UNSUPPORTED_AUDIO_INPUT");
  }
  const sampleRate = Number(request.headers.get("x-sample-rate") || 0);
  const wav = float32LeToWav(bytes, sampleRate);
  const sampleCount = bytes.length / 4;
  const originalName = safeFileName(request.headers.get("x-file-name"), "voice").replace(/\.[^.]+$/, "");
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), `${originalName || "voice"}.wav`);
  const payload = await callProvider(VOICE_ENDPOINT, { method: "POST", body: form }, config, fetchImpl);
  const data = normalizeVoiceProvider(payload, { sampleCount, duration: sampleCount / AUDIO_SAMPLE_RATE });
  return { data, raw: rawRecord("voice", payload, data) };
}

function kindFromRequest(request) {
  const url = new URL(request.url);
  const explicit = url.searchParams.get("kind");
  if (explicit) return explicit.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  return String(segments.at(-1) || "").toLowerCase();
}

export async function handleStatus(request, options = {}) {
  if (request.method === "OPTIONS") return preflight(request);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(request, 405, { error: "Use GET.", type: "METHOD_NOT_ALLOWED" }, { Allow: "GET, HEAD, OPTIONS" });
  }
  try {
    requestOrigin(request);
    const config = getConfig(options.env);
    const configured = Boolean(config.apiKey && config.adminPassword);
    const audioConfigured = configured && config.audioEnabled;
    const authorized = isAuthorized(request, config);
    const models = {
      text: { id: "AI or Not v2 text", loaded: configured },
      image: { id: "AI or Not v2 image", loaded: configured },
      audio: { id: "AI or Not v1 voice", loaded: audioConfigured, available: audioConfigured },
    };
    const body = {
      online: true,
      ready: configured,
      deployment: "vercel-serverless",
      provider: "aiornot-cloud",
      providers: {
        text: { primary: "AI or Not v2 text", configured, remoteProcessing: true },
        image: { primary: "AI or Not v2 image", configured, localComparison: false, remoteProcessing: true },
        audio: {
          primary: "AI or Not v1 voice",
          configured: audioConfigured,
          available: audioConfigured,
          scope: "speech only",
          remoteProcessing: audioConfigured,
          disabledReason: audioConfigured ? "" : "Hosted voice detection is not enabled for this deployment. Use the local Spectra-AASIST3 console for speech screening.",
        },
        video: { primary: "Browser frame sampling + AI or Not v2 image", configured, remoteProcessing: true },
        file: { primary: "AI or Not v2 text", configured, formats: ["txt"], remoteProcessing: true },
      },
      capabilities: {
        text: true,
        image: true,
        audioSpeech: audioConfigured,
        videoFrameSampling: true,
        documents: ["txt"],
      },
      limits: {
        maxUploadBytes: MAX_BODY_BYTES,
        textMinCharacters: TEXT_MIN_CHARS,
        textMinWords: TEXT_MIN_WORDS,
        textMaxCharacters: TEXT_MAX_CHARS,
        providerRequestsPerMinute: config.maxRequestsPerMinute,
        providerMaxConcurrent: config.maxConcurrent,
        rateLimitScope: "best effort per warm serverless instance; use a durable deployment firewall for global limits",
      },
      worker: {
        worker: configured,
        preflight: { ready: configured, errors: configured ? [] : ["AIORNOT_API_KEY and ADMIN_PASSWORD must both be configured."] },
        models,
      },
      workerError: configured ? "" : "Cloud detector configuration is incomplete.",
      authRequired: Boolean(config.adminPassword),
      authorized,
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: responseHeaders(request) });
    return jsonResponse(request, 200, body);
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function handleDetection(request, options = {}) {
  if (request.method === "OPTIONS") return preflight(request);
  const kind = kindFromRequest(request);
  if (!DETECT_KINDS.has(kind)) return jsonResponse(request, 404, { error: "Unknown detection endpoint.", type: "NOT_FOUND" });
  if (request.method !== "POST") {
    return jsonResponse(request, 405, { error: "Use POST.", type: "METHOD_NOT_ALLOWED" }, { Allow: "POST, OPTIONS" });
  }
  try {
    requestOrigin(request);
    const config = getConfig(options.env);
    requireCloudConfig(config);
    requireAuthorization(request, config);
    if (kind === "audio" && !config.audioEnabled) {
      throw new ApiError(
        "Hosted audio detection is unavailable because AI or Not voice access is not enabled for this deployment. Use Aright's local Spectra-AASIST3 console for speech screening.",
        503,
        "AUDIO_DETECTOR_UNAVAILABLE",
      );
    }
    const bytes = await readBytes(request);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    let result;
    if (kind === "image") result = await detectImage(request, bytes, config, fetchImpl);
    else if (kind === "text") result = await detectJsonText(bytes, config, fetchImpl);
    else if (kind === "file") result = await detectTextFile(request, bytes, config, fetchImpl);
    else result = await detectAudio(request, bytes, config, fetchImpl);
    return jsonResponse(request, 200, result);
  } catch (error) {
    return errorResponse(request, error);
  }
}
