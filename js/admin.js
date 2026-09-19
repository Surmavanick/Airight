/* Aright Console
   Uses the real detectors exposed by the connected Aright service. The hosted
   deployment uses AI or Not; the local launcher can also use pinned open models.
   Detector signals and user evidence declarations become an IPR-readiness score
   and action plan. Evidence records remain in this browser. */

const STORAGE_KEY = "aright.console.assets.v1";
const ACCESS_KEY_STORAGE = "aright.console.accessKey";
const MB = 1024 * 1024;
const HASH_LIMIT = 250 * MB;
const STORED_TEXT_LIMIT = 60000;
const QUOTES_VISIBLE = 5;
const AUDIO_MAX_SECONDS = 60.5;
const requestedApiPort = Number(new URLSearchParams(location.search).get("apiPort"));
const fileApiPort = Number.isInteger(requestedApiPort) && requestedApiPort > 0 && requestedApiPort <= 65535 ? requestedApiPort : 8000;
const API_BASE = location.protocol === "file:" ? `http://127.0.0.1:${fileApiPort}` : "";

const FILE_RULES = {
  doc: { max: 15 * MB, exts: ["pdf", "docx", "txt"], label: "a PDF, DOCX or TXT file" },
  image: { max: 10 * MB, min: 1024, exts: ["jpg", "jpeg", "png", "webp"], label: "a JPG, PNG or WEBP image" },
  video: { exts: ["mp4", "webm", "mov", "m4v"], mimePrefix: "video/", label: "an MP4, WEBM or MOV video" },
  audio: { max: 50 * MB, exts: ["mp3", "wav", "m4a", "ogg", "flac", "aac"], mimePrefix: "audio/", label: "an MP3, WAV, M4A, OGG or FLAC file" },
};

const TYPE_LABEL = { text: "Text", image: "Image", video: "Video", audio: "Audio" };
const TYPE_ICON = { text: "i-text", image: "i-image", video: "i-video", audio: "i-audio" };
const SLOT_ICON = { doc: "i-text", image: "i-image", video: "i-video", audio: "i-audio" };

const HUMAN = {
  none: { label: "none", points: 0 },
  light: { label: "light", points: 7 },
  substantial: { label: "substantial", points: 15 },
  human: { label: "human-made", points: 20 },
};
const LICENSE = {
  yes: { label: "terms checked", points: 20 },
  unsure: { label: "not checked", points: 8 },
  no: { label: "terms don't allow it", points: 0 },
};
const USE_LABEL = { internal: "internal use", commercial: "commercial use", brand: "use as a brand asset" };
const STATUS = {
  "at-risk": { label: "At risk", tag: "low" },
  action: { label: "Action needed", tag: "mid" },
  review: { label: "In review", tag: "info" },
  protected: { label: "Review complete", tag: "ok" },
};
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

// A frame can be unreadable while the rest of a video scan still succeeds.
const RECOVERABLE_STATUSES = new Set([200, 400, 415, 422]);

const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  main: $("#main"),
  conn: $("#conn"),
  connText: $("#connText"),
  topbarWorkspace: $(".topbar__workspace"),
  newAnalysisBtn: $("#newAnalysisBtn"),
  overviewNewAnalysis: $("#overviewNewAnalysis"),
  overviewMetrics: $("#overviewMetrics"),
  attentionList: $("#attentionList"),
  recentList: $("#recentList"),
  overviewDetectorStatus: $("#overviewDetectorStatus"),
  assetCount: $("#assetCount"),
  sideLinks: $$(".side__link"),
  views: $$(".view"),
  flowSteps: $$("#flow li"),
  intake: $("#intake"),
  typeButtons: $$(".types__btn"),
  panes: $$(".pane"),
  textInput: $("#textInput"),
  charCount: $("#charCount"),
  transcriptInput: $("#transcriptInput"),
  audioAvailabilityBadge: $("#audioAvailabilityBadge"),
  audioAvailabilityNote: $("#audioAvailabilityNote"),
  frameCount: $("#frameCount"),
  assetName: $("#assetName"),
  aiTool: $("#aiTool"),
  humanInput: $("#humanInput"),
  useInput: $("#useInput"),
  licenseInput: $("#licenseInput"),
  provenanceInput: $("#provenanceInput"),
  detailsSummary: $("#detailsSummary"),
  runBtn: $("#runBtn"),
  costHint: $("#costHint"),
  intakeError: $("#intakeError"),
  results: $("#results"),
  emptyState: $("#emptyState"),
  loadingState: $("#loadingState"),
  loadingText: $("#loadingText"),
  errorState: $("#errorState"),
  errorText: $("#errorText"),
  errorRawWrap: $("#errorRawWrap"),
  errorRaw: $("#errorRaw"),
  report: $("#report"),
  kpis: $("#kpis"),
  registerSearch: $("#registerSearch"),
  registerStatusFilter: $("#registerStatusFilter"),
  registerBody: $("#registerBody"),
  registerEmpty: $("#registerEmpty"),
  vault: $("#vault"),
  vaultEmpty: $("#vaultEmpty"),
  exportAll: $("#exportAll"),
  commandTrigger: $("#commandTrigger"),
  commandMenu: $("#commandMenu"),
  commandInput: $("#commandInput"),
  commandResults: $("#commandResults"),
  unlock: $("#unlock"),
  unlockForm: $("#unlockForm"),
  unlockInput: $("#unlockInput"),
  unlockError: $("#unlockError"),
};

const state = {
  type: "text",
  files: { doc: null, image: null, video: null, audio: null },
  slotUrls: {},
  usedUrls: new Set(),
  previews: new Map(),
  expandedQuotes: new Set(),
  reportTabs: new Map(),
  server: { online: false, ready: false, deployment: "", provider: "", providers: {}, providerFailover: {}, capabilities: {}, worker: null, authRequired: false, authorized: false },
  assets: [],
  assetsLoaded: false,
  currentId: null,
  storageFailed: false,
  busy: false,
};

class ApiError extends Error {
  constructor(message, status, raw) {
    super(message);
    this.status = status;
    this.raw = raw;
  }
}

/* ---------- Small helpers ---------- */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const round1 = (n) => Math.round(n * 10) / 10;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function baseName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

// Tenths are kept so frames sampled from short clips don't share a label.
function formatTime(seconds) {
  const tenths = Math.round(seconds * 10);
  const secs = (tenths % 600) / 10;
  return `${Math.floor(tenths / 600)}:${secs.toFixed(1).padStart(4, "0")}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function newId() {
  const time = Date.now().toString(36).toUpperCase().slice(-5);
  const random = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `AR-${time}${random}`;
}

const icon = (id, extra = "") => `<svg class="icon ${extra}" aria-hidden="true"><use href="#${id}"/></svg>`;
const aiTone = (pct) => (pct == null ? "none" : pct >= 75 ? "low" : pct > 25 ? "mid" : "ok");
const detectionTone = (detection) => {
  if (detection?.aiPct == null) return "none";
  if (detection.policyVerdict === "likely_ai") return "low";
  if (detection.policyVerdict === "likely_human") return "ok";
  if (detection.policyVerdict === "inconclusive") return "mid";
  return aiTone(detection.aiPct);
};
const iprTone = (score) => (score >= 80 ? "ok" : score >= 55 ? "mid" : "low");

/* ---------- Storage ---------- */
function normalizeStoredRecord(value) {
  if (!value || typeof value !== "object" || !["text", "image", "video", "audio"].includes(value.type) || !value.detection || typeof value.detection !== "object") return null;
  const detection = {
    ...value.detection,
    flagged: Array.isArray(value.detection.flagged) ? value.detection.flagged.filter((item) => typeof item === "string") : [],
    segments: Array.isArray(value.detection.segments) ? value.detection.segments : [],
    frames: value.type === "video" && Array.isArray(value.detection.frames) ? value.detection.frames : value.detection.frames,
  };
  if (value.type === "video" && !Array.isArray(detection.frames)) return null;
  if (detection.transcript && typeof detection.transcript === "object") {
    detection.transcript = {
      ...detection.transcript,
      flagged: Array.isArray(detection.transcript.flagged) ? detection.transcript.flagged.filter((item) => typeof item === "string") : [],
      segments: Array.isArray(detection.transcript.segments) ? detection.transcript.segments : [],
    };
  }
  const savedTasks = Array.isArray(value.tasks)
    ? value.tasks
        .filter((task) => task && typeof task === "object")
        .map((task, index) => ({
          ...task,
          id: String(task.id || `saved-task-${index + 1}`),
          priority: Object.hasOwn(PRIORITY_ORDER, task.priority) ? task.priority : "high",
          short: String(task.short || task.title || "Review this saved record"),
          title: String(task.title || task.short || "Review this saved record"),
          detail: String(task.detail || "Confirm the supporting evidence before completing review."),
          done: Boolean(task.done),
          quotes: Array.isArray(task.quotes) ? task.quotes.filter((item) => typeof item === "string") : [],
        }))
    : [];
  const needsLegacyReview = !Array.isArray(value.tasks) || (value.tasks.length > 0 && savedTasks.length === 0);
  const tasks = needsLegacyReview
    ? [{
        id: "legacy-review",
        priority: "high",
        short: "Analyze a new version",
        title: "Re-scan this legacy record before completing review",
        detail: "This saved record predates the current checklist schema. Upload the original again so Aright can create a complete, current evidence record.",
        done: false,
        quotes: [],
      }]
    : savedTasks;
  const fileBacked = value.type !== "text" || value.source === "document";
  return {
    ...value,
    id: String(value.id || newId()),
    name: String(value.name || "Saved asset"),
    createdAt: value.createdAt || new Date().toISOString(),
    details: value.details && typeof value.details === "object" ? value.details : {},
    tasks,
    detection,
    file: fileBacked ? { name: String(value.file?.name || value.name || "Saved asset"), size: Number(value.file?.size) || 0, mime: String(value.file?.mime || "") } : value.file || null,
    protectedAt: needsLegacyReview ? null : value.protectedAt || null,
  };
}

function loadAssets() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeStoredRecord).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveAssets() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.assets));
    state.storageFailed = false;
  } catch {
    state.storageFailed = true;
  }
}

function loadAuthorizedAssets() {
  if (state.assetsLoaded) return;
  state.assets = loadAssets();
  state.assetsLoaded = true;
  renderCollections();
}

function unloadAuthorizedAssets() {
  if (!state.assetsLoaded) return;
  state.assets = [];
  state.assetsLoaded = false;
  state.currentId = null;
  renderCollections();
  showOnly(els.emptyState);
  updateFlow("upload");
}

function compactRawRecord(raw) {
  if (raw == null) return raw;
  return JSON.parse(JSON.stringify(raw, (key, value) => {
    if (key === "input_text" && typeof value === "string") {
      return `[omitted from persisted raw record · ${value.length.toLocaleString()} characters]`;
    }
    if (key === "annotations" && Array.isArray(value)) {
      const compact = value.slice(0, 20).map((item) => {
        if (!Array.isArray(item)) return item;
        return [typeof item[0] === "string" ? item[0].slice(0, 1_000) : item[0], item[1]];
      });
      if (value.length > compact.length) compact.push([`[${value.length - compact.length} additional annotation blocks omitted]`, null]);
      return compact;
    }
    return value;
  }));
}

function readAccessKey() {
  try {
    return window.sessionStorage.getItem(ACCESS_KEY_STORAGE) || "";
  } catch {
    return state.accessKey || "";
  }
}

function writeAccessKey(value) {
  state.accessKey = value;
  try {
    window.sessionStorage.setItem(ACCESS_KEY_STORAGE, value);
  } catch {
    // Kept in memory for this page only.
  }
}

function accessHeaders() {
  const key = readAccessKey();
  return key ? { "X-Admin-Key": key } : {};
}

function isServiceReady() {
  if (state.server.ready === true) return true;
  return Boolean(state.server.worker?.worker) && state.server.worker?.preflight?.ready !== false && !state.server.workerError;
}

function isCloudService() {
  return state.server.deployment.startsWith("vercel") || state.server.provider === "aiornot-cloud";
}

function isHostedAudioAvailable() {
  if (!isCloudService()) return true;
  return state.server.capabilities?.audioSpeech === true && state.server.providers?.audio?.configured === true;
}

function renderCapabilityAvailability() {
  const audioButton = els.typeButtons.find((button) => button.dataset.type === "audio");
  const unavailable = isCloudService() && !isHostedAudioAvailable();
  const reason = state.server.providers?.audio?.disabledReason ||
    "Hosted audio detection is unavailable. Use the local Spectra-AASIST3 console for speech screening.";
  audioButton.disabled = unavailable;
  audioButton.setAttribute("aria-disabled", String(unavailable));
  audioButton.setAttribute("aria-label", unavailable ? "Audio — hosted detector unavailable; use the local app" : "Audio");
  audioButton.title = unavailable ? reason : "";
  els.audioAvailabilityBadge.textContent = "Local";
  els.audioAvailabilityBadge.hidden = !unavailable;
  els.audioAvailabilityNote.textContent = unavailable
    ? reason
    : isCloudService()
      ? "The hosted console sends a 16 kHz voice sample to AI or Not. It screens synthetic or cloned speech, not AI music. A supplied script is checked separately."
      : "The local app uses Spectra-AASIST3 for synthetic or cloned speech screening, not AI music. A supplied script is checked separately with the local text model.";
  if (unavailable && state.type === "audio") {
    setType("text");
    els.intakeError.textContent = reason;
  }
}

function setOverviewService(message, stateName) {
  if (!els.overviewDetectorStatus) return;
  els.overviewDetectorStatus.textContent = message;
  const mark = $(".status-mark--service", els.overviewDetectorStatus.closest(".overview-status__item"));
  if (mark) mark.dataset.state = stateName;
}

/* ---------- Real model service ---------- */
async function checkServer() {
  els.conn.dataset.state = "checking";
  els.connText.textContent = "Connecting to detection models…";
  try {
    const response = await fetch(`${API_BASE}/api/status`, {
      headers: { ...accessHeaders() },
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    state.server = {
      online: response.ok && Boolean(data.online),
      ready: Boolean(data.ready),
      deployment: String(data.deployment || ""),
      provider: data.provider || "",
      providers: data.providers && typeof data.providers === "object" ? data.providers : {},
      providerFailover: data.providerFailover && typeof data.providerFailover === "object" ? data.providerFailover : {},
      capabilities: data.capabilities && typeof data.capabilities === "object" ? data.capabilities : {},
      worker: data.worker || null,
      workerError: data.workerError || "",
      authRequired: Boolean(data.authRequired),
      authorized: data.authorized !== false,
    };
  } catch (error) {
    state.server = {
      online: false,
      ready: false,
      deployment: "",
      provider: "",
      providers: {},
      providerFailover: {},
      capabilities: {},
      worker: null,
      workerError: error.message || "Connection failed",
      authRequired: false,
      authorized: false,
    };
  }
  renderConnection();
  updateCostHint();
}

function renderConnection() {
  const serviceReady = isServiceReady();
  const cloud = isCloudService();
  renderCapabilityAvailability();

  if (!state.server.online) {
    unloadAuthorizedAssets();
    document.body.classList.add("is-checking-access");
    document.body.classList.remove("is-locked");
    els.conn.dataset.state = "offline";
    const hosted = location.protocol === "https:" || location.hostname.endsWith("vercel.app");
    els.connText.textContent = hosted ? "Hosted detector service unavailable" : "Model service offline · run start-aright.cmd";
    els.conn.title = state.server.workerError || "The Aright model service is not reachable.";
    setOverviewService(els.connText.textContent, "offline");
    return;
  }

  if (!serviceReady) {
    unloadAuthorizedAssets();
    document.body.classList.add("is-checking-access");
    document.body.classList.remove("is-locked");
    els.conn.dataset.state = "missing";
    els.connText.textContent = cloud ? "Cloud detectors are not configured" : "Model setup incomplete · run setup-models.ps1";
    els.conn.title = state.server.workerError || state.server.worker?.preflight?.errors?.join(" ") || "The detection service is not ready.";
    setOverviewService(els.connText.textContent, "warning");
    return;
  }

  if (state.server.authRequired && !state.server.authorized) {
    unloadAuthorizedAssets();
    document.body.classList.remove("is-checking-access");
    document.body.classList.add("is-locked");
    els.conn.dataset.state = "missing";
    els.connText.textContent = "Console locked · access key required";
    els.conn.title = "Enter the ADMIN_PASSWORD configured on the server.";
    setOverviewService("Models ready · console access required", "warning");
    openUnlock();
    return;
  }

  document.body.classList.remove("is-locked");
  loadAuthorizedAssets();

  const models = Object.values(state.server.worker?.models || {});
  const uniqueModels = new Set(models.map((model) => model.id)).size;
  const loaded = new Set(models.filter((model) => model.loaded).map((model) => model.id)).size;
  const imageProvider = state.server.providers?.image;
  const cloudAudioReady = isHostedAudioAvailable();
  els.conn.dataset.state = "ready";
  document.body.classList.remove("is-checking-access", "is-locked");
  els.connText.textContent = cloud
    ? cloudAudioReady
      ? "AI or Not cloud detectors ready"
      : "AI or Not text and image detectors ready"
    : imageProvider?.configured
    ? loaded
      ? `AI or Not + local models · ${loaded}/${uniqueModels} loaded`
      : "AI or Not + local models ready"
    : loaded
      ? `Local models ready · ${loaded}/${uniqueModels} loaded`
      : "Local models ready · load on first scan";
  els.conn.title = cloud
    ? cloudAudioReady
      ? "Text, images, sampled video frames and speech are sent to AI or Not through Aright's server-side proxy. API credentials never enter the browser."
      : "Text, images and sampled video frames are sent to AI or Not through Aright's server-side proxy. Hosted audio is unavailable; use the local Spectra-AASIST3 console for speech screening."
    : imageProvider?.configured
    ? "Images and sampled video frames are sent to AI or Not and compared with the self-hosted Community Forensics model. Text and speech stay local."
    : "Self-hosted open detection models; uploads are not sent to a third-party detector.";
  setOverviewService(els.connText.textContent, "ready");
}

async function postDetect(kind, body, headers = {}) {
  if (!state.server.online || !isServiceReady()) await checkServer();
  if (!state.server.online || !isServiceReady()) {
    const cloud = isCloudService() || location.protocol === "https:";
    throw new ApiError(cloud ? "The hosted detection service is not ready. Try again shortly." : "The real model service is not running. Double-click start-aright.cmd, then try again.", 0);
  }
  if (state.server.authRequired && !state.server.authorized) {
    openUnlock();
    throw new ApiError("Unlock the console before running a model.", 401);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}/api/detect/${kind}`, {
      method: "POST",
      headers: { ...accessHeaders(), ...headers },
      body,
    });
  } catch (error) {
    throw new ApiError(`Can't reach the real model service: ${error.message || "connection failed"}`, 0);
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(json.error || `Analysis failed (HTTP ${response.status}).`, response.status, json);
  return json;
}

const detectText = (text) => postDetect("text", JSON.stringify({ text }), { "Content-Type": "application/json" });

const detectUpload = (kind, blob, name, extraHeaders = {}) =>
  postDetect(kind, blob, {
    "Content-Type": blob.type || "application/octet-stream",
    "X-File-Name": encodeURIComponent(name),
    ...extraHeaders,
  });

/* ---------- Model-response normalization ---------- */
function normalizeTextResult(data, sourceText = "") {
  const d = data && typeof data === "object" ? data : {};
  const pct = toNumber(d.fakePercentage);
  const sourceFlagged = Array.isArray(d.h) ? d.h.filter((s) => typeof s === "string" && s.trim()) : [];
  let flaggedBudget = 60_000;
  let flaggedClientTruncated = sourceFlagged.length > 100;
  const flagged = sourceFlagged.slice(0, 100).map((s) => {
    const original = s.trim();
    const text = original.slice(0, Math.max(0, flaggedBudget));
    if (text.length < original.length) flaggedClientTruncated = true;
    flaggedBudget -= text.length;
    return text;
  }).filter(Boolean);
  if (flagged.length < sourceFlagged.length) flaggedClientTruncated = true;

  const sourceSegments = Array.isArray(d.segments) ? d.segments : [];
  let segmentBudget = 60_000;
  let segmentsClientTruncated = sourceSegments.length > 200;
  const segments = sourceSegments.slice(0, 200).map((segment) => {
    if (!segment || typeof segment !== "object") return segment;
    if (typeof segment.text !== "string") return segment;
    const text = segment.text.slice(0, Math.max(0, segmentBudget));
    if (text.length < segment.text.length) segmentsClientTruncated = true;
    segmentBudget -= text.length;
    return { ...segment, text };
  });
  const retainedSegmentCharacters = segments.reduce((sum, segment) => sum + (typeof segment?.text === "string" ? segment.text.length : 0), 0);
  const providerStats = d.annotationStats && typeof d.annotationStats === "object" ? d.annotationStats : null;
  const annotationStats = providerStats
    ? {
        ...providerStats,
        retainedBlocks: Math.min(toNumber(providerStats.retainedBlocks) ?? sourceSegments.length, segments.length),
        retainedCharacters: Math.min(toNumber(providerStats.retainedCharacters) ?? retainedSegmentCharacters, retainedSegmentCharacters),
        retainedHighScoreBlocks: flagged.length,
      }
    : {
        totalBlocks: sourceSegments.length,
        retainedBlocks: segments.length,
        retainedCharacters: retainedSegmentCharacters,
        highScoreBlocks: sourceFlagged.length,
        retainedHighScoreBlocks: flagged.length,
      };
  const returnedText =
    typeof d.input_text === "string" && d.input_text
      ? d.input_text
      : Array.isArray(d.sentences)
        ? d.sentences.filter((s) => typeof s === "string").join(" ")
        : "";
  return {
    checked: true,
    aiPct: pct == null ? null : round1(clamp(pct, 0, 100)),
    verdict: typeof d.feedback === "string" ? d.feedback : "",
    policyVerdict: typeof d.label === "string" ? d.label : "",
    textWords: toNumber(d.textWords),
    aiWords: toNumber(d.aiWords),
    flaggedTotal: toNumber(d.flaggedTotal) ?? sourceFlagged.length,
    annotationStats,
    annotationsTruncated: Boolean(d.annotationsTruncated) || flaggedClientTruncated || segmentsClientTruncated,
    flagged,
    segments,
    model: d.model || null,
    text: (sourceText || returnedText).slice(0, STORED_TEXT_LIMIT),
  };
}

// Keep a tolerant normalizer so the UI can also consume optional commercial providers.
const AI_PCT_KEYS = ["fakePercentage", "ai_probability", "aiProbability", "ai_percentage", "aiPercentage", "ai_score", "aiScore", "result", "probability", "score"];
const LABEL_KEYS = ["final_result", "finalResult", "label", "verdict", "prediction", "feedback"];

function findValue(obj, keys, accept, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return undefined;
  for (const key of keys) {
    if (Object.hasOwn(obj, key) && accept(obj[key])) return obj[key];
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const found = findValue(value, keys, accept, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const isAiLabel = (label) => /\bai\b|generated|synthetic|fake/i.test(label) && !/\breal\b|human|authentic/i.test(label);

function normalizeImageResult(data) {
  if (data && typeof data === "object" && Array.isArray(data.providerSignals)) {
    let pct = toNumber(data.ai_score);
    if (pct != null && pct >= 0 && pct <= 1) pct *= 100;
    return {
      checked: true,
      aiPct: pct == null ? null : round1(clamp(pct, 0, 100)),
      verdict: typeof data.label === "string" ? data.label : "",
      policyVerdict: typeof data.verdict === "string" ? data.verdict : "inconclusive",
      providerVerdict: typeof data.providerVerdict === "string" ? data.providerVerdict : "",
      disagreement: Boolean(data.disagreement),
      providerSignals: data.providerSignals.map((signal) => ({
        id: String(signal?.id || ""),
        name: String(signal?.name || signal?.id || "Detector"),
        aiPct: toNumber(signal?.ai_score) == null ? null : round1(clamp(Number(signal.ai_score) <= 1 ? Number(signal.ai_score) * 100 : Number(signal.ai_score), 0, 100)),
        humanPct: toNumber(signal?.human_score) == null ? null : round1(clamp(Number(signal.human_score) <= 1 ? Number(signal.human_score) * 100 : Number(signal.human_score), 0, 100)),
        verdict: String(signal?.verdict || ""),
        rawVerdict: String(signal?.rawVerdict || ""),
        requestId: String(signal?.requestId || ""),
      })),
      generators: Array.isArray(data.generators)
        ? data.generators.map((item) => ({
            id: String(item?.id || ""),
            confidence: round1(clamp(Number(item?.confidence || 0) * 100, 0, 100)),
            isDetected: Boolean(item?.isDetected),
          }))
        : [],
      c2pa: data.c2pa && typeof data.c2pa === "object" ? data.c2pa : null,
      model: data.model || null,
    };
  }

  let pct = toNumber(findValue(data, AI_PCT_KEYS, (v) => toNumber(v) != null));
  if (pct != null && pct >= 0 && pct <= 1) pct *= 100;
  const label = findValue(data, LABEL_KEYS, (v) => typeof v === "string" && v.trim() !== "") || "";

  if (pct == null && label) {
    const confidence = toNumber(findValue(data, ["confidence", "final_label_confidence"], (v) => toNumber(v) != null));
    if (confidence != null) {
      const c = confidence <= 1 ? confidence * 100 : confidence;
      pct = isAiLabel(label) ? c : 100 - c;
    }
  }

  return {
    checked: true,
    aiPct: pct == null ? null : round1(clamp(pct, 0, 100)),
    verdict: label,
    policyVerdict: typeof data?.verdict === "string" ? data.verdict : "",
    model: data?.model || null,
  };
}

function normalizeAudioResult(data) {
  const result = normalizeImageResult(data);
  return {
    ...result,
    segments: Array.isArray(data?.segments) ? data.segments : [],
    duration: toNumber(data?.duration),
    scope: data?.model?.scope || "speech only",
    inputChecks: data?.inputChecks && typeof data.inputChecks === "object" ? data.inputChecks : null,
  };
}

function requireScore(detection, raw) {
  if (detection.aiPct == null) {
    throw new ApiError("The model could not produce a score. The diagnostic record is below.", 200, raw);
  }
  return detection;
}

/* ---------- Files ---------- */
function validateFile(slot, file) {
  const rule = FILE_RULES[slot];
  const ext = extOf(file.name);
  const typeOk = rule.exts.includes(ext) || (rule.mimePrefix && file.type.startsWith(rule.mimePrefix));
  if (!typeOk) return `“${file.name}” isn't supported here. Choose ${rule.label}.`;
  const cloud = isCloudService();
  if (cloud && slot === "doc" && ext !== "txt") return "The hosted console currently accepts TXT documents. For PDF or DOCX, paste the extracted text instead.";
  if (cloud && ["doc", "image"].includes(slot) && file.size > 4 * MB) {
    return `“${file.name}” is ${formatBytes(file.size)}. Hosted uploads are limited to 4 MB.`;
  }
  if (rule.max && file.size > rule.max) return `“${file.name}” is ${formatBytes(file.size)}. The limit is ${formatBytes(rule.max)}.`;
  if (rule.min && file.size < rule.min) return `“${file.name}” is too small to analyze.`;
  return "";
}

function describeFile(file) {
  return { name: file.name, size: file.size, mime: file.type || "" };
}

async function sha256(blob) {
  if (!window.crypto?.subtle || blob.size > HASH_LIMIT) return null;
  const digest = await window.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function waitForMedia(element, eventName, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener(eventName, onReady);
      element.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new ApiError("This browser can't decode the video. Convert it to MP4 (H.264) and try again.", 415));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new ApiError("Reading the video took too long. Try a shorter clip or an MP4 file.", 408));
    }, timeout);
    element.addEventListener(eventName, onReady);
    element.addEventListener("error", onError);
  });
}

// Sample evenly spaced frames; each JPEG is then sent to the connected image detector.
async function sampleFrames(file, count) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const ready = waitForMedia(video, "loadeddata");
  video.src = url;

  try {
    await ready;
    let { duration } = video;
    const { videoWidth, videoHeight } = video;
    // Browser-recorded WebM files often report Infinity until the end has been seeked to.
    if (duration === Infinity) {
      const seekedToEnd = waitForMedia(video, "seeked");
      video.currentTime = Number.MAX_SAFE_INTEGER;
      await seekedToEnd;
      duration = video.duration;
    }
    if (!Number.isFinite(duration) || duration <= 0 || !videoWidth) {
      throw new ApiError("Couldn't read frames from this video. Try an MP4 (H.264) file.", 415);
    }

    const scale = Math.min(1, 1280 / Math.max(videoWidth, videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(videoWidth * scale);
    canvas.height = Math.round(videoHeight * scale);
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = 240;
    thumbCanvas.height = Math.round((240 * videoHeight) / videoWidth);
    const ctx = canvas.getContext("2d");
    const thumbCtx = thumbCanvas.getContext("2d");

    const frames = [];
    for (let i = 0; i < count; i += 1) {
      const time = Math.max(0.01, Math.min(duration - 0.05, (duration * (i + 0.5)) / count));
      const seeked = waitForMedia(video, "seeked");
      video.currentTime = time;
      await seeked;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      thumbCtx.drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height);
      let blob = null;
      for (const quality of [0.88, 0.75, 0.6]) {
        blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (blob && blob.size <= 4 * MB) break;
      }
      if (!blob) throw new ApiError("Couldn't capture a frame from this video.", 415);
      if (blob.size > 4 * MB) throw new ApiError("A sampled frame is too detailed for the hosted 4 MB limit. Try a lower-resolution video.", 413);
      frames.push({ time, blob, thumb: thumbCanvas.toDataURL("image/jpeg", 0.7) });
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function readAudioDuration(file, timeout = 15000) {
  const url = URL.createObjectURL(file);
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  try {
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        audio.removeEventListener("loadedmetadata", onReady);
        audio.removeEventListener("error", onError);
      };
      const onReady = () => {
        cleanup();
        if (Number.isFinite(audio.duration) && audio.duration > 0) resolve(audio.duration);
        else reject(new ApiError("The audio duration could not be read. Try a standard MP3, WAV, M4A, OGG or FLAC file.", 415));
      };
      const onError = () => {
        cleanup();
        reject(new ApiError("This browser cannot read that audio file. Try MP3, WAV, M4A, OGG or FLAC.", 415));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ApiError("Reading the audio metadata took too long. Try a shorter clip.", 408));
      }, timeout);
      audio.addEventListener("loadedmetadata", onReady);
      audio.addEventListener("error", onError);
      audio.src = url;
    });
  } finally {
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}

async function decodeAudioTo16k(file) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new ApiError("This browser cannot decode audio for the speech model.", 415);
  const context = new AudioContextClass();
  try {
    let decoded;
    try {
      decoded = await context.decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new ApiError("This browser cannot decode that audio file. Try WAV, MP3, M4A, OGG or FLAC.", 415);
    }
    if (!decoded.length || !decoded.numberOfChannels) throw new ApiError("The audio file is empty.", 422);
    const duration = Math.min(60, decoded.duration);
    const outputLength = Math.max(1, Math.floor(duration * 16000));
    const output = new Float32Array(outputLength);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const ratio = decoded.sampleRate / 16000;

    for (let i = 0; i < outputLength; i += 1) {
      const source = i * ratio;
      const left = Math.min(decoded.length - 1, Math.floor(source));
      const right = Math.min(decoded.length - 1, left + 1);
      const mix = source - left;
      let sample = 0;
      for (const channel of channels) sample += channel[left] * (1 - mix) + channel[right] * mix;
      output[i] = sample / channels.length;
    }
    return { samples: output, duration: decoded.duration, truncated: decoded.duration > 60 };
  } finally {
    await context.close().catch(() => {});
  }
}

/* ---------- IPR score, status and action plan ---------- */
function effectiveDetails(record) {
  const details = { ...record.details };
  for (const task of record.tasks) {
    if (task.done && task.effect) Object.assign(details, task.effect);
  }
  return details;
}

// Out of 100: how prepared the asset's evidence is for review. Without a content signal the score is
// capped at 60, because nothing about the asset itself has been verified.
function scoreOf(record) {
  const details = effectiveDetails(record);
  const ai = record.detection.aiPct;
  const policy = record.detection.policyVerdict || (ai == null ? "" : ai >= 75 ? "likely_ai" : ai <= 25 ? "likely_human" : "inconclusive");
  const human = HUMAN[details.human] || HUMAN.light;
  const license = LICENSE[details.license] || LICENSE.unsure;
  const screeningPoints = { likely_human: 45, inconclusive: 22, likely_ai: 0 }[policy];
  const parts = [
    {
      label: "Content screening factor",
      note: ai == null ? "not measured" : `${round1(ai)}% model score · ${policy.replaceAll("_", " ")}`,
      value: ai == null ? null : screeningPoints,
      max: 45,
    },
    { label: "Declared human contribution", note: human.label, value: human.points, max: 20 },
    { label: "Provenance evidence", note: details.provenance ? "saved" : "not saved", value: details.provenance ? 15 : 0, max: 15 },
    { label: "Licence clarity", note: license.label, value: license.points, max: 20 },
  ];
  const declared = parts.slice(1).reduce((sum, part) => sum + part.value, 0);
  const total = ai == null ? Math.min(60, Math.round((declared / 55) * 100)) : parts[0].value + declared;
  return { total, parts, capped: ai == null };
}

function statusOf(record) {
  if (record.protectedAt) return "protected";
  if (record.tasks.every((task) => task.done)) return "review";
  return scoreOf(record).total < 55 ? "at-risk" : "action";
}

function openTasks(record) {
  return record.tasks
    .filter((task) => !task.done)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

function nextAction(record) {
  const status = statusOf(record);
  if (status === "protected") return "Keep the review record on file";
  if (status === "review") return "Complete the final review";
  return openTasks(record)[0].short;
}

const PROVENANCE_TASK = {
  text: ["Save your drafts and the prompts you used", "Keep version history (Google Docs, tracked changes) and the prompt log. They are supporting evidence of your team's human contribution, not proof by themselves."],
  image: ["Save the prompt, model version, seed and source files", "Store them with the layered file. Together they show how the image was made and which parts are your own work."],
  video: ["Save the prompts, model versions and edit project", "The edit project file and generation settings show which shots were generated and what your team cut, composited and graded."],
  audio: ["Save the prompts, stems and DAW session", "Stems and the session file show your arrangement and mixing. That's the human part of the track."],
};

function buildTasks(type, detection, details) {
  const tasks = [];
  const add = (task) => tasks.push({ done: false, quotes: [], ...task });
  const ai = detection.aiPct;
  const tool = details.tool || "the AI tool";
  const commercial = details.use !== "internal";
  const lowHuman = details.human === "none" || details.human === "light";

  if (ai != null && ai >= 75 && details.human === "human") {
    add({
      id: "conflict",
      priority: "high",
      short: "Document the human process",
      title: "Back up the “human-made” claim",
      detail: `You marked this as human-made, but the detector returned a high ${ai}% model score. Keep drafts, sketches or project files that show how it was made. The score is not proof of authorship.`,
    });
  }

  const writing = type === "text" ? detection : detection.transcript;
  if (writing?.checked) {
    const noun = type === "audio" ? "line" : "sentence";
    const writingAi = writing.aiPct;
    const n = writing.flaggedTotal ?? writing.flagged?.length ?? 0;
    if (n) {
      add({
        id: "rewrite",
        priority: writingAi >= 75 ? "high" : "medium",
        short: `Rewrite ${plural(n, noun)}`,
        title: `Review the ${plural(n, noun)} with high text-model scores`,
        detail: "Rewrite from source material in your own structure, add verifiable specifics, and preserve the edit history. The model score alone is not an authorship decision.",
        quotes: writing.flagged,
      });
    } else if (writingAi >= 25) {
      add({
        id: "rewrite",
        priority: writingAi >= 75 ? "high" : "medium",
        short: "Rework AI-sounding passages",
        title: `Review passages behind the ${writingAi}% AI-class model score`,
        detail: "The document-level classifier is inconclusive or elevated. Review the source trail and document any substantive human rewrite.",
      });
    }
    if (writingAi >= 25 && lowHuman) {
      add({
        id: "human-layer",
        priority: "medium",
        short: "Add original material",
        title: "Add material only a person on your team could write",
        detail: "Add your own data, customer examples, opinions and structure. These elements may contain protectable human-authored expression; whether they qualify requires case-specific review.",
      });
    }
    if (commercial && writingAi >= 25) {
      add({
        id: "disclose",
        priority: "medium",
        short: "Plan AI disclosure",
        title: "Disclose AI-generated parts if you register copyright",
        detail: "The US Copyright Office generally asks applicants to identify and disclaim AI-generated material that's more than minimal. The scope of any registration depends on the human-authored expression and the Office's review.",
      });
    }
    if (details.use === "brand") {
      add({
        id: "clearance",
        priority: "high",
        short: "Trademark clearance search",
        title: "Run a trademark clearance search on names and slogans",
        detail: "Search federal records and relevant marketplace sources for potentially conflicting names, taglines or slogans. A search helps identify conflicts; it does not confirm availability or ownership.",
      });
    }
    if (n || writingAi >= 25) {
      add({
        id: "rescan",
        priority: "low",
        short: "Re-scan the final version",
        title: "Re-scan the final version",
        detail: "Run the edited version through the analysis again, so the evidence record matches what you publish.",
      });
    }
  }

  if (type === "audio") {
    if (!detection.transcript?.checked) {
      add({
        id: "transcript",
        priority: "low",
        short: "Add lyrics or script",
        title: "Add the lyrics or script for a separate text-model check",
        detail: "The speech model checks the recording, while the text model checks the words. Add the script if you also need text-authorship screening.",
      });
    }
    add({
      id: "voice",
      priority: commercial ? "high" : "medium",
      short: "Voice consent",
      title: "Get written consent for any synthetic or cloned voice",
      detail: "If a voice sounds like a real person, you need their permission. Many jurisdictions protect a person's voice and likeness, even when the audio is generated.",
    });
    add({
      id: "melody",
      priority: "medium",
      short: "Check melody similarity",
      title: "Check the melody against existing songs",
      detail: "Music generators can echo existing melodies and hooks. Run it through a music recognition app, and have someone who knows the genre listen for close matches.",
    });
  }

  if (type === "image") {
    if (ai >= 75) {
      add({
        id: "human-work",
        priority: "high",
        short: "Add documented human work",
        title: "Add documented human creative work before you rely on it",
        detail: `The external image check returned a ${ai}% AI-class score. This is not proof that the image is AI-generated. Keep layered source files, references, prompts, licences and meaningful human edits for review.`,
      });
    } else if (ai >= 25) {
      add({
        id: "human-work",
        priority: "medium",
        short: "Document your edits",
        title: "Document the edits you made to the generated parts",
        detail: "Keep the layered file and a before-and-after export. They show which elements are your own work.",
      });
    }
    if (ai >= 25 || lowHuman) {
      add({
        id: "similarity",
        priority: commercial ? "high" : "medium",
        short: "Reverse image search",
        title: "Reverse-search the image for look-alikes",
        detail: "Run it through Google Lens or TinEye. Generators can reproduce existing artwork, photos or characters closely enough to infringe.",
      });
    }
    if (commercial) {
      add({
        id: "likeness",
        priority: "medium",
        short: "Check people and logos",
        title: "Check for real people, logos and characters",
        detail: "Remove recognizable faces, brands or copyrighted characters unless you have a release or licence for them.",
      });
    }
    if (details.use === "brand") {
      add({
        id: "redraw",
        priority: "high",
        short: "Redraw mark, clear trademark",
        title: "Have a designer redraw the mark, then run a trademark search",
        detail: "A substantive human redraw may contain protectable human-authored expression. A multi-source clearance search can identify similar marks, but it does not confirm registration, availability or ownership.",
      });
    }
  }

  if (type === "video") {
    if (detection.coverage?.sufficient === false) {
      add({
        id: "video-coverage",
        priority: "high",
        short: "Re-encode and re-scan video",
        title: "Get enough readable frames for a reliable screening pass",
        detail: `Only ${detection.coverage.scored} of ${detection.coverage.total} sampled frames could be scored; at least ${detection.coverage.minimum} are required. Re-encode the video as MP4 (H.264) or WEBM and analyze it again.`,
      });
    }
    const flagged = detection.frames.filter((frame) => frame.aiPct != null && (frame.policyVerdict ? frame.policyVerdict === "likely_ai" : frame.aiPct >= 75));
    if (flagged.length) {
      add({
        id: "frames",
        priority: "high",
        short: `Rework ${plural(flagged.length, "shot")}`,
        title: `Rework the ${plural(flagged.length, "shot")} flagged as AI-generated`,
        detail: "Replace them with original footage, or document the human editing, compositing and grading on those shots.",
        quotes: flagged.map((frame) => `${formatTime(frame.time)}: ${frame.aiPct}% synthetic-image model score`),
      });
    } else if (ai >= 25) {
      add({
        id: "frames",
        priority: "medium",
        short: "Document your edit",
        title: "Document how the video was edited",
        detail: "Some frames show AI traits. Keep the edit project and export notes that show your cut, compositing and grading.",
      });
    }
    add({
      id: "soundtrack",
      priority: "medium",
      short: "Check soundtrack and voice",
      title: "Check the soundtrack and voice-over separately",
      detail: "Frame scanning only covers the picture. Run the music or narration through the Audio tab and confirm you have the rights to both.",
    });
    if (commercial) {
      add({
        id: "likeness",
        priority: "medium",
        short: "Check people and logos",
        title: "Check for real people, logos and characters on screen",
        detail: "Blur or remove recognizable faces, brands or characters unless you have a release or licence.",
      });
    }
  }

  if (!details.provenance) {
    const [title, detail] = PROVENANCE_TASK[type];
    add({ id: "provenance", priority: "medium", effect: { provenance: true }, short: "Save prompts and sources", title, detail });
  }

  if (details.license !== "yes") {
    const blocked = details.license === "no";
    add({
      id: "license",
      priority: blocked || commercial ? "high" : "low",
      effect: { license: "yes" },
      short: blocked ? "Resolve tool licence" : "Confirm tool licence",
      title: blocked
        ? `Get a licence that covers ${USE_LABEL[details.use]}, or replace the asset`
        : `Confirm ${tool}'s terms allow ${USE_LABEL[details.use]}`,
      detail: blocked
        ? "You said the tool's terms don't allow this use. Upgrade the plan, negotiate a licence or replace the asset. Tick this once it's resolved."
        : "Check the plan the asset was made on. Some tools limit commercial use or ownership on free tiers. Tick this once you've confirmed.",
    });
  }

  return tasks.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

function modelInfoOf(record) {
  if (record.detection?.model?.id) return record.detection.model;
  if (record.raw?.result?.model?.id) return record.raw.result.model;
  if (record.raw?.audio?.result?.model?.id) return record.raw.audio.result.model;
  if (Array.isArray(record.raw)) {
    const found = record.raw.find((entry) => entry?.response?.result?.model?.id);
    if (found) return found.response.result.model;
  }
  return null;
}

function modelLabel(record) {
  const model = modelInfoOf(record);
  if (!model) return "Legacy analysis record";
  const revision = model.revision ? ` @ ${String(model.revision).slice(0, 12)}` : "";
  return `${model.id}${revision}`;
}

function automatedSteps(record) {
  const { detection } = record;
  const steps = [];
  if (record.type === "video") {
    const scanned = detection.frames.filter((frame) => frame.aiPct != null).length;
    steps.push(`Sampled ${plural(detection.frames.length, "frame")} and scored ${scanned} with ${modelLabel(record)}`);
  } else if (detection.checked) {
    const what = { text: record.source === "document" ? "document" : "text", image: "image", audio: "speech recording" }[record.type];
    steps.push(`Scored the ${what} with ${modelLabel(record)}`);
  }
  if (record.type === "image" && detection.providerSignals?.length) {
    steps.push(`Recorded ${plural(detection.providerSignals.length, "named detector signal")} without averaging unlike model scores`);
    const requestId = detection.providerSignals.find((signal) => signal.requestId)?.requestId;
    if (requestId) steps.push(`Recorded AI or Not request ID ${requestId}`);
  }
  if (detection.flagged?.length) steps.push(`Recorded ${plural(detection.flagged.length, "passage")} with high text-model scores`);
  if (detection.transcript?.flagged?.length) steps.push(`Recorded ${plural(detection.transcript.flagged.length, "script passage")} with high text-model scores`);
  steps.push(record.fingerprint ? "Fingerprinted the original with SHA-256" : "Recorded the original's details (fingerprint not available in this browser)");
  steps.push("Calculated the IPR score and added the asset to the register");
  if (record.raw) steps.push("Saved the versioned model record in the evidence vault");
  return steps;
}

/* ---------- Analysis ---------- */
function readDetails() {
  return {
    tool: els.aiTool.value.trim(),
    human: els.humanInput.value,
    use: els.useInput.value,
    license: els.licenseInput.value,
    provenance: els.provenanceInput.checked,
  };
}

function missingInput(type) {
  if (type === "text" && !state.files.doc && !els.textInput.value.trim()) return "Paste some text or upload a document.";
  if (type === "text" && !state.files.doc && isCloudService()) {
    const text = els.textInput.value.trim();
    const words = text ? text.split(/\s+/).length : 0;
    if (text.length < 250 || words < 64) return "AI or Not needs at least 250 characters and about 64 words for a text check.";
  }
  if (type === "image" && !state.files.image) return "Choose an image to analyze.";
  if (type === "video" && !state.files.video) return "Choose a video to analyze.";
  if (type === "audio" && isCloudService() && !isHostedAudioAvailable()) {
    return state.server.providers?.audio?.disabledReason || "Hosted audio detection is unavailable. Use the local Spectra-AASIST3 console.";
  }
  if (type === "audio" && !state.files.audio) return "Upload an audio file for speech analysis.";
  if (type === "audio" && isCloudService() && els.transcriptInput.value.trim()) {
    const transcript = els.transcriptInput.value.trim();
    const words = transcript.split(/\s+/).length;
    if (transcript.length < 250 || words < 64) return "The optional script needs at least 250 characters and about 64 words, or leave it empty.";
  }
  return "";
}

function defaultName(type, file, text) {
  if (file) return baseName(file.name);
  const words = text.trim().split(/\s+/).slice(0, 6).join(" ");
  return words ? `${words}…` : `${TYPE_LABEL[type]} asset`;
}

function slotUrl(slot) {
  const file = state.files[slot];
  if (!file) return "";
  if (!state.slotUrls[slot]) state.slotUrls[slot] = URL.createObjectURL(file);
  return state.slotUrls[slot];
}

async function analyze(type) {
  if (type === "text") {
    const doc = state.files.doc;
    if (doc) {
      setLoading(`Extracting and scoring “${doc.name}” with the connected detector…`);
      const [response, fingerprint] = await Promise.all([detectUpload("file", doc, doc.name), sha256(doc)]);
      const detection = requireScore(normalizeTextResult(response.data), response.raw);
      return { source: "document", file: describeFile(doc), fingerprint, raw: response.raw, detection };
    }
    const text = els.textInput.value.trim();
    setLoading(isCloudService() ? "Running the AI or Not text detector…" : "Running the Fakespot / Mozilla text model…");
    const [response, fingerprint] = await Promise.all([detectText(text), sha256(new Blob([text], { type: "text/plain" }))]);
    const detection = requireScore(normalizeTextResult(response.data, text), response.raw);
    return { source: "paste", file: null, fingerprint, raw: response.raw, detection };
  }

  if (type === "image") {
    const file = state.files.image;
    const externalImage = Boolean(state.server.providers?.image?.configured);
    const localComparison = state.server.providers?.image?.localComparison !== false;
    setLoading(externalImage ? (localComparison ? "Running AI or Not and Community Forensics on the image…" : "Running the AI or Not image detector…") : "Running Community Forensics on the image…");
    const [response, fingerprint] = await Promise.all([detectUpload("image", file, file.name), sha256(file)]);
    const detection = requireScore(normalizeImageResult(response.data), response.raw);
    return { source: "file", file: describeFile(file), fingerprint, raw: response.raw, detection, preview: slotUrl("image") };
  }

  if (type === "video") {
    const file = state.files.video;
    const count = Number(els.frameCount.value) || 5;
    setLoading("Reading frames from the video…");
    const [frames, fingerprint] = await Promise.all([sampleFrames(file, count), sha256(file)]);
    const results = [];
    const raw = [];

    for (const [index, frame] of frames.entries()) {
      const externalImage = Boolean(state.server.providers?.image?.configured);
      const localComparison = state.server.providers?.image?.localComparison !== false;
      const detectorLabel = externalImage ? (localComparison ? "Running AI or Not + local comparison" : "Running AI or Not") : "Running the local image model";
      setLoading(`${detectorLabel} on frame ${index + 1} of ${frames.length}…`);
      const time = round1(frame.time);
      try {
        const response = await detectUpload("image", frame.blob, `${baseName(file.name)}-frame-${index + 1}.jpg`);
        const result = normalizeImageResult(response.data);
        raw.push({ frame: index + 1, time, response: response.raw });
        results.push({
          time: frame.time,
          thumb: frame.thumb,
          aiPct: result.aiPct,
          verdict: result.verdict,
          policyVerdict: result.policyVerdict,
          model: result.model,
          providerVerdict: result.providerVerdict,
          providerSignals: result.providerSignals,
          disagreement: result.disagreement,
          generators: result.generators,
          c2pa: result.c2pa,
          error: result.aiPct == null ? "No score returned" : "",
        });
      } catch (error) {
        if (!(error instanceof ApiError) || !RECOVERABLE_STATUSES.has(error.status)) throw error;
        raw.push({ frame: index + 1, time, error: error.message, response: error.raw ?? null });
        results.push({ time: frame.time, thumb: frame.thumb, aiPct: null, verdict: "", error: error.message });
      }
    }

    const scored = results.filter((frame) => frame.aiPct != null);
    if (!scored.length) throw new ApiError("The image model could not read any sampled frame.", 502, raw);
    const ordered = scored.map((frame) => frame.aiPct).sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    const aiPct = round1(ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2);
    const highSignals = scored.filter((frame) => frame.policyVerdict === "likely_ai").length;
    const allLow = scored.every((frame) => frame.policyVerdict === "likely_human");
    const minimumScored = Math.max(2, Math.ceil(results.length / 2));
    const sufficientCoverage = scored.length >= minimumScored;
    const policyVerdict = sufficientCoverage && highSignals >= 2 ? "likely_ai" : sufficientCoverage && allLow ? "likely_human" : "inconclusive";
    const verdict = !sufficientCoverage
      ? `Only ${scored.length} of ${results.length} sampled frames could be scored — coverage is insufficient for a video-level conclusion`
      : {
          likely_ai: "Synthetic-image signal appears in multiple sampled frames",
          likely_human: "No strong synthetic-image signal in the successfully sampled frames",
          inconclusive: "Frame-level result is inconclusive",
        }[policyVerdict];
    return {
      source: "file",
      file: describeFile(file),
      fingerprint,
      raw,
      detection: {
        checked: true,
        aiPct,
        verdict,
        policyVerdict,
        frames: results,
        model: results.find((frame) => frame.model)?.model || raw.find((item) => item.response)?.response?.result?.model || null,
        aggregation: `median of ${scored.length}/${results.length} successfully scored sampled frames`,
        coverage: { scored: scored.length, total: results.length, minimum: minimumScored, sufficient: sufficientCoverage },
      },
    };
  }

  const file = state.files.audio;
  if (isCloudService() && !isHostedAudioAvailable()) {
    throw new ApiError("Hosted audio detection is unavailable. Use the local Spectra-AASIST3 console for speech screening.", 503);
  }
  const transcript = els.transcriptInput.value.trim();
  setLoading("Checking the audio duration…");
  const audioDuration = await readAudioDuration(file);
  if (audioDuration > AUDIO_MAX_SECONDS) {
    throw new ApiError("For browser memory safety, upload a voice clip no longer than 60 seconds.", 413);
  }
  setLoading("Fingerprinting the voice clip…");
  const fingerprint = await sha256(file);
  setLoading("Decoding and resampling speech to 16 kHz…");
  const decoded = await decodeAudioTo16k(file);
  setLoading(isCloudService() ? "Running the AI or Not voice detector…" : "Running the Spectra-AASIST3 speech model…");
  const pcmBlob = new Blob([decoded.samples.buffer], { type: "application/octet-stream" });
  const audioResponse = await detectUpload("audio", pcmBlob, file.name, { "X-Sample-Rate": "16000" });
  const detection = requireScore(normalizeAudioResult(audioResponse.data), audioResponse.raw);
  detection.decode = { originalDuration: round1(decoded.duration), analyzedSeconds: Math.min(60, round1(decoded.duration)), truncated: decoded.truncated };
  let transcriptRaw = null;
  if (transcript) {
    setLoading("Running the text model on the supplied script…");
    const response = await detectText(transcript);
    detection.transcript = requireScore(normalizeTextResult(response.data, transcript), response.raw);
    transcriptRaw = response.raw;
  }
  return {
    source: "file",
    file: describeFile(file),
    fingerprint,
    raw: { audio: audioResponse.raw, transcript: transcriptRaw },
    detection,
    preview: slotUrl("audio"),
  };
}

async function runAnalysis() {
  if (state.busy) return;
  const type = state.type;
  const missing = missingInput(type);
  if (missing) {
    els.intakeError.textContent = missing;
    return;
  }
  els.intakeError.textContent = "";

  const details = readDetails();
  const name =
    els.assetName.value.trim() ||
    defaultName(type, state.files[type === "text" ? "doc" : type], type === "audio" ? els.transcriptInput.value : els.textInput.value);

  setBusy(true);
  try {
    const result = await analyze(type);
    const record = {
      id: newId(),
      createdAt: new Date().toISOString(),
      type,
      source: result.source,
      name,
      details,
      file: result.file,
      fingerprint: result.fingerprint,
      detection: result.detection,
      raw: compactRawRecord(result.raw),
      tasks: buildTasks(type, result.detection, details),
      protectedAt: null,
    };
    if (result.preview) {
      state.previews.set(record.id, result.preview);
      state.usedUrls.add(result.preview);
    }
    state.assets.unshift(record);
    saveAssets();
    state.currentId = record.id;
    renderCollections();
    showRecord(record, { animate: true });
    els.results.scrollIntoView({ behavior: motionQuery.matches ? "auto" : "smooth", block: "start" });
  } catch (error) {
    showError(error);
    els.results.scrollIntoView({ behavior: motionQuery.matches ? "auto" : "smooth", block: "start" });
  } finally {
    setBusy(false);
  }
}

/* ---------- Result states ---------- */
function showOnly(target) {
  for (const el of [els.emptyState, els.loadingState, els.errorState, els.report]) el.hidden = el !== target;
}

function setBusy(busy) {
  state.busy = busy;
  els.runBtn.disabled = busy;
  els.runBtn.setAttribute("aria-busy", String(busy));
  if (busy) {
    showOnly(els.loadingState);
    updateFlow("score");
  }
}

function setLoading(text) {
  els.loadingText.textContent = text;
}

function showError(error) {
  console.error(error);
  showOnly(els.errorState);
  els.errorText.textContent = error.message || "Something went wrong.";
  const hasRaw = error.raw !== undefined && error.raw !== null;
  els.errorRawWrap.hidden = !hasRaw;
  els.errorRaw.textContent = hasRaw ? JSON.stringify(error.raw, null, 2) : "";
  updateFlow("upload");
  if (error.status === 0 || error.status === 503) checkServer();
}

function updateFlow(stage) {
  const index = { upload: 0, score: 1, plan: 2, protect: 3, complete: 4 }[stage];
  els.flowSteps.forEach((step, i) => {
    step.classList.toggle("is-done", i < index);
    step.classList.toggle("is-current", i === index);
    if (i === index) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

function stageFor(record) {
  const status = statusOf(record);
  if (status === "protected") return "complete";
  if (status === "review") return "protect";
  return "plan";
}

/* ---------- Report ---------- */
function ring(value, tone, suffix, animate) {
  const r = 42;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - clamp(value ?? 0, 0, 100) / 100);
  const start = animate ? circumference : offset;
  const label = value == null ? "–" : `<span>${Math.round(value)}${suffix ? `<small>${suffix}</small>` : ""}</span>`;
  return `
    <div class="ring tone-${tone}">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="ring__track" cx="50" cy="50" r="${r}"/>
        <circle class="ring__fill" cx="50" cy="50" r="${r}" stroke-dasharray="${circumference.toFixed(2)}"
          stroke-dashoffset="${start.toFixed(2)}" data-offset="${offset.toFixed(2)}"/>
      </svg>
      <span class="ring__value">${label}</span>
    </div>`;
}

function aiHeadline(pct, detection = null) {
  if (pct == null) return "Not scanned";
  if (detection?.policyVerdict === "likely_ai") return "High AI-model signal";
  if (detection?.policyVerdict === "likely_human") return "Low AI-model signal";
  if (detection?.policyVerdict === "inconclusive") return "Inconclusive";
  if (pct >= 75) return "High AI-model signal";
  if (pct > 25) return "Inconclusive";
  return "Low AI-model signal";
}

function usesAiOrNot(detection) {
  const modelId = String(detection?.model?.id || detection?.model?.provider || "");
  return /ai\s*or\s*not|aiornot/i.test(modelId) || detection?.providerSignals?.some((signal) => signal.name === "AI or Not");
}

function riskHeadline(score) {
  if (score >= 80) return "Prepared for review";
  if (score >= 55) return "Needs documentation";
  return "High-priority review";
}

function summaryCard(record, score, status, animate) {
  const ai = record.detection.aiPct;
  const externalSignal = usesAiOrNot(record.detection);
  const hasExternalImageSignal = record.type === "image" && record.detection.providerSignals?.some((signal) => signal.name === "AI or Not");
  const meterLabel = externalSignal ? `AI or Not ${record.type === "audio" ? "voice" : record.type === "video" ? "frame" : record.type} signal` : `${TYPE_LABEL[record.type]} model score`;
  const aiNote =
    ai == null
      ? "No content model score is available for this legacy record."
      : record.type === "video"
        ? `${record.detection.aggregation || `Median across ${plural(record.detection.frames.filter((f) => f.aiPct != null).length, "scanned frame")}`}.`
        : record.type === "audio"
          ? externalSignal
            ? "AI or Not voice-model signal for speech; it is not an AI-music score or proof of authorship."
            : "Uncalibrated application-level maximum across the first 60 seconds; speech only, not a probability or AI-music score."
          : record.type === "text" && externalSignal
            ? "AI or Not text-model signal with optional block annotations; it is a review signal, not proof of authorship."
          : hasExternalImageSignal
            ? record.detection.disagreement
              ? "AI or Not score; the named detectors disagree, so Aright requires manual review."
              : record.detection.providerSignals?.length > 1
                ? "AI or Not score shown separately from the local comparison; neither is proof."
                : "AI or Not provider score; the 25/75 bands are Aright review policy, not proof."
            : "Model-class score; not a calibrated authorship probability or proof.";

  const factors = score.parts
    .map((part) => {
      const width = part.value == null ? 0 : (part.value / part.max) * 100;
      return `
        <li class="factor">
          <span class="factor__label"><strong>${escapeHtml(part.label)}</strong><span>${escapeHtml(part.note)}</span></span>
          <span class="factor__pts">${part.value == null ? "–" : part.value} / ${part.max}</span>
          <span class="factor__bar" aria-hidden="true"><i style="width:${width}%"></i></span>
        </li>`;
    })
    .join("");

  const notices = [
    score.capped
      ? `<p class="callout">${icon("i-alert")}<span>No content signal is available for this asset, so readiness is capped until the script and supporting evidence are reviewed.</span></p>`
      : "",
    state.storageFailed
      ? `<p class="callout">${icon("i-alert")}<span>This browser's storage is full or blocked, so the record won't survive a reload. Download the evidence file now.</span></p>`
      : "",
  ].join("");

  return `
    <article class="box section-card report-summary">
      <div class="section-card__head">
        <div>
          <p class="eyebrow">${TYPE_LABEL[record.type]} · ${escapeHtml(record.id)}</p>
          <h2>${escapeHtml(record.name)}</h2>
          <p class="summary__meta"><span>Analyzed ${escapeHtml(formatDate(record.createdAt))}</span><span>${escapeHtml(record.details.tool || "AI tool not specified")}</span></p>
        </div>
        <span class="tag tag--${STATUS[status].tag}">${STATUS[status].label}</span>
      </div>
      <div class="meters">
        <div class="meter">
          ${ring(ai, detectionTone(record.detection), "%", animate)}
          <div class="meter__text"><span>${escapeHtml(meterLabel)}</span><strong>${aiHeadline(ai, record.detection)}</strong><p>${escapeHtml(aiNote)}</p></div>
        </div>
        <div class="meter">
          ${ring(score.total, iprTone(score.total), "", animate)}
          <div class="meter__text"><span>IPR readiness score</span><strong>${riskHeadline(score.total)}</strong><p>How ready the asset's evidence is for human or legal review, out of 100.</p></div>
        </div>
      </div>
      <details class="score-breakdown">
        <summary><span>Readiness breakdown</span><small>4 evidence factors</small></summary>
        <ul class="factors">${factors}</ul>
      </details>
      ${notices}
    </article>`;
}

function highlightText(text, sentences) {
  const ranges = [];
  for (const sentence of sentences) {
    const pattern = sentence.split(/\s+/).filter(Boolean).map(escapeRegExp).join("\\s+");
    if (!pattern) continue;
    const match = new RegExp(pattern).exec(text);
    if (match) ranges.push([match.index, match.index + match[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }

  let html = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    html += `${escapeHtml(text.slice(cursor, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  return html + escapeHtml(text.slice(cursor));
}

function textFindings(detection) {
  const external = usesAiOrNot(detection);
  const chips = [`<span class="stat-chip"><b>${detection.aiPct}%</b> ${external ? "AI or Not text score" : "AI-class model score"}</span>`];
  if (detection.textWords != null) {
    chips.push(`<span class="stat-chip"><b>${detection.textWords}</b> words screened</span>`);
  }
  chips.push(`<span class="stat-chip"><b>${detection.flaggedTotal ?? detection.flagged.length}</b> high-score passages</span>`);

  const body = detection.text
    ? `<div class="doc">${highlightText(detection.text, detection.flagged)}</div>
       <p class="legend"><i aria-hidden="true"></i>Highlighted: ${external ? "provider-returned text blocks" : "word windows"} with an AI-class score of 75% or more</p>`
    : `<p class="note">No passage text is stored for this record.</p>`;
  const stats = detection.annotationStats || {};
  const totalBlocks = toNumber(stats.totalBlocks) ?? "additional";
  const retainedBlocks = toNumber(stats.retainedBlocks) ?? detection.segments.length;
  const retainedHighScoreBlocks = toNumber(stats.retainedHighScoreBlocks) ?? detection.flagged.length;
  const totalHighScoreBlocks = toNumber(detection.flaggedTotal) ?? detection.flagged.length;
  const truncationNotice = detection.annotationsTruncated
    ? `<p class="callout callout--info">${icon("i-alert")}<span>The detector returned ${totalBlocks} annotated blocks, including ${totalHighScoreBlocks} high-score passages. To keep the hosted response and browser record within safe limits, this record retains ${retainedBlocks} annotation blocks and ${retainedHighScoreBlocks} high-score excerpts; aggregate counts still cover the full detector response.</span></p>`
    : "";

  return `
    ${detection.verdict ? `<p class="verdict">${escapeHtml(detection.verdict)}</p>` : ""}
    <div class="stats-row">${chips.join("")}</div>
    ${body}
    ${truncationNotice}`;
}

function detectionCard(record) {
  const { detection, file } = record;
  const preview = state.previews.get(record.id);
  const missingPreview = `<div class="media-missing">Preview isn't kept after a reload. The SHA-256 fingerprint identifies the original.</div>`;
  let intro = "";
  let body = "";

  if (record.type === "text") {
    intro = record.source === "document" ? `Document: ${escapeHtml(file.name)}` : "Pasted text";
    body = textFindings(detection);
  } else if (record.type === "image") {
    intro = `${escapeHtml(file.name)} · ${formatBytes(file.size)}`;
    const signals = Array.isArray(detection.providerSignals) ? detection.providerSignals : [];
    const signalCards = signals
      .map((signal) => {
        const verdictLabel = signal.name === "AI or Not" ? "Provider label" : "Policy band";
        const verdictValue = signal.rawVerdict || signal.verdict.replaceAll("_", " ");
        return `
        <div class="detector-signal">
          <span>${escapeHtml(signal.name)}</span>
          <strong class="tone-${aiTone(signal.aiPct)}">${signal.aiPct == null ? "n/a" : `${signal.aiPct}%`}</strong>
          <p>${escapeHtml(`${verdictLabel}: ${verdictValue}`)}${signal.humanPct == null ? "" : ` · ${signal.humanPct}% human score`}</p>
          ${signal.requestId ? `<small>Request ${escapeHtml(signal.requestId)}</small>` : ""}
        </div>`;
      })
      .join("");
    const generatorNames = { four_o: "GPT-4o", dall_e: "DALL·E", stable_diffusion: "Stable Diffusion", adobe_firefly: "Adobe Firefly", nano_banana: "Nano Banana", midjourney: "Midjourney", flux: "Flux" };
    const generatorHints = (detection.generators || [])
      .filter((item) => !["ai", "human"].includes(item.id) && item.confidence >= 10)
      .slice(0, 3)
      .map((item) => `<span class="stat-chip"><b>${item.confidence}%</b> ${escapeHtml(generatorNames[item.id] || item.id.replaceAll("_", " "))} hint</span>`)
      .join("");
    const reviewNotice = detection.disagreement
      ? `<p class="callout">${icon("i-alert")}<span>The detectors fall into different policy bands. Aright has not classified this image as human; the result is inconclusive and needs provenance or manual review.</span></p>`
      : detection.policyVerdict === "inconclusive"
        ? `<p class="callout callout--info">${icon("i-alert")}<span>The available signals are too close to the decision boundary. Treat this result as inconclusive.</span></p>`
        : "";
    const localOnlyNotice = signals.length
      ? ""
      : state.server.providers?.image?.configured
        ? `<p class="callout callout--info">${icon("i-alert")}<span>This saved record used an older local-only image check. Choose “Analyze a new version” and upload the original again to run AI or Not.</span></p>`
        : `<p class="callout callout--info">${icon("i-alert")}<span>This result uses the local Community Forensics model only. Configure AI or Not to add an external provider signal.</span></p>`;
    body = `
      <div class="media-preview">
        ${preview ? `<img src="${escapeHtml(preview)}" alt="Analyzed image: ${escapeHtml(record.name)}" />` : missingPreview}
        <div>
          <p class="verdict">${escapeHtml(detection.verdict || aiHeadline(detection.aiPct, detection))}</p>
          <div class="stats-row"><span class="stat-chip"><b>${detection.aiPct}%</b> ${signals.length ? "AI or Not AI-class score" : "local synthetic-image score"}</span></div>
        </div>
      </div>
      ${localOnlyNotice}
      ${reviewNotice}
      ${signalCards ? `<div class="detector-signals">${signalCards}</div>` : ""}
      ${generatorHints ? `<div class="stats-row">${generatorHints}</div><p class="note">Generator hints are model similarities, not generator identification.</p>` : ""}
      ${detection.c2pa ? `<p class="note note--block">C2PA status reported by AI or Not: <strong>${escapeHtml(detection.c2pa.status || "unknown")}</strong>. Missing metadata does not prove that an image is human-made.</p>` : ""}`;
  } else if (record.type === "video") {
    const scanned = detection.frames.filter((frame) => frame.aiPct != null);
    const flagged = scanned.filter((frame) => (frame.policyVerdict ? frame.policyVerdict === "likely_ai" : frame.aiPct >= 75));
    const failed = detection.frames.length - scanned.length;
    intro = `${escapeHtml(file.name)} · ${formatBytes(file.size)} · ${plural(detection.frames.length, "frame")} sampled`;
    const frames = detection.frames
      .map((frame) => {
        const time = formatTime(frame.time);
        const value = frame.aiPct == null ? `<b class="tone-none">n/a</b>` : `<b class="tone-${aiTone(frame.aiPct)}">${frame.aiPct}%</b>`;
        return `
          <figure class="frame${(frame.policyVerdict ? frame.policyVerdict === "likely_ai" : frame.aiPct >= 75) ? " is-flagged" : ""}">
            <img src="${escapeHtml(frame.thumb)}" alt="Frame at ${time}" />
            <figcaption><span>${time}</span>${value}</figcaption>
          </figure>`;
      })
      .join("");
    body = `
      <p class="verdict">${escapeHtml(detection.verdict || aiHeadline(detection.aiPct, detection))}</p>
      <div class="stats-row">
        <span class="stat-chip"><b>${detection.aiPct}%</b> median frame-model score</span>
        <span class="stat-chip"><b>${flagged.length}</b> of ${scanned.length} high-signal frames</span>
        ${failed ? `<span class="stat-chip"><b>${failed}</b> not scored</span>` : ""}
      </div>
      <div class="frames">${frames}</div>
      <p class="note">Frame-level synthetic-image screening does not test motion, face swaps, or the soundtrack.</p>`;
  } else {
    intro = `${escapeHtml(file.name)} · ${formatBytes(file.size)}`;
    const player = file && preview ? `<audio class="player" controls src="${escapeHtml(preview)}"></audio>` : "";
    const segments = detection.segments || [];
    const external = usesAiOrNot(detection);
    const threshold = detection.model?.threshold || 0.939693808555603;
    const high = segments.filter((segment) => segment.score >= threshold).length;
    const inputChecks = detection.inputChecks || {};
    body = external ? `
      ${player}
      <p class="verdict">${escapeHtml(detection.verdict || aiHeadline(detection.aiPct, detection))}</p>
      <div class="stats-row">
        <span class="stat-chip"><b>${detection.aiPct}%</b> AI or Not voice score</span>
        ${detection.duration == null ? "" : `<span class="stat-chip"><b>${formatTime(detection.duration)}</b> provider-tested audio</span>`}
      </div>
      <p class="callout callout--info">${icon("i-alert")}<span>This external model screens spoken voice for AI generation. It does not analyze AI music, establish identity, or prove authorship.</span></p>
      ${detection.transcript?.checked ? `<div style="margin-top:16px"><h3 class="group-title">Separate script analysis</h3>${textFindings(detection.transcript)}</div>` : ""}`
    : `
      ${player}
      <p class="verdict">${escapeHtml(detection.verdict || aiHeadline(detection.aiPct, detection))}</p>
      <div class="stats-row">
        <span class="stat-chip"><b>${detection.aiPct}%</b> speech anti-spoofing score</span>
        <span class="stat-chip"><b>${segments.length}</b> windows checked</span>
        <span class="stat-chip"><b>${high}</b> above the model threshold</span>
      </div>
      <p class="callout callout--info">${icon("i-alert")}<span>This research model detects synthetic or cloned speech. It does not detect AI-generated music, melodies, or non-speech sound.</span></p>
      ${detection.model?.policyValidated === false ? `<p class="callout callout--info">${icon("i-alert")}<span>The maximum-over-windows score and multi-window verdict rule are an uncalibrated Aright policy, not a model-validated probability. Use them as a review signal only.</span></p>` : ""}
      ${inputChecks.shortClipRepeatedToModelWindow ? `<p class="callout callout--info">${icon("i-alert")}<span>This clip was shorter than the model's 4.04-second input window, so the captured audio was repeated to fill that window. Interpret the score cautiously.</span></p>` : ""}
      <p class="note">Input screening uses an audibility/RMS gate only; it does not independently verify that the recording contains speech.</p>
      ${detection.transcript?.checked ? `<div style="margin-top:16px"><h3 class="group-title">Separate script analysis</h3>${textFindings(detection.transcript)}</div>` : ""}`;
  }

  return `
    <article class="box section-card">
      <div class="section-card__head">
        <div><h2><span class="step-no">2</span>What the models found</h2><p>${intro}</p></div>
      </div>
      ${body}
    </article>`;
}

function taskItem(task) {
  const quotes = task.quotes || [];
  const expanded = state.expandedQuotes.has(`${state.currentId}:${task.id}`);
  const visible = expanded ? quotes : quotes.slice(0, QUOTES_VISIBLE);
  const hiddenCount = quotes.length - visible.length;
  return `
    <li class="task${task.done ? " is-done" : ""}">
      <input type="checkbox" id="task-${task.id}" data-task="${task.id}" ${task.done ? "checked" : ""} />
      <div class="task__body">
        <div class="task__top">
          <label class="task__title" for="task-${task.id}">${escapeHtml(task.title)}</label>
          <span class="prio prio--${task.priority}">${task.priority}</span>
        </div>
        <p class="task__detail">${escapeHtml(task.detail)}</p>
        ${visible.length ? `<ul class="task__quotes">${visible.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul>` : ""}
        ${hiddenCount > 0 ? `<button class="task__more" type="button" data-more="${task.id}">Show ${hiddenCount} more</button>` : ""}
      </div>
    </li>`;
}

function planCard(record) {
  const total = record.tasks.length;
  const done = record.tasks.filter((task) => task.done).length;
  const tasks = total
    ? `<div class="progress">
         <span>${done} of ${plural(total, "task")} done</span>
         <span class="progress__bar" aria-hidden="true"><i style="width:${(done / total) * 100}%"></i></span>
       </div>
       <h3 class="group-title">Assigned to you</h3>
       <ul class="tasks">${record.tasks.map(taskItem).join("")}</ul>`
    : `<p class="callout callout--info">${icon("i-check")}<span>Nothing remains on the checklist. Complete the final review.</span></p>`;

  return `
    <article class="box section-card">
      <div class="section-card__head">
        <div><h2><span class="step-no">3</span>Action plan: what to fix</h2><p>Highest priority first. A checked task is your completion declaration; it updates the readiness score but does not verify an attachment.</p></div>
      </div>
      ${tasks}
      <h3 class="group-title">Handled by Aright</h3>
      <ul class="auto-list">${automatedSteps(record).map((step) => `<li>${icon("i-check")}<span>${escapeHtml(step)}</span></li>`).join("")}</ul>
    </article>`;
}

function protectionCard(record, status) {
  const open = openTasks(record).length;
  const sentence = {
    "at-risk": `${plural(open, "open task")} before the final review can be completed.`,
    action: `${plural(open, "open task")} before the final review can be completed.`,
    review: "All checklist tasks are declared done. Review the result, then complete the workflow.",
    protected: "Review complete. Keep the downloaded evidence record with the original asset.",
  }[status];

  const original = record.file
    ? `${escapeHtml(record.file.name)} · ${formatBytes(record.file.size)}`
    : `Pasted text · ${(record.detection.text || "").length.toLocaleString()} characters`;
  const detector = `${modelLabel(record)}${record.type === "video" ? " · sampled frames" : ""}`;

  const primary =
    status === "protected"
      ? `<button class="btn btn--outline" type="button" data-action="reopen">Reopen</button>`
      : `<button class="btn btn--maroon" type="button" data-action="protect" ${open ? "disabled" : ""}>${icon("i-shield")}Complete review</button>`;

  return `
    <article class="box section-card">
      <div class="section-card__head">
        <div><h2><span class="step-no">4</span>Review &amp; protection</h2><p>${sentence}</p></div>
        <span class="tag tag--${STATUS[status].tag}">${STATUS[status].label}</span>
      </div>
      <dl class="evidence">
        <dt>Record ID</dt><dd class="mono">${escapeHtml(record.id)}</dd>
        <dt>Analyzed</dt><dd>${escapeHtml(formatDate(record.createdAt))}</dd>
        <dt>Original</dt><dd>${original}</dd>
        <dt>SHA-256</dt><dd class="mono">${record.fingerprint || "Not computed (needs HTTPS or localhost, and files under 250 MB)"}</dd>
        <dt>Detector</dt><dd>${detector}</dd>
        ${record.protectedAt ? `<dt>Review completed</dt><dd>${escapeHtml(formatDate(record.protectedAt))}</dd>` : ""}
      </dl>
      <div class="actions">
        ${primary}
        <button class="btn btn--outline" type="button" data-action="download">${icon("i-download")}Download evidence</button>
        <button class="btn btn--outline" type="button" data-action="rescan">Analyze a new version</button>
      </div>
      <p class="disclaimer">Model scores are screening signals, not proof of authorship, infringement, or legal protection. Checklist completion is self-attested; the downloaded JSON is not a signed or tamper-evident legal record. IPR readiness is documentation guidance, not legal advice.</p>
    </article>`;
}

function rawCard(record) {
  if (record.raw == null) return "";
  return `
    <details class="box section-card raw">
      <summary>Raw model record</summary>
      <pre>${escapeHtml(JSON.stringify(record.raw, null, 2))}</pre>
    </details>`;
}

const REPORT_TAB_ORDER = ["findings", "plan", "review"];

function preferredReportTab(record) {
  return openTasks(record).length ? "plan" : "review";
}

function activeReportTab(record) {
  const saved = state.reportTabs.get(record.id);
  return REPORT_TAB_ORDER.includes(saved) ? saved : preferredReportTab(record);
}

function reportWorkspace(record, status) {
  const active = activeReportTab(record);
  const open = openTasks(record).length;
  const ai = record.detection.aiPct;
  const tabs = [
    { id: "findings", label: "Findings", meta: ai == null ? "Not scanned" : `${Math.round(ai)}% signal` },
    { id: "plan", label: "Action plan", meta: open ? `${open} open` : "Complete" },
    { id: "review", label: "Review", meta: STATUS[status].label },
  ];
  const tabList = tabs.map((tab) => {
    const selected = tab.id === active;
    return `<button class="report-tab${selected ? " is-active" : ""}" type="button" role="tab" id="report-tab-${tab.id}" aria-controls="report-panel-${tab.id}" aria-selected="${selected}" tabindex="${selected ? "0" : "-1"}" data-report-tab="${tab.id}"><span>${tab.label}</span><small>${tab.meta}</small></button>`;
  }).join("");
  const panel = (id, content) => `<section class="report-tabpanel" id="report-panel-${id}" role="tabpanel" aria-labelledby="report-tab-${id}" tabindex="0" data-report-panel="${id}"${id === active ? "" : " hidden"}>${content}</section>`;
  return `
    <section class="report-workspace" aria-label="Analysis report details">
      <div class="report-tabs" role="tablist" aria-label="Report sections">${tabList}</div>
      <div class="report-tabpanels">
        ${panel("findings", detectionCard(record))}
        ${panel("plan", planCard(record))}
        ${panel("review", `${protectionCard(record, status)}${rawCard(record)}`)}
      </div>
    </section>`;
}

function activateReportTab(tab, { focus = false } = {}) {
  const record = currentRecord();
  if (!record || !REPORT_TAB_ORDER.includes(tab)) return;
  const button = $(`[data-report-tab="${tab}"]`, els.report);
  if (!button) return;
  state.reportTabs.set(record.id, tab);
  $$('[data-report-tab]', els.report).forEach((item) => {
    const selected = item.dataset.reportTab === tab;
    item.classList.toggle("is-active", selected);
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  $$('[data-report-panel]', els.report).forEach((item) => {
    item.hidden = item.dataset.reportPanel !== tab;
  });
  if (focus) button.focus({ preventScroll: true });
}

function renderReport(record, { animate = false } = {}) {
  const score = scoreOf(record);
  const status = statusOf(record);
  if (!state.reportTabs.has(record.id)) state.reportTabs.set(record.id, preferredReportTab(record));
  const selectedTab = activeReportTab(record);
  const isSameRecord = els.report.dataset.recordId === record.id;
  const previousScroll = isSameRecord
    ? $(`[data-report-panel="${selectedTab}"]`, els.report)?.scrollTop || 0
    : 0;
  els.report.innerHTML = [
    summaryCard(record, score, status, animate),
    reportWorkspace(record, status),
  ].join("");
  els.report.dataset.recordId = record.id;
  const restoredPanel = $(`[data-report-panel="${selectedTab}"]`, els.report);
  if (restoredPanel) restoredPanel.scrollTop = previousScroll;
  updateFlow(stageFor(record));

  if (animate) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        $$(".ring__fill", els.report).forEach((circle) => {
          circle.style.strokeDashoffset = circle.dataset.offset;
        });
      });
    });
  }
}

function showRecord(record, options) {
  state.currentId = record.id;
  showOnly(els.report);
  renderReport(record, options);
}

function focusReportHeading() {
  const heading = $("h2", els.report);
  if (!heading) return;
  heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

const currentRecord = () => state.assets.find((asset) => asset.id === state.currentId);

/* ---------- Register & vault ---------- */
function renderCollections() {
  renderOverview();
  renderRegister();
  renderVault();
  if (els.commandMenu?.open) renderCommandResults(els.commandInput.value);
}

function overviewRow(asset, context) {
  const readiness = scoreOf(asset).total;
  const statusKey = statusOf(asset);
  const status = STATUS[statusKey];
  const secondary = context === "attention" ? nextAction(asset) : `${TYPE_LABEL[asset.type]} · ${formatDate(asset.createdAt)}`;
  return `
    <button class="overview-row" type="button" data-open="${escapeHtml(asset.id)}">
      <span class="overview-row__icon">${icon(TYPE_ICON[asset.type])}</span>
      <span class="overview-row__copy"><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(secondary)}</small></span>
      <span class="overview-row__meta"><b class="score score--${iprTone(readiness)}">${readiness}</b><span class="tag tag--${status.tag}">${status.label}</span></span>
    </button>`;
}

function renderOverview() {
  if (!els.overviewMetrics) return;
  const assets = [...state.assets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const statuses = assets.map(statusOf);
  const scores = assets.map((asset) => scoreOf(asset).total);
  const average = scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null;
  const actionCount = statuses.filter((status) => status === "at-risk" || status === "action").length;
  const openCount = assets.reduce((sum, asset) => sum + openTasks(asset).length, 0);
  const completeCount = statuses.filter((status) => status === "protected").length;
  const metrics = [
    { value: average ?? "–", label: "Average readiness", note: scores.length ? "Across analyzed assets" : "No assets analyzed", tone: average == null ? "none" : iprTone(average), primary: true },
    { value: actionCount, label: "Require attention", note: actionCount ? "Risk or action status" : "No urgent records", tone: actionCount ? "low" : "ok" },
    { value: openCount, label: "Open checklist tasks", note: openCount ? "Across the workspace" : "Nothing outstanding", tone: openCount ? "mid" : "ok" },
    { value: completeCount, label: "Review complete", note: assets.length ? `${Math.round((completeCount / assets.length) * 100)}% of assets` : "Awaiting first review", tone: completeCount ? "ok" : "none" },
  ];
  els.overviewMetrics.innerHTML = metrics.map((metric) => `
    <li class="overview-metric${metric.primary ? " overview-metric--primary" : ""}">
      <span class="overview-metric__label">${metric.label}</span>
      <strong class="tone-${metric.tone}">${metric.value}</strong>
      <small>${metric.note}</small>
    </li>`).join("");

  const priorityRank = { "at-risk": 0, action: 1, review: 2, protected: 3 };
  const attention = assets
    .filter((asset) => statusOf(asset) !== "protected")
    .sort((a, b) => priorityRank[statusOf(a)] - priorityRank[statusOf(b)] || new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
  els.attentionList.classList.toggle("is-empty", attention.length === 0);
  els.attentionList.innerHTML = attention.length
    ? attention.map((asset) => overviewRow(asset, "attention")).join("")
    : `<div class="overview-empty"><span class="overview-empty__mark">${icon("i-check")}</span><div><strong>${assets.length ? "Nothing urgent" : "No analyses yet"}</strong><p>${assets.length ? "Every current record is through review." : "Run the first asset screening to create your priority queue."}</p></div>${assets.length ? "" : `<button class="text-action" type="button" data-view-target="analyze">Start analysis</button>`}</div>`;

  const recent = assets.slice(0, 5);
  els.recentList.classList.toggle("is-empty", recent.length === 0);
  els.recentList.innerHTML = recent.length
    ? recent.map((asset) => overviewRow(asset, "recent")).join("")
    : `<div class="overview-empty"><span class="overview-empty__mark overview-empty__mark--muted">${icon("i-clock")}</span><div><strong>No recent activity</strong><p>Completed analyses will appear here automatically.</p></div></div>`;
}

function renderRegister() {
  const assets = state.assets;
  els.assetCount.textContent = String(assets.length);

  const scores = assets.map((asset) => scoreOf(asset).total);
  const statuses = assets.map(statusOf);
  const average = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const kpis = [
    [assets.length, "Assets analyzed"],
    [average ?? "–", "Average IPR score"],
    [statuses.filter((s) => s === "at-risk").length, "At risk"],
    [statuses.filter((s) => s === "protected").length, "Review complete"],
  ];
  els.kpis.innerHTML = kpis.map(([value, label]) => `<li class="kpi"><strong>${value}</strong><span>${label}</span></li>`).join("");

  const query = String(els.registerSearch?.value || "").trim().toLowerCase();
  const statusFilter = els.registerStatusFilter?.value || "all";
  const visibleAssets = assets.filter((asset) => {
    const matchesQuery = !query || `${asset.name} ${asset.id} ${TYPE_LABEL[asset.type]}`.toLowerCase().includes(query);
    const matchesStatus = statusFilter === "all" || statusOf(asset) === statusFilter;
    return matchesQuery && matchesStatus;
  });
  els.registerEmpty.hidden = visibleAssets.length > 0;
  els.registerEmpty.textContent = assets.length ? "No assets match the current search or status filter." : "No assets yet. Run your first analysis to start the register.";
  els.registerBody.innerHTML = visibleAssets
    .map((asset) => {
      const ai = asset.detection.aiPct;
      const score = scoreOf(asset).total;
      const status = STATUS[statusOf(asset)];
      const name = escapeHtml(asset.name);
      return `
        <tr>
          <td><button class="register__name" type="button" data-open="${asset.id}">${name}</button></td>
          <td>${TYPE_LABEL[asset.type]}</td>
          <td>${ai == null ? `<span class="tone-none">Not scanned</span>` : `<b class="score score--${detectionTone(asset.detection)}">${ai}%</b>`}</td>
          <td><b class="score score--${iprTone(score)}">${score}</b></td>
          <td><span class="tag tag--${status.tag}">${status.label}</span></td>
          <td>${escapeHtml(nextAction(asset))}</td>
          <td class="muted">${escapeHtml(formatDate(asset.createdAt))}</td>
          <td>
            <div class="row-actions">
              <button class="icon-btn" type="button" data-download="${asset.id}" aria-label="Download evidence for ${name}" title="Download evidence">${icon("i-download")}</button>
              <button class="icon-btn" type="button" data-delete="${asset.id}" aria-label="Delete ${name}" title="Delete">${icon("i-close")}</button>
            </div>
          </td>
        </tr>`;
    })
    .join("");
}

function renderVault() {
  els.vaultEmpty.hidden = state.assets.length > 0;
  els.exportAll.disabled = state.assets.length === 0;
  els.vault.innerHTML = state.assets
    .map((asset) => {
      const original = asset.file ? `${asset.file.name} · ${formatBytes(asset.file.size)}` : "Pasted text";
      return `
        <li class="vault__item">
          <div>
            <h3>${escapeHtml(asset.name)}</h3>
            <p class="vault__meta">
              <span>${escapeHtml(asset.id)}</span><span>${TYPE_LABEL[asset.type]}</span>
              <span>${escapeHtml(formatDate(asset.createdAt))}</span><span>${escapeHtml(original)}</span>
              <span>${STATUS[statusOf(asset)].label}</span>
            </p>
            <p class="vault__hash mono">SHA-256 ${asset.fingerprint || "not computed"}</p>
          </div>
          <button class="btn btn--outline btn--sm" type="button" data-download="${asset.id}">${icon("i-download")}Download</button>
        </li>`;
    })
    .join("");
}

function evidenceOf(record) {
  const score = scoreOf(record);
  const { detection } = record;
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    source: record.source,
    analyzedAt: record.createdAt,
    original: record.file,
    sha256: record.fingerprint,
    declaredDetails: record.details,
    effectiveDetails: effectiveDetails(record),
    iprScore: score.total,
    scoreBreakdown: score.parts,
    status: STATUS[statusOf(record)].label,
    reviewCompletedAt: record.protectedAt,
    detection: {
      detector: modelLabel(record),
      model: modelInfoOf(record),
      scanned: detection.checked,
      aiModelScore: detection.aiPct,
      scoreSemantics: "screening-model score; not a calibrated authorship probability",
      verdict: detection.verdict || null,
      policyVerdict: detection.policyVerdict || null,
      providerVerdict: detection.providerVerdict || null,
      detectorDisagreement: Boolean(detection.disagreement),
      providerSignals: detection.providerSignals || [],
      generatorHints: detection.generators || [],
      c2pa: detection.c2pa || null,
      flaggedPassages: detection.flagged || [],
      frames: detection.frames?.map(({ time, aiPct, verdict, policyVerdict, providerVerdict, disagreement, error }) => ({
        time: round1(time), aiPct, verdict, policyVerdict, providerVerdict, disagreement: Boolean(disagreement), error,
      })),
      videoAggregation: detection.aggregation || null,
      videoCoverage: detection.coverage || null,
      audioSegments: detection.segments || [],
      audioInputChecks: detection.inputChecks || null,
      transcript: detection.transcript || null,
    },
    actionPlan: record.tasks.map(({ id, title, priority, done }) => ({ id, title, priority, done })),
    rawModelRecord: record.raw,
  };
}

function downloadJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadEvidence(id) {
  const record = state.assets.find((asset) => asset.id === id);
  if (!record) return;
  downloadJson(`aright-evidence-${record.id}.json`, {
    format: "aright-evidence/1",
    exportedAt: new Date().toISOString(),
    records: [evidenceOf(record)],
  });
}

function deleteAsset(id) {
  const record = state.assets.find((asset) => asset.id === id);
  if (!record) return;
  if (!window.confirm(`Delete “${record.name}” and its evidence record from this browser? Download the evidence first if you need it.`)) return;
  state.assets = state.assets.filter((asset) => asset.id !== id);
  state.reportTabs.delete(id);
  saveAssets();
  if (state.currentId === id) {
    state.currentId = null;
    showOnly(els.emptyState);
    updateFlow("upload");
  }
  renderCollections();
}

/* ---------- Command menu ---------- */
function renderCommandResults(query = "") {
  if (!els.commandResults) return;
  const needle = query.trim().toLowerCase();
  const actions = [
    { label: "Overview", detail: "Workspace status and recent activity", view: "overview", icon: "i-home" },
    { label: "New analysis", detail: "Screen a text, image, video or audio asset", view: "analyze", icon: "i-plus" },
    { label: "Asset register", detail: "Browse readiness and review status", view: "assets", icon: "i-facet" },
    { label: "Evidence vault", detail: "Export fingerprints and model records", view: "evidence", icon: "i-folder" },
  ].filter((item) => !needle || `${item.label} ${item.detail}`.toLowerCase().includes(needle));
  const assets = state.assets
    .filter((asset) => !needle || `${asset.name} ${asset.id} ${TYPE_LABEL[asset.type]}`.toLowerCase().includes(needle))
    .slice(0, 6);
  const actionRows = actions.map((item) => `
    <li><button type="button" data-command-view="${item.view}">${icon(item.icon)}<span><strong>${item.label}</strong><small>${item.detail}</small></span><kbd>↵</kbd></button></li>`).join("");
  const assetRows = assets.map((asset) => `
    <li><button type="button" data-command-open="${escapeHtml(asset.id)}">${icon(TYPE_ICON[asset.type])}<span><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(asset.id)} · ${TYPE_LABEL[asset.type]} · IPR ${scoreOf(asset).total}</small></span><kbd>↵</kbd></button></li>`).join("");
  els.commandResults.innerHTML = `${actionRows}${assets.length ? `<li class="command-menu__divider"><span>Assets</span></li>${assetRows}` : ""}${!actionRows && !assetRows ? `<li class="command-menu__empty">No matching actions or assets</li>` : ""}`;
}

function openCommandMenu() {
  if (!els.commandMenu || document.body.classList.contains("is-locked") || document.body.classList.contains("is-checking-access")) return;
  els.commandInput.value = "";
  renderCommandResults();
  if (typeof els.commandMenu.showModal === "function") els.commandMenu.showModal();
  else els.commandMenu.setAttribute("open", "");
  requestAnimationFrame(() => els.commandInput.focus());
}

function closeCommandMenu() {
  els.commandMenu.close?.();
  els.commandMenu.removeAttribute("open");
}

function executeCommand(button) {
  const view = button?.dataset.commandView;
  const id = button?.dataset.commandOpen;
  closeCommandMenu();
  if (view) {
    showView(view, { focus: true });
    return;
  }
  if (id) {
    const record = state.assets.find((asset) => asset.id === id);
    if (!record) return;
    showView("analyze");
    showRecord(record);
    els.results.scrollIntoView({ block: "start" });
    focusReportHeading();
  }
}

/* ---------- Views ---------- */
function showView(name, { focus = false } = {}) {
  const view = els.views.find((v) => v.id === `view-${name}`) ? name : "overview";
  els.sideLinks.forEach((link) => {
    const active = link.dataset.view === view;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  els.views.forEach((v) => {
    v.hidden = v.id !== `view-${view}`;
    v.classList.toggle("is-active", !v.hidden);
  });
  const routeBase = `${location.pathname}${location.search}`;
  history.replaceState(null, "", view === "overview" ? routeBase : `${routeBase}#${view}`);
  const labels = { overview: "Overview", analyze: "New analysis", assets: "Asset register", evidence: "Evidence vault" };
  if (els.topbarWorkspace) els.topbarWorkspace.textContent = labels[view];
  window.scrollTo({ top: 0 });
  if (focus) $(`#view-${view} .view__title`)?.focus({ preventScroll: true });
}

/* ---------- Intake ---------- */
function setType(type, moveFocus = false) {
  const requested = els.typeButtons.find((button) => button.dataset.type === type);
  if (requested?.disabled) {
    els.intakeError.textContent = requested.title || `${TYPE_LABEL[type]} analysis is unavailable.`;
    return;
  }
  state.type = type;
  els.typeButtons.forEach((button) => {
    const active = button.dataset.type === type;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && moveFocus) button.focus();
  });
  els.panes.forEach((pane) => {
    pane.hidden = pane.dataset.pane !== type;
  });
  els.intakeError.textContent = "";
  updateCostHint();
}

function updateCostHint() {
  const externalImage = Boolean(state.server.providers?.image?.configured);
  const cloud = isCloudService();
  const localComparison = state.server.providers?.image?.localComparison !== false;
  const failoverConfigured = Boolean(
    state.server.providerFailover?.configured || state.server.providers?.image?.failoverConfigured,
  );
  const attemptHint = failoverConfigured
    ? "normally 1 metered attempt; up to 2 only on credential failover"
    : "1 metered provider attempt";
  const hints = {
    text: cloud ? `AI or Not text detector · ${attemptHint} · minimum 250 characters and about 64 words.` : "Fakespot / Mozilla RoBERTa · English text · self-hosted.",
    image: externalImage
      ? localComparison
        ? `AI or Not external check + Community Forensics local comparison · ${attemptHint}.`
        : `AI or Not external image check · ${attemptHint} · hosted limit 4 MB.`
      : "Community Forensics ViT-384 · local-only because AI or Not is not configured.",
    video: externalImage
      ? `${els.frameCount.value} sampled frames · ${attemptHint} per frame${localComparison ? " + local comparison" : ""}.`
      : `${els.frameCount.value} sampled frames · local Community Forensics only.`,
    audio: cloud
      ? isHostedAudioAvailable()
        ? `AI or Not voice detector${els.transcriptInput.value.trim() ? " + separate AI or Not script check" : ""} · voice and script are separately metered; ${attemptHint} per call · speech only.`
        : "Hosted audio detection unavailable · use the local Spectra-AASIST3 console."
      : els.transcriptInput.value.trim()
      ? "Spectra-AASIST3 speech screening + separate RoBERTa script screening."
      : "Spectra-AASIST3 · synthetic or cloned speech only.",
  };
  els.costHint.textContent = hints[state.type];
}

function updateDetailsSummary() {
  if (!els.detailsSummary) return;
  const human = {
    none: "No human contribution",
    light: "Light contribution",
    substantial: "Substantial contribution",
    human: "Human-made",
  }[els.humanInput.value];
  const intendedUse = { internal: "Internal", commercial: "Commercial", brand: "Brand use" }[els.useInput.value];
  const licence = { yes: "Licence checked", unsure: "Licence unchecked", no: "Use not allowed" }[els.licenseInput.value];
  const provenance = els.provenanceInput.checked ? "Sources saved" : "Sources not saved";
  els.detailsSummary.textContent = `${human} · ${intendedUse} · ${licence} · ${provenance}`;
}

function updateCharCount() {
  const count = els.textInput.value.length;
  els.charCount.textContent = `${count.toLocaleString()} character${count === 1 ? "" : "s"}`;
}

function setFile(slot, file) {
  const input = $(`[data-input="${slot}"]`);
  if (file) {
    const error = validateFile(slot, file);
    if (error) {
      els.intakeError.textContent = error;
      input.value = "";
      return;
    }
  }
  els.intakeError.textContent = "";

  const oldUrl = state.slotUrls[slot];
  if (oldUrl && !state.usedUrls.has(oldUrl)) URL.revokeObjectURL(oldUrl);
  delete state.slotUrls[slot];

  state.files[slot] = file;
  if (!file) input.value = "";
  renderChosen(slot);

  if (slot === "doc") {
    els.textInput.disabled = Boolean(file);
    els.textInput.placeholder = file
      ? "Document selected. Remove it to paste text instead."
      : "Marketing copy, an article, a script, product descriptions…";
  }
  if (!els.assetName.value.trim() && file) els.assetName.placeholder = baseName(file.name);
}

function renderChosen(slot) {
  const wrap = $(`[data-slot="${slot}"]`);
  const drop = $(".drop", wrap);
  const chosen = $(".chosen", wrap);
  const file = state.files[slot];
  drop.hidden = Boolean(file);
  chosen.hidden = !file;
  if (!file) {
    chosen.innerHTML = "";
    return;
  }

  let media = "";
  if (slot === "image") media = `<img src="${slotUrl(slot)}" alt="Selected image preview" />`;
  if (slot === "video") media = `<video src="${slotUrl(slot)}" controls muted playsinline preload="metadata"></video>`;
  if (slot === "audio") media = `<audio src="${slotUrl(slot)}" controls preload="metadata"></audio>`;

  const name = escapeHtml(file.name);
  chosen.innerHTML = `
    ${media}
    <div class="chosen__row">
      ${icon(SLOT_ICON[slot])}
      <span class="chosen__name" title="${name}">${name}</span>
      <span class="chosen__size">${formatBytes(file.size)}</span>
      <button class="icon-btn" type="button" data-remove="${slot}" aria-label="Remove ${name}">${icon("i-close")}</button>
    </div>`;
}

function prefillFrom(record) {
  const details = effectiveDetails(record);
  setType(record.type);
  if (record.type === "text") setFile("doc", null);
  else setFile(record.type, null);
  els.assetName.value = record.name;
  els.aiTool.value = details.tool;
  els.humanInput.value = details.human;
  els.useInput.value = details.use;
  els.licenseInput.value = details.license;
  els.provenanceInput.checked = details.provenance;
  if (record.type === "text") {
    els.textInput.value = record.source === "paste" ? record.detection.text : "";
    updateCharCount();
  }
  if (record.type === "audio") els.transcriptInput.value = record.detection.transcript?.text || "";
  updateDetailsSummary();
  updateCostHint();
  showView("analyze");
  els.intake.scrollIntoView({ behavior: motionQuery.matches ? "auto" : "smooth", block: "start" });
  const target = $(`[data-pane="${record.type}"] textarea:not([disabled]), [data-pane="${record.type}"] .drop__input`);
  target?.focus({ preventScroll: true });
}

/* ---------- Access key ---------- */
function openUnlock() {
  if (els.unlock.open) return;
  if (typeof els.unlock.showModal === "function") els.unlock.showModal();
  else els.unlock.setAttribute("open", "");
  els.unlockInput.focus();
}

/* ---------- Events ---------- */
els.unlock.addEventListener("cancel", (event) => {
  if (document.body.classList.contains("is-locked")) event.preventDefault();
});

els.sideLinks.forEach((link) => {
  link.addEventListener("click", () => showView(link.dataset.view, { focus: true }));
});

els.main.addEventListener("click", (event) => {
  const target = event.target.closest("[data-view-target], [data-overview-view]");
  if (target) {
    showView(target.dataset.viewTarget || target.dataset.overviewView, { focus: true });
    return;
  }
  const shortcut = event.target.closest("[data-empty-type]");
  if (shortcut) {
    setType(shortcut.dataset.emptyType);
    $("[data-pane]:not([hidden]) textarea, [data-pane]:not([hidden]) .drop__input")?.focus({ preventScroll: true });
  }
});

els.newAnalysisBtn.addEventListener("click", () => showView("analyze", { focus: true }));
els.overviewNewAnalysis.addEventListener("click", () => showView("analyze", { focus: true }));

els.typeButtons.forEach((button, index) => {
  button.addEventListener("click", () => setType(button.dataset.type));
  button.addEventListener("keydown", (event) => {
    const last = els.typeButtons.length - 1;
    let next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" || event.key === "End" ? -1 : 1;
    while (els.typeButtons[next]?.disabled && next !== index) next = (next + direction + els.typeButtons.length) % els.typeButtons.length;
    setType(els.typeButtons[next].dataset.type, true);
  });
});

$$(".drop__input").forEach((input) => {
  input.addEventListener("change", () => {
    if (input.files[0]) setFile(input.dataset.input, input.files[0]);
  });
});

$$(".drop").forEach((drop) => {
  const slot = $(".drop__input", drop).dataset.input;
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("is-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-over");
    const file = event.dataTransfer?.files?.[0];
    if (file) setFile(slot, file);
  });
});

els.intake.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove]");
  if (remove) setFile(remove.dataset.remove, null);
});

els.intake.addEventListener("submit", (event) => {
  event.preventDefault();
  runAnalysis();
});

els.textInput.addEventListener("input", updateCharCount);
els.transcriptInput.addEventListener("input", updateCostHint);
els.frameCount.addEventListener("change", updateCostHint);
[els.humanInput, els.useInput, els.licenseInput, els.provenanceInput].forEach((input) => input.addEventListener("change", updateDetailsSummary));
els.registerSearch.addEventListener("input", renderRegister);
els.registerStatusFilter.addEventListener("change", renderRegister);

els.report.addEventListener("change", (event) => {
  const input = event.target.closest("[data-task]");
  const record = currentRecord();
  if (!input || !record) return;
  const task = record.tasks.find((t) => t.id === input.dataset.task);
  if (!task) return;
  task.done = input.checked;
  if (!task.done) record.protectedAt = null;
  state.reportTabs.set(record.id, "plan");
  saveAssets();
  renderReport(record);
  renderCollections();
  $(`#task-${task.id}`)?.focus({ preventScroll: true });
});

els.report.addEventListener("click", (event) => {
  const reportTab = event.target.closest("[data-report-tab]");
  if (reportTab) {
    activateReportTab(reportTab.dataset.reportTab, { focus: true });
    return;
  }
  const record = currentRecord();
  if (!record) return;

  const more = event.target.closest("[data-more]");
  if (more) {
    state.expandedQuotes.add(`${record.id}:${more.dataset.more}`);
    renderReport(record);
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "protect" && record.tasks.every((t) => t.done)) record.protectedAt = new Date().toISOString();
  if (action === "reopen") record.protectedAt = null;
  if (action === "protect" || action === "reopen") {
    saveAssets();
    renderReport(record);
    renderCollections();
    $(`[data-action="${action === "protect" ? "reopen" : "protect"}"]`, els.report)?.focus({ preventScroll: true });
  }
  if (action === "download") downloadEvidence(record.id);
  if (action === "rescan") prefillFrom(record);
});

els.report.addEventListener("keydown", (event) => {
  const tab = event.target.closest("[data-report-tab]");
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = REPORT_TAB_ORDER.indexOf(tab.dataset.reportTab);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? REPORT_TAB_ORDER.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + REPORT_TAB_ORDER.length) % REPORT_TAB_ORDER.length;
  activateReportTab(REPORT_TAB_ORDER[next], { focus: true });
});

function onCollectionClick(event) {
  const open = event.target.closest("[data-open]");
  const download = event.target.closest("[data-download]");
  const remove = event.target.closest("[data-delete]");
  if (download) downloadEvidence(download.dataset.download);
  if (remove) deleteAsset(remove.dataset.delete);
  if (open) {
    const record = state.assets.find((asset) => asset.id === open.dataset.open);
    if (!record) return;
    showView("analyze");
    showRecord(record);
    els.results.scrollIntoView({ block: "start" });
    focusReportHeading();
  }
}

window.addEventListener("hashchange", () => showView(location.hash.slice(1) || "overview"));

els.registerBody.addEventListener("click", onCollectionClick);
els.vault.addEventListener("click", onCollectionClick);
els.attentionList.addEventListener("click", onCollectionClick);
els.recentList.addEventListener("click", onCollectionClick);

els.commandTrigger.addEventListener("click", openCommandMenu);
els.commandMenu.addEventListener("click", (event) => {
  if (event.target.closest("[data-command-close]")) closeCommandMenu();
});
els.commandInput.addEventListener("input", () => renderCommandResults(els.commandInput.value));
els.commandResults.addEventListener("click", (event) => {
  const button = event.target.closest("[data-command-view], [data-command-open]");
  if (button) executeCommand(button);
});
els.commandInput.addEventListener("keydown", (event) => {
  const buttons = $$("#commandResults button");
  if (event.key === "Enter" && buttons[0]) {
    event.preventDefault();
    executeCommand(buttons[0]);
  }
  if (event.key === "ArrowDown" && buttons[0]) {
    event.preventDefault();
    buttons[0].focus();
  }
});
els.commandResults.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
  const buttons = $$("#commandResults button");
  const current = buttons.indexOf(document.activeElement);
  if (event.key === "Enter" && current >= 0) {
    event.preventDefault();
    executeCommand(buttons[current]);
    return;
  }
  if (!buttons.length) return;
  event.preventDefault();
  const next = event.key === "ArrowDown" ? (current + 1) % buttons.length : (current <= 0 ? buttons.length - 1 : current - 1);
  buttons[next].focus();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommandMenu();
  }
});

els.exportAll.addEventListener("click", () => {
  if (!state.assets.length) return;
  downloadJson(`aright-evidence-${new Date().toISOString().slice(0, 10)}.json`, {
    format: "aright-evidence/1",
    exportedAt: new Date().toISOString(),
    records: state.assets.map(evidenceOf),
  });
});

els.unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  writeAccessKey(els.unlockInput.value);
  els.unlockError.textContent = "";
  await checkServer();
  if (state.server.authorized) {
    els.unlock.close?.();
    els.unlock.removeAttribute("open");
    els.unlockInput.value = "";
  } else {
    els.unlockError.textContent = state.server.online ? "That key isn't right." : "The server isn't reachable.";
  }
});

/* ---------- Start ---------- */
$$(".view__title").forEach((title) => title.setAttribute("tabindex", "-1"));
setType("text");
updateCharCount();
updateDetailsSummary();
updateFlow("upload");
showView(location.hash.slice(1) || "overview");
checkServer();
window.setInterval(() => {
  if (!state.busy && document.visibilityState === "visible") checkServer();
}, 15000);
