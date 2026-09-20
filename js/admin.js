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
const HUMAN_TARGET_PCT = 51;
const requestedApiPort = Number(new URLSearchParams(location.search).get("apiPort"));
const fileApiPort = Number.isInteger(requestedApiPort) && requestedApiPort > 0 && requestedApiPort <= 65535 ? requestedApiPort : 8000;
const API_BASE = location.protocol === "file:" ? `http://127.0.0.1:${fileApiPort}` : "";

const FILE_RULES = {
  doc: { max: 15 * MB, exts: ["pdf", "docx", "txt"], label: "a PDF, DOCX or TXT file" },
  image: { max: 10 * MB, min: 1024, exts: ["jpg", "jpeg", "png", "webp"], label: "a JPG, PNG or WEBP image" },
  video: { exts: ["mp4", "webm", "mov", "m4v"], mimePrefix: "video/", label: "an MP4, WEBM or MOV video" },
  audio: { max: 50 * MB, exts: ["mp3", "wav", "m4a", "ogg", "flac", "aac"], mimePrefix: "audio/", label: "an MP3, WAV, M4A, OGG or FLAC file" },
};

const TYPE_LABEL = { text: "Text", image: "Image", video: "Video", audio: "Audio", code: "Code" };
const TYPE_ICON = { text: "i-text", image: "i-image", video: "i-video", audio: "i-audio", code: "i-code" };
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
  analyzeView: $("#view-analyze"),
  analyzeTitle: $("#analyzeTitle"),
  analyzeLead: $("#view-analyze .view__lead"),
  flow: $("#flow"),
  flowSteps: $$("#flow li"),
  workspace: $(".workspace"),
  intake: $("#intake"),
  typeButtons: $$(".types__btn"),
  panes: $$(".pane"),
  textInput: $("#textInput"),
  repoUrl: $("#repoUrl"),
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
  detailsDisclosure: $(".details-disclosure"),
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
  reportObserver: null,
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

function normalizeWebUrl(value, { githubOnly = false } = {}) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (githubOnly && !["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return "";
    return url.href.slice(0, 500);
  } catch {
    return "";
  }
}

function normalizeIsoDate(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function normalizeCodeRepository(value) {
  if (!value || typeof value !== "object" || typeof value.url !== "string" || typeof value.fullName !== "string") return null;
  return {
    id: toNumber(value.id),
    fullName: value.fullName.slice(0, 220),
    url: normalizeWebUrl(value.url, { githubOnly: true }),
    owner: value.owner && typeof value.owner === "object" ? {
      login: String(value.owner.login || "").slice(0, 80),
      url: normalizeWebUrl(value.owner.url, { githubOnly: true }),
      type: String(value.owner.type || "User").slice(0, 30),
    } : null,
    description: String(value.description || "").slice(0, 500),
    homepage: normalizeWebUrl(value.homepage),
    primaryLanguage: String(value.primaryLanguage || "").slice(0, 80),
    topics: Array.isArray(value.topics) ? value.topics.slice(0, 12).map((item) => String(item || "").slice(0, 50)).filter(Boolean) : [],
    createdAt: normalizeIsoDate(value.createdAt),
    updatedAt: normalizeIsoDate(value.updatedAt),
    pushedAt: normalizeIsoDate(value.pushedAt),
    stats: {
      stars: Math.max(0, Math.round(toNumber(value.stats?.stars) || 0)),
      forks: Math.max(0, Math.round(toNumber(value.stats?.forks) || 0)),
      openIssuesAndPulls: Math.max(0, Math.round(toNumber(value.stats?.openIssuesAndPulls) || 0)),
      githubSizeKb: Math.max(0, Math.round(toNumber(value.stats?.githubSizeKb) || 0)),
    },
    defaultBranch: String(value.defaultBranch || "").slice(0, 220),
    treeSha: String(value.treeSha || "").slice(0, 100),
    fingerprint: String(value.fingerprint || "").slice(0, 128),
    archived: Boolean(value.archived),
    fork: Boolean(value.fork),
    isTemplate: Boolean(value.isTemplate),
    disabled: Boolean(value.disabled),
    forkParent: value.forkParent?.fullName ? {
      fullName: String(value.forkParent.fullName).slice(0, 220),
      url: normalizeWebUrl(value.forkParent.url, { githubOnly: true }),
    } : null,
    license: String(value.license || "NOASSERTION").slice(0, 80),
    sourceFiles: Math.max(0, Math.round(toNumber(value.sourceFiles) || 0)),
    sourceBytes: Math.max(0, Math.round(toNumber(value.sourceBytes) || 0)),
    estimatedLines: Math.max(1, Math.round(toNumber(value.estimatedLines) || 1)),
    treeTruncated: Boolean(value.treeTruncated),
    sampledFileCount: Math.max(0, Math.round(toNumber(value.sampledFileCount) || 0)),
    sampledBytes: Math.max(0, Math.round(toNumber(value.sampledBytes) || 0)),
    sampledFiles: Array.isArray(value.sampledFiles) ? value.sampledFiles.slice(0, 20).map((item) => ({
      path: String(item?.path || "Unknown file").slice(0, 500),
      language: String(item?.language || "Code").slice(0, 80),
      size: Math.max(0, Math.round(toNumber(item?.size) || 0)),
      lines: Math.max(0, Math.round(toNumber(item?.lines) || 0)),
    })) : [],
    languages: Array.isArray(value.languages) ? value.languages.slice(0, 12).map((item) => ({
      language: String(item?.language || "Other").slice(0, 80),
      files: Math.max(0, Math.round(toNumber(item?.files) || 0)),
      bytes: Math.max(0, Math.round(toNumber(item?.bytes) || 0)),
    })) : [],
    contributors: Array.isArray(value.contributors) ? value.contributors.slice(0, 12).map((item) => ({
      login: String(item?.login || "").slice(0, 80),
      url: normalizeWebUrl(item?.url, { githubOnly: true }),
      type: String(item?.type || "User").slice(0, 30),
      contributions: Math.max(0, Math.round(toNumber(item?.contributions) || 0)),
    })).filter((item) => item.login) : [],
    contributorsHasMore: Boolean(value.contributorsHasMore),
    latestCommit: value.latestCommit?.sha ? {
      sha: String(value.latestCommit.sha).slice(0, 64),
      url: normalizeWebUrl(value.latestCommit.url, { githubOnly: true }),
      message: String(value.latestCommit.message || "").slice(0, 160),
      date: normalizeIsoDate(value.latestCommit.date),
      verified: Boolean(value.latestCommit.verified),
      author: {
        login: String(value.latestCommit.author?.login || "").slice(0, 80),
        name: String(value.latestCommit.author?.name || "Unknown author").slice(0, 100),
        url: normalizeWebUrl(value.latestCommit.author?.url, { githubOnly: true }),
      },
    } : null,
    importedAt: normalizeIsoDate(value.importedAt),
    warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 8).map((item) => String(item).slice(0, 500)) : [],
  };
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

function formatDateOnly(iso) {
  if (!iso) return "Not available";
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: Number(value) >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function compactFingerprint(value) {
  const text = String(value || "");
  return text.length > 26 ? `${text.slice(0, 12)}…${text.slice(-10)}` : text;
}

function initials(value) {
  const parts = String(value || "?").split(/[-_\s]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "?").toUpperCase();
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
  if (!value || typeof value !== "object" || !["text", "image", "video", "audio", "code"].includes(value.type) || !value.detection || typeof value.detection !== "object") return null;
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
  const seenTaskIds = new Set();
  const savedTasks = Array.isArray(value.tasks)
    ? value.tasks
        .filter((task) => task && typeof task === "object")
        .map((task, index) => ({
          ...task,
          id: String(task.id || `saved-task-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100),
          priority: Object.hasOwn(PRIORITY_ORDER, task.priority) ? task.priority : "high",
          short: String(task.short || task.title || "Review this saved record"),
          title: String(task.title || task.short || "Review this saved record"),
          detail: String(task.detail || "Confirm the supporting evidence before completing review."),
          done: Boolean(task.done),
          quotes: Array.isArray(task.quotes) ? task.quotes.filter((item) => typeof item === "string") : [],
        }))
        .filter((task) => task.id && !seenTaskIds.has(task.id) && seenTaskIds.add(task.id))
    : [];
  const needsLegacyReview = !Array.isArray(value.tasks) || (value.tasks.length > 0 && savedTasks.length === 0);
  let tasks = needsLegacyReview
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
  const fileBacked = ["image", "video", "audio"].includes(value.type) || value.source === "document";
  const repository = value.type === "code" ? normalizeCodeRepository(value.repository || detection.repository) : value.repository || null;
  if (value.type === "code") {
    if (!repository) return null;
    detection.repository = repository;
  }
  const targetTask = humanTargetTask(value.type, humanTargetPlan(value.type, detection, { repository }));
  if (targetTask && !tasks.some((task) => task.id === "human-51")) tasks = [targetTask, ...tasks];
  return {
    ...value,
    id: String(value.id || newId()),
    name: String(value.name || "Saved asset"),
    createdAt: value.createdAt || new Date().toISOString(),
    details: value.details && typeof value.details === "object" ? value.details : {},
    tasks,
    detection,
    repository,
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

function normalizeCodeResult(data) {
  const d = data && typeof data === "object" ? data : {};
  const repository = normalizeCodeRepository(d.repository);
  const composition = Array.isArray(d.composition)
    ? d.composition
        .filter((item) => item && typeof item === "object")
        .map((item) => ({ id: String(item.id || "other"), label: String(item.label || "Other"), pct: Math.round(clamp(toNumber(item.pct) ?? 0, 0, 100)) }))
    : [];
  const compositionTotal = composition.reduce((sum, item) => sum + item.pct, 0);
  const humanPct = toNumber(d.humanPct) ?? composition.find((item) => item.id === "human")?.pct;
  const aiPct = toNumber(d.aiPct);
  if (!repository?.url || !repository?.fullName || !composition.length || compositionTotal !== 100 || humanPct == null || aiPct == null) {
    throw new ApiError("The GitHub importer returned an incomplete repository estimate.", 502, data);
  }
  return {
    checked: true,
    aiPct: round1(clamp(aiPct, 0, 100)),
    humanPct: round1(clamp(humanPct, 0, 100)),
    verdict: String(d.verdict || "Illustrative repository contribution estimate"),
    policyVerdict: String(d.policyVerdict || "inconclusive"),
    composition,
    humanPlan: d.humanPlan && typeof d.humanPlan === "object" ? d.humanPlan : null,
    repository,
    model: d.model || null,
    semantics: String(d.semantics || "Deterministic illustrative estimate; not forensic authorship attribution."),
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
  const illustrativeCode = record.type === "code";
  const policy = record.detection.policyVerdict || (ai == null ? "" : ai >= 75 ? "likely_ai" : ai <= 25 ? "likely_human" : "inconclusive");
  const human = HUMAN[details.human] || HUMAN.light;
  const license = LICENSE[details.license] || LICENSE.unsure;
  const screeningPoints = illustrativeCode ? null : { likely_human: 45, inconclusive: 22, likely_ai: 0 }[policy];
  const parts = [
    {
      label: "Content screening factor",
      note: illustrativeCode ? "illustrative code mix excluded from IPR score" : ai == null ? "not measured" : `${round1(ai)}% model score · ${policy.replaceAll("_", " ")}`,
      value: ai == null || illustrativeCode ? null : screeningPoints,
      max: 45,
    },
    { label: "Declared human contribution", note: human.label, value: human.points, max: 20 },
    { label: "Provenance evidence", note: details.provenance ? "saved" : "not saved", value: details.provenance ? 15 : 0, max: 15 },
    { label: "Licence clarity", note: license.label, value: license.points, max: 20 },
  ];
  const declared = parts.slice(1).reduce((sum, part) => sum + part.value, 0);
  const total = ai == null || illustrativeCode ? Math.min(60, Math.round((declared / 55) * 100)) : parts[0].value + declared;
  return { total, parts, capped: ai == null || illustrativeCode };
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

function humanTargetPlan(type, detection, context = {}) {
  if (!detection || detection.aiPct == null) return null;
  if (type === "code") {
    const supplied = detection.humanPlan && typeof detection.humanPlan === "object" ? detection.humanPlan : {};
    const repository = context.repository || detection.repository || {};
    const baselineHumanPct = round1(clamp(
      toNumber(supplied.baselineHumanPct) ?? toNumber(detection.humanPct) ?? toNumber(detection.composition?.find((item) => item.id === "human")?.pct) ?? 0,
      0,
      100,
    ));
    const estimatedTotalLines = Math.max(1, Math.floor(toNumber(supplied.estimatedTotalLines) ?? toNumber(repository.estimatedLines) ?? 1));
    const sourceFiles = Math.max(1, Math.floor(toNumber(repository.sourceFiles) ?? 1));
    const humanLines = Math.floor(estimatedTotalLines * baselineHumanPct / 100);
    const targetNumeratorGap = Math.max(0, HUMAN_TARGET_PCT * estimatedTotalLines - 100 * humanLines);
    const rewriteLines = Math.ceil(targetNumeratorGap / 100);
    const addOnlyLines = Math.ceil(targetNumeratorGap / (100 - HUMAN_TARGET_PCT));
    const filesToRewrite = rewriteLines ? Math.min(sourceFiles, Math.max(1, Math.ceil(rewriteLines / 200))) : 0;
    const testsToWrite = rewriteLines ? Math.max(3, Math.ceil(filesToRewrite * 2), Math.ceil(rewriteLines / 150)) : 0;
    return {
      baselineHumanPct,
      targetHumanPct: HUMAN_TARGET_PCT,
      gapPct: round1(Math.max(0, HUMAN_TARGET_PCT - baselineHumanPct)),
      estimatedTotalLines,
      rewriteLines,
      addOnlyLines,
      filesToRewrite,
      testsToWrite,
      unit: "lines",
      method: "URL-seeded illustrative repository mix",
      proxy: true,
    };
  }

  const explicitImageHuman = type === "image"
    ? toNumber(detection.providerSignals?.find((signal) => signal.name === "AI or Not" && toNumber(signal.humanPct) != null)?.humanPct)
    : null;
  const baselineHumanPct = round1(clamp(explicitImageHuman ?? 100 - detection.aiPct, 0, 100));
  const gapPct = round1(Math.max(0, HUMAN_TARGET_PCT - baselineHumanPct));
  const base = {
    baselineHumanPct,
    targetHumanPct: HUMAN_TARGET_PCT,
    gapPct,
    proxy: true,
    method: "planning proxy derived from the detector signal; not measured authorship share",
  };

  if (type === "text") {
    const words = Math.max(1, Math.round(detection.textWords || detection.text?.trim().split(/\s+/).filter(Boolean).length || 1));
    const existingHumanWords = Math.floor(words * baselineHumanPct / 100);
    const deficit = Math.max(0, HUMAN_TARGET_PCT / 100 * words - existingHumanWords);
    return { ...base, unit: "words", totalUnits: words, rewriteUnits: Math.ceil(deficit), addOnlyUnits: Math.ceil(deficit / 0.49) };
  }
  if (type === "image") {
    return { ...base, unit: "substantive edit categories", rewriteUnits: gapPct ? clamp(Math.ceil(gapPct / 10), 1, 5) : 0, addOnlyUnits: null };
  }
  if (type === "video") {
    const moments = Math.max(1, detection.coverage?.scored || detection.frames?.filter((frame) => frame.aiPct != null).length || 1);
    return { ...base, unit: "sampled shots", totalUnits: moments, rewriteUnits: gapPct ? Math.max(1, Math.ceil(moments * gapPct / 100)) : 0, addOnlyUnits: null };
  }
  if (type === "audio") {
    const seconds = Math.max(1, Math.round(detection.decode?.analyzedSeconds || detection.duration || context.duration || 1));
    return { ...base, unit: "seconds", totalUnits: seconds, rewriteUnits: gapPct ? Math.max(1, Math.ceil(seconds * gapPct / 100)) : 0, addOnlyUnits: null };
  }
  return base;
}

function humanTargetTask(type, plan) {
  if (!plan || plan.gapPct <= 0) return null;
  if (type === "code") {
    return {
      id: "human-51",
      priority: "high",
      short: `Hand-write ${plural(plan.rewriteLines, "line")}`,
      title: `Raise evidenced Human contribution to ${HUMAN_TARGET_PCT}%`,
      detail: `Manually rewrite at least ${plan.rewriteLines.toLocaleString()} substantive existing lines across ${plural(plan.filesToRewrite, "core file")} without AI autocomplete. Prioritize business rules, validation and error paths, security/permissions and integration boundaries. Formatting, renames and comments do not count. If you only add code, add at least ${plan.addOnlyLines.toLocaleString()} original lines. Also write ${plural(plan.testsToWrite, "behavior test")} and retain reviewed commits/diffs and one design note. This is a planning target, not proof of authorship.`,
      humanDeltaPct: plan.gapPct,
      target: plan,
    };
  }
  if (type === "text") {
    return {
      id: "human-51",
      priority: plan.gapPct >= 20 ? "high" : "medium",
      short: `Rewrite ${plural(plan.rewriteUnits, "word")}`,
      title: `Build a traceable ${HUMAN_TARGET_PCT}% Human contribution`,
      detail: `Rewrite at least ${plan.rewriteUnits.toLocaleString()} existing words in your own structure, starting with every flagged passage; or add at least ${plan.addOnlyUnits.toLocaleString()} original words. Use your own examples, data and citations, and retain tracked changes. The percentage is a planning proxy, not detected authorship.`,
      humanDeltaPct: plan.gapPct,
      target: plan,
    };
  }
  if (type === "image") {
    const edits = ["redraw the focal subject", "replace the background or texture with owned material", "rebuild composition and masks manually", "set typography by hand", "manually rebalance color and light"];
    return {
      id: "human-51",
      priority: "high",
      short: `Make ${plural(plan.rewriteUnits, "substantive edit")}`,
      title: `Create a traceable Human-majority image process`,
      detail: `Complete at least ${plan.rewriteUnits} substantive edit ${plan.rewriteUnits === 1 ? "category" : "categories"}: ${edits.slice(0, plan.rewriteUnits).join("; ")}. Save the layered source file, before/after exports and references. Image pixels do not support a defensible 51% authorship calculation, so this is a self-attested process target—not a detector promise.`,
      humanDeltaPct: plan.gapPct,
      target: plan,
    };
  }
  if (type === "video") {
    return {
      id: "human-51",
      priority: "high",
      short: `Rework ${plural(plan.rewriteUnits, "sampled shot")}`,
      title: `Raise the Human contribution across sampled shots`,
      detail: `Reshoot or substantially recompose at least ${plan.rewriteUnits} of ${plan.totalUnits} successfully screened sampled shots, prioritizing flagged timestamps. Keep the edit project, original footage and change notes. Frame sampling cannot measure the whole video's authorship, so 51% is a documented planning target.`,
      humanDeltaPct: plan.gapPct,
      target: plan,
    };
  }
  return {
    id: "human-51",
    priority: "high",
    short: `Re-record ${plural(plan.rewriteUnits, "second")}`,
    title: `Create a traceable Human-majority audio process`,
    detail: `Re-record, arrange or manually edit at least ${plan.rewriteUnits} of ${plan.totalUnits} screened seconds with a real performance or deliberate production work. Save stems, the DAW session and before/after exports. The speech detector does not measure musical authorship; 51% is a planning target.`,
    humanDeltaPct: plan.gapPct,
    target: plan,
  };
}

const PROVENANCE_TASK = {
  text: ["Save your drafts and the prompts you used", "Keep version history (Google Docs, tracked changes) and the prompt log. They are supporting evidence of your team's human contribution, not proof by themselves."],
  image: ["Save the prompt, model version, seed and source files", "Store them with the layered file. Together they show how the image was made and which parts are your own work."],
  video: ["Save the prompts, model versions and edit project", "The edit project file and generation settings show which shots were generated and what your team cut, composited and graded."],
  audio: ["Save the prompts, stems and DAW session", "Stems and the session file show your arrangement and mixing. That's the human part of the track."],
  code: ["Save prompts, reviewed commits and source references", "Keep prompt/model logs, design notes, reviewed diffs and dependency licences. They support the repository's provenance but do not prove model authorship."],
};

function buildTasks(type, detection, details, context = {}) {
  const tasks = [];
  const add = (task) => tasks.push({ done: false, quotes: [], ...task });
  const ai = detection.aiPct;
  const tool = details.tool || "the AI tool";
  const commercial = details.use !== "internal";
  const lowHuman = details.human === "none" || details.human === "light";
  const targetPlan = humanTargetPlan(type, detection, context);
  const targetTask = humanTargetTask(type, targetPlan);
  if (targetTask) add(targetTask);
  const targetEntry = targetTask ? tasks.find((task) => task.id === "human-51") : null;

  if (type !== "code" && ai != null && ai >= 75 && details.human === "human") {
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
      if (type === "text" && targetEntry) {
        targetEntry.quotes = writing.flagged || [];
        targetEntry.detail += ` Start with the ${plural(n, noun)} returned as high-score passages.`;
      } else {
        add({
          id: "rewrite",
          priority: writingAi >= 75 ? "high" : "medium",
          short: `Rewrite ${plural(n, noun)}`,
          title: `Review the ${plural(n, noun)} with high text-model scores`,
          detail: "Rewrite from source material in your own structure, add verifiable specifics, and preserve the edit history. The model score alone is not an authorship decision.",
          quotes: writing.flagged,
        });
      }
    } else if (writingAi >= 25) {
      if (type === "text" && targetEntry) {
        targetEntry.detail += ` Prioritize the passages behind the ${writingAi}% AI-class model score.`;
      } else {
        add({
          id: "rewrite",
          priority: writingAi >= 75 ? "high" : "medium",
          short: "Rework AI-sounding passages",
          title: `Review passages behind the ${writingAi}% AI-class model score`,
          detail: "The document-level classifier is inconclusive or elevated. Review the source trail and document any substantive human rewrite.",
        });
      }
    }
    if (writingAi >= 25 && lowHuman && !targetTask) {
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
    if (ai >= 75 && !targetTask) {
      add({
        id: "human-work",
        priority: "high",
        short: "Add documented human work",
        title: "Add documented human creative work before you rely on it",
        detail: `The external image check returned a ${ai}% AI-class score. This is not proof that the image is AI-generated. Keep layered source files, references, prompts, licences and meaningful human edits for review.`,
      });
    } else if (ai >= 25 && !targetTask) {
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
      if (targetEntry) {
        const required = Math.max(targetPlan.rewriteUnits, flagged.length);
        targetEntry.short = `Rework ${plural(required, "sampled shot")}`;
        targetEntry.title = "Raise the Human contribution across the flagged shots";
        targetEntry.detail = `Reshoot or substantially recompose at least ${required} of ${targetPlan.totalUnits} successfully screened sampled shots, including every flagged timestamp. Keep the edit project, original footage and change notes. Frame sampling cannot measure the whole video's authorship, so 51% is a documented planning target.`;
        targetEntry.quotes = flagged.map((frame) => `${formatTime(frame.time)}: ${frame.aiPct}% synthetic-image model score`);
      } else {
        add({
          id: "frames",
          priority: "high",
          short: `Rework ${plural(flagged.length, "shot")}`,
          title: `Rework the ${plural(flagged.length, "shot")} flagged as AI-generated`,
          detail: "Replace them with original footage, or document the human editing, compositing and grading on those shots.",
          quotes: flagged.map((frame) => `${formatTime(frame.time)}: ${frame.aiPct}% synthetic-image model score`),
        });
      }
    } else if (ai >= 25) {
      if (targetEntry) targetEntry.detail += " Prioritize the sampled shots with the strongest AI traits.";
      else add({
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

  if (type === "code" && targetPlan?.gapPct > 0) {
    add({
      id: "code-review",
      priority: "medium",
      short: "Review core code manually",
      title: "Review the hand-written core as a human-owned change set",
      detail: `Have a named reviewer inspect the ${plural(targetPlan.filesToRewrite, "core file")} and ${plural(targetPlan.testsToWrite, "behavior test")}. Record the architecture decision, security assumptions, dependency licences and approval commit. Do not count generated/vendor code, lockfiles, whitespace, comments or mechanical renames toward the target.`,
    });
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
  if (record.type === "code") {
    const repository = record.repository || detection.repository || {};
    steps.push(`Imported the public GitHub tree for ${repository.fullName || record.name}`);
    steps.push(`Sampled ${plural(repository.sampledFileCount || repository.sampledFiles?.length || 0, "source file")} without executing or storing repository source`);
    steps.push(`Created a stable URL-seeded illustrative mix with ${modelLabel(record)}`);
  } else if (record.type === "video") {
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
  steps.push(record.fingerprint ? (record.type === "code" ? "Fingerprint-bound the repository identity and imported tree" : "Fingerprinted the original with SHA-256") : "Recorded the original's details (fingerprint not available in this browser)");
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

function parseGithubRootInput(value) {
  const raw = String(value || "").trim();
  if (!raw || /%2f|%5c/i.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || !["github.com", "www.github.com"].includes(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const owner = decodeURIComponent(parts[0]);
    const repo = decodeURIComponent(parts[1]).replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  } catch {
    return null;
  }
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
  if (type === "code" && !parseGithubRootInput(els.repoUrl.value)) {
    return "Enter a public repository root URL such as https://github.com/owner/repository.";
  }
  return "";
}

function defaultName(type, file, text) {
  if (file) return baseName(file.name);
  if (type === "code") {
    const repository = parseGithubRootInput(text);
    return repository ? `${repository.owner}/${repository.repo}` : "GitHub repository";
  }
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

  if (type === "code") {
    const repository = parseGithubRootInput(els.repoUrl.value);
    setLoading(`Importing ${repository.owner}/${repository.repo} from GitHub…`);
    const response = await postDetect("github", JSON.stringify({ repositoryUrl: repository.url }), { "Content-Type": "application/json" });
    setLoading("Building the stable repository mix and 51% Human plan…");
    const detection = normalizeCodeResult(response.data);
    return {
      source: "github",
      file: null,
      fingerprint: detection.repository.fingerprint || "",
      raw: response.raw,
      detection,
      repository: detection.repository,
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
  const namingInput = type === "audio" ? els.transcriptInput.value : type === "code" ? els.repoUrl.value : els.textInput.value;
  const name =
    els.assetName.value.trim() ||
    defaultName(type, state.files[type === "text" ? "doc" : type], namingInput);

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
      repository: result.repository || null,
      tasks: buildTasks(type, result.detection, details, { repository: result.repository || null, file: result.file || null }),
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
    window.setTimeout(focusReportHeading, motionQuery.matches ? 0 : 320);
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
  const mode = target === els.report ? "report" : target === els.loadingState ? "loading" : target === els.errorState ? "error" : "composer";
  els.workspace.dataset.mode = mode;
  if (mode !== "report") {
    state.reportObserver?.disconnect();
    state.reportObserver = null;
  }
  els.flow.hidden = mode === "report";
  const heading = {
    composer: ["Screen a new asset", "Run a detector, assess evidence readiness and create a prioritized review plan."],
    loading: ["Analyzing asset", "Aright is importing the source, screening available signals and building the review plan."],
    error: ["Analysis needs attention", "Review the error, adjust the source or connection, and try the analysis again."],
    report: ["Analysis report", "Repository intelligence, human-work targets and evidence are organized in one continuous workspace."],
  }[mode];
  els.analyzeTitle.textContent = heading[0];
  els.analyzeLead.textContent = heading[1];
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
  const codeEstimate = record.type === "code";
  const externalSignal = usesAiOrNot(record.detection);
  const hasExternalImageSignal = record.type === "image" && record.detection.providerSignals?.some((signal) => signal.name === "AI or Not");
  const meterLabel = codeEstimate ? "Estimated AI-assisted share" : externalSignal ? `AI or Not ${record.type === "audio" ? "voice" : record.type === "video" ? "frame" : record.type} signal` : `${TYPE_LABEL[record.type]} model score`;
  const aiNote =
    codeEstimate
      ? "Stable repository-ID-seeded demo mix; full method and imported coverage are documented below."
      : ai == null
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
    score.capped && !codeEstimate
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
          <h2>${codeEstimate ? "Repository assessment" : escapeHtml(record.name)}</h2>
          <p class="summary__meta"><span>Analyzed ${escapeHtml(formatDate(record.createdAt))}</span><span>${escapeHtml(record.details.tool || "AI tool not specified")}</span></p>
        </div>
        <div class="summary__actions"><button class="btn btn--outline btn--compact" type="button" data-action="rescan">Edit setup</button><span class="tag tag--${STATUS[status].tag}">${STATUS[status].label}</span></div>
      </div>
      <div class="meters">
        <div class="meter">
          ${ring(ai, detectionTone(record.detection), "%", animate)}
          <div class="meter__text"><span>${escapeHtml(meterLabel)}</span><strong>${codeEstimate ? "Illustrative repository mix" : aiHeadline(ai, record.detection)}</strong><p>${escapeHtml(aiNote)}</p></div>
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
  } else if (record.type === "code") {
    const repository = record.repository || detection.repository || {};
    const languages = Array.isArray(repository.languages) ? repository.languages : [];
    const composition = Array.isArray(detection.composition) ? detection.composition : [];
    const mix = composition.map((item) => `
      <li class="attribution-row attribution-row--${escapeHtml(item.id)}">
        <span class="attribution-row__label"><strong>${escapeHtml(item.label)}</strong><b>${item.pct}%</b></span>
        <span class="attribution-row__bar" aria-hidden="true"><i style="width:${item.pct}%"></i></span>
      </li>`).join("");
    const totalLanguageBytes = Math.max(1, languages.reduce((sum, item) => sum + (item.bytes || 0), 0));
    const languageRows = languages.slice(0, 8).map((item) => {
      const pct = Math.max(2, Math.round((item.bytes / totalLanguageBytes) * 100));
      return `<li><span><strong>${escapeHtml(item.language)}</strong><small>${plural(item.files, "file")}</small></span><b>${Math.round((item.bytes / totalLanguageBytes) * 100)}%</b><i aria-hidden="true" style="--language-share:${pct}%"></i></li>`;
    }).join("");
    const sampledFiles = (repository.sampledFiles || []).slice(0, 8).map((item) => `<li><span class="mono">${escapeHtml(item.path)}</span><small>${escapeHtml(item.language)} · ${item.lines.toLocaleString()} lines · ${formatBytes(item.size)}</small></li>`).join("");
    const topics = (repository.topics || []).map((topic) => `<span>${escapeHtml(topic)}</span>`).join("");
    const badges = [
      repository.license && repository.license !== "NOASSERTION" ? repository.license : "Licence not detected",
      repository.archived ? "Archived" : "Active",
      repository.fork ? "Fork" : "Original repository",
      repository.isTemplate ? "Template" : "",
    ].filter(Boolean).map((label) => `<span>${escapeHtml(label)}</span>`).join("");
    const contributors = (repository.contributors || []).map((item) => `
      <li>
        <span class="contributor-avatar" aria-hidden="true">${escapeHtml(initials(item.login))}</span>
        <span><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.login)}</a><small>${escapeHtml(item.type)} · ${item.contributions.toLocaleString()} commits</small></span>
        <b>${formatCompactNumber(item.contributions)}</b>
      </li>`).join("");
    const latest = repository.latestCommit;
    const latestTitle = latest?.message || "Latest commit unavailable";
    const latestAuthor = latest ? (latest.author?.login || latest.author?.name || "Unknown author") : "GitHub metadata";
    const warnings = (repository.warnings || []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
    intro = "Public GitHub repository intelligence · bounded source sample · no code execution";
    body = `
      <section class="repo-profile" id="repository-profile" aria-labelledby="repository-profile-title">
        <div class="repo-profile__main">
          <p class="panel-kicker">${escapeHtml(repository.owner?.type || "GitHub")} · ${escapeHtml(repository.owner?.login || "Public owner")}</p>
          <h3 id="repository-profile-title"><a href="${escapeHtml(repository.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(repository.fullName || repository.url)}</a></h3>
          <p>${escapeHtml(repository.description || "No repository description was published on GitHub.")}</p>
          <div class="repo-badges">${badges}</div>
          ${topics ? `<div class="repo-topics" aria-label="Repository topics">${topics}</div>` : ""}
        </div>
        <div class="repo-profile__actions">
          <a class="btn btn--outline" href="${escapeHtml(repository.url)}" target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a>
          ${repository.homepage ? `<a class="text-action" href="${escapeHtml(repository.homepage)}" target="_blank" rel="noopener noreferrer">Project website ↗</a>` : ""}
        </div>
      </section>

      <dl class="repo-kpis" aria-label="Repository snapshot">
        <div><dt>Stars</dt><dd>${formatCompactNumber(repository.stats?.stars)}</dd></div>
        <div><dt>Forks</dt><dd>${formatCompactNumber(repository.stats?.forks)}</dd></div>
        <div><dt>Issues + PRs</dt><dd>${formatCompactNumber(repository.stats?.openIssuesAndPulls)}</dd></div>
        <div><dt>Source files</dt><dd>${(repository.sourceFiles || 0).toLocaleString()}</dd></div>
        <div><dt>Estimated LOC</dt><dd>${formatCompactNumber(repository.estimatedLines)}</dd></div>
        <div><dt>Repository size</dt><dd>${formatBytes((repository.stats?.githubSizeKb || 0) * 1024)}</dd></div>
      </dl>

      <section class="repo-timeline" aria-label="Repository timeline">
        <article><span>Created on GitHub</span><strong><time datetime="${escapeHtml(repository.createdAt || "")}">${escapeHtml(formatDateOnly(repository.createdAt))}</time></strong><small>GitHub repository creation date</small></article>
        <article><span>Last push</span><strong><time datetime="${escapeHtml(repository.pushedAt || "")}">${escapeHtml(formatDateOnly(repository.pushedAt))}</time></strong><small>Most recent GitHub push activity</small></article>
        <article><span>Latest ${escapeHtml(repository.defaultBranch || "default")} commit</span><strong title="${escapeHtml(latestTitle)}">${escapeHtml(latestTitle)}</strong><small>${escapeHtml(latestAuthor)}${latest?.date ? ` · ${escapeHtml(formatDateOnly(latest.date))}` : ""}${latest?.verified ? " · Verified" : ""}</small></article>
      </section>

      <div class="repo-analysis-grid">
        <section class="repo-panel" aria-labelledby="composition-title">
          <header><div><p class="panel-kicker">Illustrative estimate</p><h3 id="composition-title">Contribution mix</h3></div><span class="repo-panel__meta">Stable per repository</span></header>
          <ul class="attribution-list" aria-label="Illustrative contribution mix">${mix}</ul>
        </section>
        <section class="repo-panel" aria-labelledby="languages-title">
          <header><div><p class="panel-kicker">Imported tree</p><h3 id="languages-title">Languages</h3></div><span class="repo-panel__meta">${plural(languages.length, "language")}</span></header>
          ${languageRows ? `<ul class="language-list">${languageRows}</ul>` : `<p class="note">Language metadata was unavailable.</p>`}
        </section>
      </div>

      <div class="repo-analysis-grid repo-analysis-grid--secondary">
        <section class="repo-panel" aria-labelledby="contributors-title">
          <header><div><p class="panel-kicker">Public GitHub activity</p><h3 id="contributors-title">Top contributors</h3></div><span class="repo-panel__meta">${repository.contributorsHasMore ? "Top 12" : plural((repository.contributors || []).length, "profile")}</span></header>
          ${contributors ? `<ul class="contributors-list">${contributors}</ul>` : `<p class="note">Contributor metadata was unavailable for this import.</p>`}
        </section>
        <section class="repo-panel" aria-labelledby="coverage-title">
          <header><div><p class="panel-kicker">Technical record</p><h3 id="coverage-title">Import coverage</h3></div><span class="repo-panel__meta">${repository.treeTruncated ? "Partial tree" : "Complete tree response"}</span></header>
          <dl class="coverage-list">
            <div><dt>Default branch</dt><dd class="mono">${escapeHtml(repository.defaultBranch || "Unknown")}</dd></div>
            <div><dt>Tree fingerprint</dt><dd class="mono">${escapeHtml(String(repository.treeSha || "Unknown").slice(0, 12))}</dd></div>
            <div><dt>Sampled source</dt><dd>${repository.sampledFileCount || repository.sampledFiles?.length || 0} files · ${formatBytes(repository.sampledBytes || 0)}</dd></div>
            <div><dt>Imported</dt><dd>${escapeHtml(formatDate(repository.importedAt || record.createdAt))}</dd></div>
          </dl>
          ${sampledFiles ? `<details class="repo-sample"><summary>View sampled source paths</summary><ul>${sampledFiles}</ul></details>` : ""}
        </section>
      </div>

      <p class="callout callout--info repo-method-note">${icon("i-alert")}<span><strong>Illustrative—not forensic attribution.</strong> Aright imported public GitHub metadata, the repository tree and a bounded source sample. Source code cannot reliably reveal whether Codex, ChatGPT or another model authored it. The same repository ID produces the same demo mix; source files are never executed or persisted.</span></p>
      ${repository.forkParent?.fullName ? `<p class="note">Forked from <a href="${escapeHtml(repository.forkParent.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(repository.forkParent.fullName)}</a>.</p>` : ""}
      ${warnings ? `<details class="repo-warnings"><summary>Import notes</summary><ul>${warnings}</ul></details>` : ""}
      ${repository.treeTruncated ? `<p class="callout">${icon("i-alert")}<span>GitHub marked this recursive tree as truncated, so coverage is partial and must not be described as a full-repository analysis.</span></p>` : ""}`;
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

  const findingsTitle = record.type === "code" ? "Repository intelligence" : "What the models found";
  return `
    <article class="box section-card">
      <div class="section-card__head">
        <div><h2><span class="step-no">2</span>${findingsTitle}</h2><p>${intro}</p></div>
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
  const target = humanTargetPlan(record.type, record.detection, { repository: record.repository });
  const targetDone = record.tasks.find((task) => task.id === "human-51")?.done;
  const projected = target ? (targetDone ? target.targetHumanPct : target.baselineHumanPct) : null;
  const quantity = target
    ? record.type === "code"
      ? `${target.rewriteLines.toLocaleString()} substantive lines across ${plural(target.filesToRewrite, "file")}`
      : `${target.rewriteUnits.toLocaleString()} ${target.unit}`
    : "";
  const humanGoal = target ? `
    <section class="human-goal" aria-label="Human contribution target">
      <div><span>Human contribution plan</span><strong>${target.baselineHumanPct}% <i aria-hidden="true">→</i> ${projected}% <i aria-hidden="true">/</i> ${target.targetHumanPct}% target</strong></div>
      <p>${target.gapPct > 0 ? `Minimum planned work: ${escapeHtml(quantity)}. Checking the task records a self-attested plan; it does not change the original detector or demo estimate.` : "The planning baseline already reaches the 51% target. Keep the supporting versions, source files and review record."}</p>
    </section>` : "";
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
        <div><h2><span class="step-no">3</span>Action plan: what to fix</h2><p>Highest priority first. Checking a task records your self-attested completion. Only evidence and licence tasks can update readiness; none change the original detector or illustrative estimate.</p></div>
      </div>
      ${humanGoal}
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

  const original = record.type === "code"
    ? `<a href="${escapeHtml(record.repository?.url || record.detection.repository?.url || "#")}" target="_blank" rel="noopener">${escapeHtml(record.repository?.fullName || record.name)}</a>`
    : record.file
    ? `${escapeHtml(record.file.name)} · ${formatBytes(record.file.size)}`
    : `Pasted text · ${(record.detection.text || "").length.toLocaleString()} characters`;
  const detector = `${modelLabel(record)}${record.type === "video" ? " · sampled frames" : ""}`;
  const fingerprint = record.fingerprint
    ? `<span class="mono" title="${escapeHtml(record.fingerprint)}">${escapeHtml(compactFingerprint(record.fingerprint))}</span><button class="text-action" type="button" data-copy-fingerprint>Copy</button>`
    : `<span>Not computed (needs HTTPS or localhost, and files under 250 MB)</span>`;

  const primary =
    status === "protected"
      ? `<button class="btn btn--outline" type="button" data-action="reopen">Reopen</button>`
      : `<button class="btn btn--maroon" type="button" data-action="protect" ${open ? "disabled" : ""}>${icon("i-shield")}Complete review</button>`;

  return `
    <article class="box section-card">
      <div class="section-card__head">
        <div><h2><span class="step-no">4</span>Review &amp; protection</h2><p>${sentence}</p></div>
      </div>
      <dl class="evidence">
        <dt>Record ID</dt><dd class="mono">${escapeHtml(record.id)}</dd>
        <dt>Analyzed</dt><dd>${escapeHtml(formatDate(record.createdAt))}</dd>
        <dt>Original</dt><dd>${original}</dd>
        <dt>${record.type === "code" ? "Repository/tree fingerprint" : "SHA-256"}</dt><dd class="hash-value">${fingerprint}</dd>
        <dt>Detector</dt><dd>${detector}</dd>
        ${record.protectedAt ? `<dt>Review completed</dt><dd>${escapeHtml(formatDate(record.protectedAt))}</dd>` : ""}
      </dl>
      <div class="actions">
        ${primary}
        <button class="btn btn--outline" type="button" data-action="download">${icon("i-download")}Download evidence</button>
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

const REPORT_SECTION_ORDER = ["findings", "plan", "review"];

function preferredReportTab() {
  return "findings";
}

function activeReportTab(record) {
  const saved = state.reportTabs.get(record.id);
  return REPORT_SECTION_ORDER.includes(saved) ? saved : preferredReportTab(record);
}

function reportWorkspace(record, status) {
  const active = activeReportTab(record);
  const open = openTasks(record).length;
  const ai = record.detection.aiPct;
  const sections = [
    { id: "findings", label: record.type === "code" ? "Repository" : "Findings", meta: record.type === "code" ? "Imported" : ai == null ? "Not scanned" : `${Math.round(ai)}% signal` },
    { id: "plan", label: "Human plan", meta: open ? `${open} open` : "Complete" },
    { id: "review", label: "Evidence", meta: STATUS[status].label },
  ];
  const nav = sections.map((section) => {
    const selected = section.id === active;
    return `<button class="report-nav__item${selected ? " is-active" : ""}" type="button" aria-controls="report-section-${section.id}" aria-current="${selected ? "location" : "false"}" data-report-anchor="${section.id}"><span>${section.label}</span><small>${section.meta}</small></button>`;
  }).join("");
  return `
    <section class="report-workspace" aria-label="Analysis report details">
      <nav class="report-nav" aria-label="Analysis report sections">${nav}</nav>
      <div class="report-sections">
        <section class="report-section" id="report-section-findings" tabindex="-1" data-report-section="findings">${detectionCard(record)}</section>
        <section class="report-section" id="report-section-plan" tabindex="-1" data-report-section="plan">${planCard(record)}</section>
        <section class="report-section" id="report-section-review" tabindex="-1" data-report-section="review">${protectionCard(record, status)}${rawCard(record)}</section>
      </div>
    </section>`;
}

function activateReportSection(section, { focus = false, scroll = true } = {}) {
  const record = currentRecord();
  if (!record || !REPORT_SECTION_ORDER.includes(section)) return;
  const button = $(`[data-report-anchor="${section}"]`, els.report);
  if (!button) return;
  state.reportTabs.set(record.id, section);
  $$('[data-report-anchor]', els.report).forEach((item) => {
    const selected = item.dataset.reportAnchor === section;
    item.classList.toggle("is-active", selected);
    item.setAttribute("aria-current", selected ? "location" : "false");
  });
  if (scroll) $(`[data-report-section="${section}"]`, els.report)?.scrollIntoView({ behavior: motionQuery.matches ? "auto" : "smooth", block: "start" });
  if (focus) button.focus({ preventScroll: true });
}

function observeReportSections() {
  state.reportObserver?.disconnect();
  state.reportObserver = null;
  if (!("IntersectionObserver" in window)) return;
  const sections = $$('[data-report-section]', els.report);
  if (!sections.length) return;

  const visible = new Map();
  state.reportObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = entry.target.dataset.reportSection;
      if (entry.isIntersecting) visible.set(id, entry.boundingClientRect.top);
      else visible.delete(id);
    }
    if (!visible.size) return;
    const record = currentRecord();
    if (!record) return;
    const active = [...visible.entries()].sort((a, b) => Math.abs(a[1] - 118) - Math.abs(b[1] - 118))[0]?.[0];
    if (active && active !== activeReportTab(record)) {
      activateReportSection(active, { scroll: false });
    }
  }, {
    rootMargin: "-110px 0px -58% 0px",
    threshold: [0, 0.08, 0.25, 0.5],
  });
  sections.forEach((section) => state.reportObserver.observe(section));
}

function renderReport(record, { animate = false } = {}) {
  const score = scoreOf(record);
  const status = statusOf(record);
  if (!state.reportTabs.has(record.id)) state.reportTabs.set(record.id, preferredReportTab(record));
  const selectedTab = activeReportTab(record);
  els.report.innerHTML = [
    summaryCard(record, score, status, animate),
    reportWorkspace(record, status),
  ].join("");
  els.report.dataset.recordId = record.id;
  activateReportSection(selectedTab, { scroll: false });
  observeReportSections();
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
      const original = asset.type === "code"
        ? `GitHub · ${asset.repository?.fullName || asset.name}`
        : asset.file ? `${asset.file.name} · ${formatBytes(asset.file.size)}` : "Pasted text";
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
  const humanPlan = humanTargetPlan(record.type, detection, { repository: record.repository });
  const targetDone = Boolean(record.tasks.find((task) => task.id === "human-51")?.done);
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    source: record.source,
    analyzedAt: record.createdAt,
    original: record.file,
    repository: record.repository || detection.repository || null,
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
      scoreSemantics: record.type === "code" ? detection.semantics : "screening-model score; not a calibrated authorship probability",
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
      illustrativeComposition: detection.composition || null,
    },
    humanContributionPlan: humanPlan ? {
      ...humanPlan,
      projectedHumanPct: targetDone ? humanPlan.targetHumanPct : humanPlan.baselineHumanPct,
      selfAttestedCompletion: targetDone,
      warning: "A planning metric; it does not alter the original detector/illustrative mix or prove authorship.",
    } : null,
    actionPlan: record.tasks.map(({ id, title, detail, priority, done, humanDeltaPct, target }) => ({ id, title, detail, priority, done, humanDeltaPct: humanDeltaPct || 0, target: target || null })),
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
    { label: "New analysis", detail: "Screen text, image, video, audio or a public code repository", view: "analyze", icon: "i-plus" },
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
    if (view === "analyze") startNewAnalysis();
    else showView(view, { focus: true });
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

function startNewAnalysis() {
  state.currentId = null;
  showOnly(els.emptyState);
  updateFlow("upload");
  showView("analyze", { focus: true });
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
    code: "Public GitHub tree + bounded source sample · stable URL-seeded illustrative mix · not forensic model attribution.",
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
  else if (["image", "video", "audio"].includes(record.type)) setFile(record.type, null);
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
  if (record.type === "code") els.repoUrl.value = record.repository?.url || record.detection.repository?.url || "";
  updateDetailsSummary();
  updateCostHint();
  showOnly(els.emptyState);
  updateFlow("upload");
  showView("analyze");
  els.intake.scrollIntoView({ behavior: motionQuery.matches ? "auto" : "smooth", block: "start" });
  const target = $(`[data-pane="${record.type}"] textarea:not([disabled]), [data-pane="${record.type}"] input:not([type="file"]):not([disabled]), [data-pane="${record.type}"] .drop__input`);
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
    const view = target.dataset.viewTarget || target.dataset.overviewView;
    if (view === "analyze") startNewAnalysis();
    else showView(view, { focus: true });
    return;
  }
  const shortcut = event.target.closest("[data-empty-type]");
  if (shortcut) {
    setType(shortcut.dataset.emptyType);
    $("[data-pane]:not([hidden]) textarea, [data-pane]:not([hidden]) input:not([type=\"file\"]), [data-pane]:not([hidden]) .drop__input")?.focus({ preventScroll: true });
  }
});

els.newAnalysisBtn.addEventListener("click", startNewAnalysis);
els.overviewNewAnalysis.addEventListener("click", startNewAnalysis);

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
  const reportAnchor = event.target.closest("[data-report-anchor]");
  if (reportAnchor) {
    activateReportSection(reportAnchor.dataset.reportAnchor, { focus: true });
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

  const copyFingerprint = event.target.closest("[data-copy-fingerprint]");
  if (copyFingerprint && record.fingerprint) {
    const write = navigator.clipboard?.writeText(record.fingerprint);
    if (write) write.then(() => {
        copyFingerprint.textContent = "Copied";
        window.setTimeout(() => { if (copyFingerprint.isConnected) copyFingerprint.textContent = "Copy"; }, 1400);
      }).catch(() => {});
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
  const anchor = event.target.closest("[data-report-anchor]");
  if (!anchor || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = REPORT_SECTION_ORDER.indexOf(anchor.dataset.reportAnchor);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? REPORT_SECTION_ORDER.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + REPORT_SECTION_ORDER.length) % REPORT_SECTION_ORDER.length;
  activateReportSection(REPORT_SECTION_ORDER[next], { focus: true });
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
els.detailsDisclosure.open = window.matchMedia("(min-width: 901px)").matches;
updateFlow("upload");
showOnly(els.emptyState);
showView(location.hash.slice(1) || "overview");
checkServer();
window.setInterval(() => {
  if (!state.busy && document.visibilityState === "visible") checkServer();
}, 15000);
