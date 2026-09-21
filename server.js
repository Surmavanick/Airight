/* Aright local application server.
   Serves the site and keeps one persistent Python ML worker alive so model
   weights load once. No Node packages are required. Node 18+ and Python 3.12+
   are expected. Run: node server.js */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8000;
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const ML_TIMEOUT_MS = Number(process.env.ML_TIMEOUT_MS) || 10 * 60 * 1000;
const AIORNOT_API_KEY = String(process.env.AIORNOT_API_KEY || "").trim();
const AIORNOT_API_KEY_BACKUP_CANDIDATE = String(process.env.AIORNOT_API_KEY_BACKUP || "").trim();
const AIORNOT_API_KEY_BACKUP = AIORNOT_API_KEY && AIORNOT_API_KEY_BACKUP_CANDIDATE !== AIORNOT_API_KEY
  ? AIORNOT_API_KEY_BACKUP_CANDIDATE
  : "";
const GITHUB_API_TOKEN = String(process.env.GITHUB_API_TOKEN || "").trim();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-5.6-luna").trim() || "gpt-5.6-luna";
const OPENAI_TIMEOUT_MS = Math.max(5_000, Math.min(90_000, Number(process.env.OPENAI_TIMEOUT_MS) || 45_000));
const OPENAI_MAX_REQUESTS_PER_MINUTE = Math.max(1, Number(process.env.OPENAI_MAX_REQUESTS_PER_MINUTE) || 8);
const OPENAI_MAX_CONCURRENT = Math.max(1, Number(process.env.OPENAI_MAX_CONCURRENT) || 1);
const AIORNOT_TIMEOUT_MS = Number(process.env.AIORNOT_TIMEOUT_MS) || 120_000;
const AIORNOT_MAX_REQUESTS_PER_MINUTE = Math.max(1, Number(process.env.AIORNOT_MAX_REQUESTS_PER_MINUTE) || 12);
const AIORNOT_MAX_CONCURRENT = Math.max(1, Number(process.env.AIORNOT_MAX_CONCURRENT) || 2);
const AIORNOT_IMAGE_ENDPOINT = "https://api.aiornot.com/v2/image/sync";
const AIORNOT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const COPILOT_BODY_MAX_BYTES = 64 * 1024;
const AIORNOT_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const aiOrNotUsage = { active: 0, timestamps: [] };
const PAID_PROVIDER_CREDENTIALS_PRESENT = Boolean(AIORNOT_API_KEY || OPENAI_API_KEY);
const PAID_MODE_LOCKED = PAID_PROVIDER_CREDENTIALS_PRESENT && !ADMIN_PASSWORD;
const AIORNOT_ENABLED = Boolean(AIORNOT_API_KEY && ADMIN_PASSWORD);
const OPENAI_ENABLED = Boolean(OPENAI_API_KEY && ADMIN_PASSWORD);
const ALLOW_FILE_ORIGIN_CORS = !(AIORNOT_API_KEY || OPENAI_API_KEY) && /^true$/i.test(String(process.env.ALLOW_FILE_ORIGIN_CORS || ""));
const WORKER_PATH = path.join(ROOT, "ml_worker.py");
const VENV_PYTHON = path.join(ROOT, ".aright-venv", "Scripts", "python.exe");
const PYTHON = String(process.env.PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python"));
let githubCodeModulePromise;
let openAiCopilotModulePromise;

function githubCodeModule() {
  if (!githubCodeModulePromise) githubCodeModulePromise = import("./lib/github-code.mjs");
  return githubCodeModulePromise;
}

function openAiCopilotModule() {
  if (!openAiCopilotModulePromise) openAiCopilotModulePromise = import("./lib/openai-copilot.mjs");
  return openAiCopilotModulePromise;
}

const PRIVATE_SEGMENTS = new Set(["tmp", "node_modules", ".venv", ".aright-venv", "tests", "__pycache__"]);
const PRIVATE_FILES = new Set([
  ".env",
  ".env.example",
  ".gitignore",
  "ml_worker.py",
  "requirements-ml.txt",
  "verify_environment.py",
  "server.js",
  "setup-models.ps1",
  "start-aright.cmd",
  "start-aright.ps1",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
};

function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

function requestOriginAllowed(req) {
  const origin = String(req.headers.origin || "");
  const exactOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  return !origin || exactOrigins.has(origin) || (origin === "null" && ALLOW_FILE_ORIGIN_CORS);
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || "");
  const allowed = requestOriginAllowed(req);
  const headers = {
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-File-Name, X-Sample-Rate",
    Vary: "Origin",
  };
  if (allowed) headers["Access-Control-Allow-Origin"] = origin || "*";
  return headers;
}

function sendJson(req, res, status, body) {
  res.writeHead(status, {
    ...corsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function isAuthorized(req) {
  if (PAID_MODE_LOCKED) return false;
  if (!ADMIN_PASSWORD) return true;
  const given = Buffer.from(String(req.headers["x-admin-key"] || ""));
  const expected = Buffer.from(ADMIN_PASSWORD);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function readBody(req, limit = MAX_BODY_BYTES, tooLargeMessage = "Upload is larger than 25 MB.") {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(Object.assign(new Error(tooLargeMessage), { status: 413 }));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function safeFileName(header) {
  let name = "upload";
  try {
    name = decodeURIComponent(String(header || "upload"));
  } catch {
    // Use fallback.
  }
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 180) || "upload";
}

class ProviderError extends Error {
  constructor(message, status = 502, code = "PROVIDER_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function policyBucket(score) {
  if (score >= 0.75) return "likely_ai";
  if (score <= 0.25) return "likely_human";
  return "inconclusive";
}

function normalizeGeneratorSignals(value) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .map(([id, item]) => {
      const confidence = Number(item && typeof item === "object" ? item.confidence : item);
      if (!Number.isFinite(confidence)) return null;
      return {
        id,
        confidence: Math.max(0, Math.min(1, confidence)),
        isDetected: Boolean(item && typeof item === "object" && item.is_detected),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);
}

function imageMimeFromBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

function aiOrNotRateState(now = Date.now()) {
  aiOrNotUsage.timestamps = aiOrNotUsage.timestamps.filter((timestamp) => now - timestamp < 60_000);
  return {
    active: aiOrNotUsage.active,
    usedThisMinute: aiOrNotUsage.timestamps.length,
    remainingThisMinute: Math.max(0, AIORNOT_MAX_REQUESTS_PER_MINUTE - aiOrNotUsage.timestamps.length),
  };
}

function reserveAiOrNotRequest() {
  const state = aiOrNotRateState();
  if (state.active >= AIORNOT_MAX_CONCURRENT) {
    throw new ProviderError("Too many AI or Not checks are already running. Wait for them to finish.", 429, "LOCAL_PROVIDER_CONCURRENCY_LIMIT");
  }
  if (state.remainingThisMinute <= 0) {
    throw new ProviderError("Aright's local AI or Not cost guard reached its per-minute limit. Wait before retrying.", 429, "LOCAL_PROVIDER_RATE_LIMIT");
  }
  aiOrNotUsage.timestamps.push(Date.now());
  aiOrNotUsage.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    aiOrNotUsage.active = Math.max(0, aiOrNotUsage.active - 1);
  };
}

function parseAiOrNotImage(payload) {
  const report = payload?.report?.ai_generated;
  const aiConfidence = Number(report?.ai?.confidence);
  const humanConfidence = Number(report?.human?.confidence);
  if (!report || !Number.isFinite(aiConfidence) || aiConfidence < 0 || aiConfidence > 1) {
    throw new ProviderError("AI or Not returned an unexpected image response.", 502, "INVALID_PROVIDER_RESPONSE");
  }
  return {
    requestId: typeof payload.id === "string" ? payload.id : "",
    createdAt: typeof payload.created_at === "string" ? payload.created_at : "",
    providerVerdict: typeof report.verdict === "string" ? report.verdict : "",
    aiScore: aiConfidence,
    humanScore: Number.isFinite(humanConfidence) ? Math.max(0, Math.min(1, humanConfidence)) : null,
    generators: normalizeGeneratorSignals(report.generator),
    c2pa: payload?.report?.c2pa && typeof payload.report.c2pa === "object" ? payload.report.c2pa : null,
    meta: payload?.report?.meta && typeof payload.report.meta === "object" ? payload.report.meta : null,
  };
}

function sanitizeProviderPayload(value, secrets, depth = 0) {
  if (depth > 12) return "[truncated]";
  const secretList = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (typeof value === "string") {
    return secretList.reduce((clean, secret) => clean.replaceAll(secret, "[redacted]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderPayload(item, secretList, depth + 1));
  if (!value || typeof value !== "object") return value;
  const clean = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (/^(authorization|api[_-]?key|access[_-]?token|secret)$/i.test(key)) clean[key] = "[redacted]";
    else clean[key] = sanitizeProviderPayload(item, secretList, depth + 1);
  }
  return clean;
}

function aiOrNotHttpError(status, payload = {}) {
  const detail = (() => {
    try {
      return JSON.stringify(payload).toLowerCase();
    } catch {
      return "";
    }
  })();
  const modelDisabled = status === 403 && (
    /model[^\n]{0,120}disabled/.test(detail) ||
    /disabled[^\n]{0,120}(model|plan)/.test(detail) ||
    /plan_version/.test(detail)
  );
  const mappedStatus = status === 429 ? 429 : status === 402 ? 402 : status === 413 ? 413 : status === 415 || status === 422 ? 422 : 502;
  const message = modelDisabled
    ? "The requested AI or Not detector model is not enabled for this account plan."
    : status === 401 || status === 403
    ? "AI or Not rejected the configured provider credentials. Check the server-side keys and account access."
    : status === 402
      ? "AI or Not credits are unavailable for this request. Check the provider account balance."
      : status === 429
        ? "AI or Not rate limit or credit limit reached. Wait before retrying."
        : status === 413
          ? "AI or Not rejected this image as too large."
          : status === 415 || status === 422
            ? "AI or Not could not analyze this image format or content."
            : `AI or Not failed with HTTP ${status}.`;
  const code = modelDisabled
    ? "PROVIDER_MODEL_UNAVAILABLE"
    : status === 401
    ? "PROVIDER_AUTH_FAILED"
    : status === 402
      ? "PROVIDER_CREDITS_UNAVAILABLE"
      : status === 403
        ? "PROVIDER_ACCESS_DENIED"
        : status === 429
          ? "PROVIDER_RATE_LIMIT"
          : status === 413
            ? "PROVIDER_FILE_TOO_LARGE"
            : status === 415 || status === 422
              ? "PROVIDER_REJECTED_INPUT"
              : `PROVIDER_HTTP_${status}`;
  return new ProviderError(message, mappedStatus, code);
}

async function requestAiOrNotImageAttempt(bytes, mime, fileName, url, apiKey) {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mime }), fileName);
  let response;
  const release = reserveAiOrNotRequest();
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(AIORNOT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new ProviderError(
      timedOut ? `AI or Not did not finish within ${Math.round(AIORNOT_TIMEOUT_MS / 1000)} seconds.` : "Could not reach AI or Not.",
      timedOut ? 504 : 502,
      timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE",
    );
  } finally {
    release();
  }

  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (response.ok) throw new ProviderError("AI or Not returned invalid JSON.", 502, "INVALID_PROVIDER_RESPONSE");
    }
  }
  const payload = sanitizeProviderPayload(parsed, [AIORNOT_API_KEY, AIORNOT_API_KEY_BACKUP]);
  return { response, payload };
}

async function requestAiOrNotImage(bytes, mime, fileName) {
  if (!AIORNOT_API_KEY) {
    throw new ProviderError("AI or Not is not configured. Add AIORNOT_API_KEY to .env and restart Aright.", 503, "PROVIDER_NOT_CONFIGURED");
  }
  if (bytes.length > AIORNOT_IMAGE_MAX_BYTES) {
    throw new ProviderError("AI or Not accepts images up to 10 MB in this integration.", 413, "PROVIDER_FILE_TOO_LARGE");
  }
  if (!AIORNOT_IMAGE_MIME.has(mime)) {
    throw new ProviderError("AI or Not image checks support JPG, PNG, or WEBP here.", 415, "PROVIDER_MEDIA_TYPE");
  }
  const detectedMime = imageMimeFromBytes(bytes);
  if (!detectedMime || detectedMime !== mime) {
    throw new ProviderError("The uploaded bytes do not match the declared JPG, PNG, or WEBP type.", 415, "PROVIDER_MEDIA_TYPE");
  }

  const url = new URL(AIORNOT_IMAGE_ENDPOINT);
  url.searchParams.set("only", "ai_generated");
  url.searchParams.set("external_id", `aright-${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 24)}`);

  const primary = await requestAiOrNotImageAttempt(bytes, mime, fileName, url, AIORNOT_API_KEY);
  if (primary.response.ok) {
    return {
      normalized: parseAiOrNotImage(primary.payload),
      raw: primary.payload,
      providerExecution: { credentialSlot: "primary", attemptCount: 1, failoverUsed: false, failoverReason: "" },
    };
  }

  if (AIORNOT_API_KEY_BACKUP && [401, 402, 403].includes(primary.response.status)) {
    const failoverReason = aiOrNotHttpError(primary.response.status, primary.payload).code;
    const backup = await requestAiOrNotImageAttempt(bytes, mime, fileName, url, AIORNOT_API_KEY_BACKUP);
    if (backup.response.ok) {
      return {
        normalized: parseAiOrNotImage(backup.payload),
        raw: backup.payload,
        providerExecution: { credentialSlot: "backup", attemptCount: 2, failoverUsed: true, failoverReason },
      };
    }
    throw aiOrNotHttpError(backup.response.status, backup.payload);
  }

  throw aiOrNotHttpError(primary.response.status, primary.payload);
}

function combineImageSignals(aiOrNot, local) {
  const providerBucket = policyBucket(aiOrNot.aiScore);
  const localScore = Number(local?.ai_score);
  if (!Number.isFinite(localScore)) throw new Error("The local image detector returned no score.");
  const localBucket = policyBucket(localScore);
  const policyVerdict = providerBucket === localBucket ? providerBucket : "inconclusive";
  const disagreement = providerBucket !== localBucket;
  const label = policyVerdict === "likely_ai"
    ? "Both detectors found a high AI-image signal"
    : policyVerdict === "likely_human"
      ? "Both detectors found a low AI-image signal"
      : disagreement
        ? "Detectors disagree — manual review required"
        : "Both detectors are inconclusive";

  return {
    ai_score: Number(aiOrNot.aiScore.toFixed(6)),
    label,
    verdict: policyVerdict,
    providerVerdict: aiOrNot.providerVerdict,
    disagreement,
    providerSignals: [
      {
        id: "aiornot-v2-image",
        name: "AI or Not",
        ai_score: Number(aiOrNot.aiScore.toFixed(6)),
        human_score: aiOrNot.humanScore == null ? null : Number(aiOrNot.humanScore.toFixed(6)),
        verdict: providerBucket,
        rawVerdict: aiOrNot.providerVerdict,
        requestId: aiOrNot.requestId,
      },
      {
        id: local?.model?.id || "community-forensics-384",
        name: "Community Forensics",
        ai_score: Number(localScore.toFixed(6)),
        human_score: null,
        verdict: localBucket,
        rawVerdict: local?.verdict || "",
        requestId: "",
      },
    ],
    generators: aiOrNot.generators,
    c2pa: aiOrNot.c2pa,
    dimensions: local?.dimensions || null,
    model: {
      id: "AI or Not v2 image + OwensLab/commfor-model-384",
      provider: "hybrid-external-and-self-hosted",
      policy: "Agreement at <=25% or >=75%; otherwise inconclusive",
      scoreSemantics: "AI or Not AI-class confidence shown separately from the local model; neither is proof of authorship",
      externalRequestId: aiOrNot.requestId,
      localModel: local?.model || null,
    },
    latencyMs: local?.latencyMs ?? null,
  };
}

class PersistentMlWorker {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.lastError = "";
  }

  start() {
    if (this.child && !this.child.killed) return;
    if (!fs.existsSync(WORKER_PATH)) throw new Error("ml_worker.py is missing.");

    const workerEnv = { ...process.env, PYTHONIOENCODING: "utf-8" };
    delete workerEnv.ADMIN_PASSWORD;
    delete workerEnv.AIORNOT_API_KEY;
    delete workerEnv.AIORNOT_API_KEY_BACKUP;
    delete workerEnv.GITHUB_API_TOKEN;
    delete workerEnv.OPENAI_API_KEY;
    const child = spawn(PYTHON, ["-u", WORKER_PATH], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnv,
    });
    this.child = child;
    this.lastError = "";

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.lastError = `Worker returned invalid JSON: ${line.slice(0, 180)}`;
        return;
      }
      const entry = this.pending.get(String(message.id));
      if (!entry) return;
      this.pending.delete(String(message.id));
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else {
        const error = new Error(message.error || "The detector failed.");
        error.workerType = message.errorType || "WorkerError";
        entry.reject(error);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) console.error(text);
    });

    child.on("error", (error) => {
      this.lastError = `Could not start Python: ${error.message}`;
    });

    child.on("exit", (code, signal) => {
      const reason = this.lastError || `ML worker stopped (${signal || `exit ${code}`}).`;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
      }
      this.pending.clear();
      this.child = null;
      this.lastError = reason;
    });
  }

  request(kind, payload = {}, timeout = ML_TIMEOUT_MS) {
    this.start();
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The ${kind} model did not finish in time.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, kind, payload })}\n`, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  stop() {
    if (this.child && !this.child.killed) this.child.kill();
  }
}

const ml = new PersistentMlWorker();

function workerHttpStatus(error) {
  if (error.workerType === "ValueError" || error.workerType === "UnicodeDecodeError") return 422;
  if (error.workerType === "ModuleNotFoundError" || /No module named/i.test(error.message)) return 503;
  if (/hash mismatch/i.test(error.message)) return 502;
  return 500;
}

async function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    const headers = corsHeaders(req);
    if (req.headers.origin && !headers["Access-Control-Allow-Origin"]) {
      res.writeHead(403, { Vary: "Origin" });
      return res.end();
    }
    res.writeHead(204, headers);
    return res.end();
  }

  if (!requestOriginAllowed(req)) {
    return sendJson(req, res, 403, { error: "Cross-origin API requests are not allowed.", type: "ORIGIN_FORBIDDEN" });
  }

  if (pathname === "/api/status") {
    let worker = null;
    let workerError = "";
    try {
      worker = await ml.request("status", {}, 15_000);
    } catch (error) {
      workerError = error.message;
    }
    return sendJson(req, res, 200, {
      online: true,
      provider: AIORNOT_ENABLED ? "aiornot-plus-self-hosted-open-models" : "self-hosted-open-models",
      providers: {
        image: {
          primary: AIORNOT_ENABLED ? "AI or Not v2" : "Community Forensics",
          configured: AIORNOT_ENABLED,
          failoverConfigured: Boolean(AIORNOT_ENABLED && AIORNOT_API_KEY_BACKUP),
          localComparison: true,
          remoteProcessing: AIORNOT_ENABLED,
          disabledReason: AIORNOT_API_KEY && !ADMIN_PASSWORD ? "Set ADMIN_PASSWORD before enabling paid provider requests." : "",
          costGuard: AIORNOT_ENABLED ? {
            maxRequestsPerMinute: AIORNOT_MAX_REQUESTS_PER_MINUTE,
            maxConcurrent: AIORNOT_MAX_CONCURRENT,
            ...aiOrNotRateState(),
          } : null,
        },
        github: {
          primary: "GitHub REST API",
          configured: true,
          authenticated: Boolean(GITHUB_API_TOKEN),
          publicOnly: true,
          remoteProcessing: true,
        },
        openai: {
          primary: "OpenAI Responses API",
          configured: OPENAI_ENABLED,
          model: OPENAI_MODEL.slice(0, 120),
          remoteProcessing: OPENAI_ENABLED,
          storeResponses: false,
          scope: "Editable evidence plans and task re-checks; not detector scoring",
          disabledReason: OPENAI_API_KEY && !ADMIN_PASSWORD ? "Set ADMIN_PASSWORD before enabling Evidence Copilot requests." : "",
          costGuard: {
            maxRequestsPerMinute: OPENAI_MAX_REQUESTS_PER_MINUTE,
            maxConcurrent: OPENAI_MAX_CONCURRENT,
          },
        },
      },
      capabilities: { githubPublicRepositories: true, evidenceCopilot: OPENAI_ENABLED },
      worker,
      workerError,
      configurationError: PAID_MODE_LOCKED ? "ADMIN_PASSWORD is required whenever a paid provider key is configured." : "",
      authRequired: Boolean(ADMIN_PASSWORD || PAID_PROVIDER_CREDENTIALS_PRESENT),
      authorized: isAuthorized(req),
    });
  }

  const kind = pathname.startsWith("/api/detect/") ? pathname.slice("/api/detect/".length) : "";
  if (!["text", "file", "image", "audio", "github", "copilot"].includes(kind)) {
    return sendJson(req, res, 404, { error: "Unknown endpoint." });
  }
  if (req.method !== "POST") return sendJson(req, res, 405, { error: "Use POST." });
  if (PAID_MODE_LOCKED) {
    return sendJson(req, res, 503, { error: "Set ADMIN_PASSWORD before using Aright with paid provider keys.", type: "ADMIN_PASSWORD_REQUIRED" });
  }
  if (!isAuthorized(req)) return sendJson(req, res, 401, { error: "The console access key is missing or wrong." });

  if (kind === "copilot") {
    const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return sendJson(req, res, 415, { error: "Send the Evidence Copilot request as JSON.", type: "UNSUPPORTED_MEDIA_TYPE" });
    }
  }

  const declared = Number(req.headers["content-length"] || 0);
  const bodyLimit = kind === "github" ? 2_048 : kind === "copilot" ? COPILOT_BODY_MAX_BYTES : MAX_BODY_BYTES;
  const bodyLimitMessage = kind === "github"
    ? "The GitHub import request is too large."
    : kind === "copilot"
      ? "The Evidence Copilot request is too large."
      : "Upload is larger than 25 MB.";
  if (declared > bodyLimit) return sendJson(req, res, 413, { error: bodyLimitMessage, type: "REQUEST_TOO_LARGE" });

  let body;
  try {
    body = await readBody(req, bodyLimit, bodyLimitMessage);
  } catch (error) {
    return sendJson(req, res, error.status || 400, { error: error.message });
  }
  if (body.length > bodyLimit) return sendJson(req, res, 413, { error: bodyLimitMessage, type: "REQUEST_TOO_LARGE" });

  if (kind === "copilot") {
    if (!OPENAI_ENABLED) {
      return sendJson(req, res, 503, { error: "The Evidence Copilot is not configured.", type: "OPENAI_NOT_CONFIGURED" });
    }
    let input;
    try {
      input = JSON.parse(body.toString("utf8"));
    } catch {
      return sendJson(req, res, 400, { error: "The Evidence Copilot request must be valid JSON.", type: "INVALID_JSON" });
    }
    try {
      const { runOpenAiCopilot } = await openAiCopilotModule();
      const result = await runOpenAiCopilot(input, {
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        timeoutMs: OPENAI_TIMEOUT_MS,
        maxRequestsPerMinute: OPENAI_MAX_REQUESTS_PER_MINUTE,
        maxConcurrent: OPENAI_MAX_CONCURRENT,
        fetchImpl: fetch,
      });
      return sendJson(req, res, 200, {
        data: result,
        raw: {
          provider: "OpenAI Responses API",
          action: result.action,
          model: result.model,
          responseId: result.responseId,
          generatedAt: result.generatedAt,
          stored: false,
        },
      });
    } catch (error) {
      const status = Number(error?.status);
      return sendJson(req, res, Number.isFinite(status) ? status : 502, {
        error: error?.name === "CopilotError" ? error.message : "The Evidence Copilot could not complete this request.",
        type: error?.code || "OPENAI_COPILOT_ERROR",
      });
    }
  }

  if (kind === "github") {
    let repositoryUrl = "";
    try {
      repositoryUrl = String(JSON.parse(body.toString("utf8")).repositoryUrl || "");
    } catch {
      return sendJson(req, res, 400, { error: "The GitHub import request must be valid JSON.", type: "INVALID_JSON" });
    }
    try {
      const { importGithubRepository } = await githubCodeModule();
      const result = await importGithubRepository(repositoryUrl, { fetchImpl: fetch, token: GITHUB_API_TOKEN });
      return sendJson(req, res, 200, result);
    } catch (error) {
      return sendJson(req, res, Number(error.status) || 500, {
        error: error.message || "The GitHub repository could not be imported.",
        type: error.code || "GITHUB_IMPORT_ERROR",
      });
    }
  }

  let workerKind = kind;
  let payload;
  if (kind === "text") {
    let text = "";
    try {
      text = String(JSON.parse(body.toString("utf8")).text || "");
    } catch {
      // Empty check below gives the useful error.
    }
    if (!text.trim()) return sendJson(req, res, 400, { error: "Add some text to analyze." });
    payload = { text };
  } else {
    if (!body.length) return sendJson(req, res, 400, { error: "No file data was uploaded." });
    payload = { data: body.toString("base64") };
    if (kind === "file") {
      workerKind = "document";
      payload.name = safeFileName(req.headers["x-file-name"]);
    }
    if (kind === "audio") payload.sampleRate = Number(req.headers["x-sample-rate"] || 0);
  }

  try {
    if (kind === "image" && AIORNOT_ENABLED) {
      const mime = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
      const fileName = safeFileName(req.headers["x-file-name"]);
      // Decode, dimension-check and score locally before spending a metered provider call.
      const localResult = await ml.request("image", payload);
      const providerResult = await requestAiOrNotImage(body, mime, fileName);
      const result = combineImageSignals(providerResult.normalized, localResult);
      return sendJson(req, res, 200, {
        data: result,
        raw: {
          provider: "AI or Not + self-hosted Community Forensics",
          modality: "image",
          analyzedAt: new Date().toISOString(),
          decisionPolicy: result.model.policy,
          providerExecution: providerResult.providerExecution,
          aiOrNot: providerResult.raw,
          local: localResult,
        },
      });
    }

    const result = await ml.request(workerKind, payload);
    return sendJson(req, res, 200, {
      data: result,
      raw: {
        provider: "self-hosted-open-models",
        modality: workerKind,
        analyzedAt: new Date().toISOString(),
        result,
      },
    });
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : workerHttpStatus(error);
    return sendJson(req, res, status, {
      error: error.message,
      type: error instanceof ProviderError ? error.code : error.workerType || "WorkerError",
    });
  }
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return notFound(res);
  }

  const segments = decoded.split("/").filter(Boolean);
  const blocked = segments.some((segment) => segment.startsWith(".") || segment.includes("\\") || PRIVATE_SEGMENTS.has(segment));
  if (blocked || (segments.length === 1 && PRIVATE_FILES.has(segments[0]))) return notFound(res);

  let filePath = path.resolve(ROOT, ...segments);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return notFound(res);

  fs.stat(filePath, (statError, stat) => {
    if (statError) return notFound(res);
    if (stat.isDirectory()) {
      if (!pathname.endsWith("/")) {
        res.writeHead(301, { Location: pathname + "/" });
        return res.end();
      }
      filePath = path.join(filePath, "index.html");
    }
    fs.stat(filePath, (fileError, fileStat) => {
      if (fileError || !fileStat.isFile()) return notFound(res);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Content-Length": fileStat.size,
        "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(filePath).pipe(res);
    });
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    handleApi(req, res, pathname).catch((error) => {
      console.error(error);
      if (!res.headersSent) sendJson(req, res, 500, { error: "Unexpected server error." });
    });
    return;
  }
  serveStatic(req, res, pathname);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Open http://127.0.0.1:${PORT}/admin/ or stop the other service.`);
  } else {
    console.error(`Aright server failed: ${error.message}`);
  }
  ml.stop();
  process.exitCode = 1;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Aright running at http://127.0.0.1:${PORT}`);
  console.log(`Console:          http://127.0.0.1:${PORT}/admin/`);
  console.log(`ML worker:        ${PYTHON}`);
  if (PAID_MODE_LOCKED) console.error("Paid provider calls are disabled: set ADMIN_PASSWORD in .env and restart Aright.");
  else if (ADMIN_PASSWORD) console.log("Console access key is required (ADMIN_PASSWORD). ");
  ml.request("status", {}, 15_000).then(() => console.log("ML worker ready; models load on first use.")).catch((error) => {
    console.error(`ML worker unavailable: ${error.message}`);
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    ml.stop();
    server.close(() => process.exit(0));
  });
}

module.exports = { server, ml };
