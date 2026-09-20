import { createHash } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const TREE_MAX_BYTES = 8 * 1024 * 1024;
const JSON_MAX_BYTES = 1024 * 1024;
const SAMPLE_FILE_MAX_BYTES = 96 * 1024;
const SAMPLE_TOTAL_MAX_BYTES = 512 * 1024;
const SAMPLE_FILE_LIMIT = 8;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = globalThis.__arightGithubImportCache || new Map();
globalThis.__arightGithubImportCache = cache;

const LANGUAGE_BY_EXTENSION = {
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  py: "Python", rb: "Ruby", php: "PHP", java: "Java", kt: "Kotlin", kts: "Kotlin",
  go: "Go", rs: "Rust", c: "C", h: "C/C++", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++",
  cs: "C#", swift: "Swift", scala: "Scala", sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell",
  vue: "Vue", svelte: "Svelte", html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less",
  sql: "SQL", graphql: "GraphQL", gql: "GraphQL", r: "R", lua: "Lua", dart: "Dart", ex: "Elixir", exs: "Elixir",
  erl: "Erlang", fs: "F#", fsx: "F#", clj: "Clojure", cljs: "Clojure", groovy: "Groovy", sol: "Solidity",
};

const EXCLUDED_SEGMENTS = new Set([
  "node_modules", "vendor", "dist", "build", "coverage", ".next", ".nuxt", ".venv", "venv",
  "target", "out", "generated", "__generated__", "third_party", "third-party", "pods",
]);

const EXCLUDED_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|composer\.lock|cargo\.lock|go\.sum|.*\.min\.(js|css)|.*\.map|.*\.snap)$/i;

export class GithubImportError extends Error {
  constructor(message, status = 500, code = "GITHUB_IMPORT_ERROR") {
    super(message);
    this.name = "GithubImportError";
    this.status = status;
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseGithubRepositoryUrl(input) {
  const value = String(input || "").trim();
  if (!value || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GithubImportError("Enter a valid public GitHub repository URL.", 400, "INVALID_GITHUB_URL");
  }
  if (/%2f|%5c/i.test(value)) {
    throw new GithubImportError("Encoded path separators are not allowed in a repository URL.", 400, "INVALID_GITHUB_URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new GithubImportError("Enter a full URL such as https://github.com/owner/repository.", 400, "INVALID_GITHUB_URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !["github.com", "www.github.com"].includes(hostname) || parsed.username || parsed.password) {
    throw new GithubImportError("Only public https://github.com/owner/repository URLs are supported.", 400, "UNSUPPORTED_GITHUB_URL");
  }
  if (parsed.search || parsed.hash) {
    throw new GithubImportError("Use the repository root URL without query parameters or a fragment.", 400, "INVALID_GITHUB_URL");
  }
  const encodedSegments = parsed.pathname.split("/").filter(Boolean);
  if (encodedSegments.length !== 2) {
    throw new GithubImportError("Use the repository root URL, not a branch, file, issue, or pull-request URL.", 400, "INVALID_GITHUB_URL");
  }
  let owner;
  let repo;
  try {
    owner = decodeURIComponent(encodedSegments[0]);
    repo = decodeURIComponent(encodedSegments[1]).replace(/\.git$/i, "");
  } catch {
    throw new GithubImportError("The repository URL contains invalid encoding.", 400, "INVALID_GITHUB_URL");
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") {
    throw new GithubImportError("The GitHub owner or repository name is invalid.", 400, "INVALID_GITHUB_URL");
  }
  return {
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`,
  };
}

function languageForPath(filePath) {
  const name = filePath.split("/").at(-1) || "";
  const lower = name.toLowerCase();
  if (["dockerfile", "makefile", "rakefile", "gemfile"].includes(lower)) return lower === "dockerfile" ? "Dockerfile" : "Build/config";
  const extension = lower.includes(".") ? lower.split(".").at(-1) : "";
  return LANGUAGE_BY_EXTENSION[extension] || "";
}

function eligibleCodeFile(entry) {
  if (!entry || entry.type !== "blob" || typeof entry.path !== "string") return false;
  const path = entry.path.replaceAll("\\", "/");
  const segments = path.toLowerCase().split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  if (EXCLUDED_FILES.test(path)) return false;
  return Boolean(languageForPath(path));
}

function seededRandom(seedText) {
  const digest = createHash("sha256").update(seedText).digest();
  let state = digest.readUInt32LE(0) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function allocateIntegers(total, weighted) {
  const weightSum = weighted.reduce((sum, item) => sum + item.weight, 0);
  const exact = weighted.map((item) => ({ ...item, exact: (item.weight / weightSum) * total }));
  const allocated = exact.map((item) => ({ ...item, pct: Math.floor(item.exact) }));
  let remaining = total - allocated.reduce((sum, item) => sum + item.pct, 0);
  allocated
    .map((item, index) => ({ index, remainder: item.exact - item.pct }))
    .sort((a, b) => b.remainder - a.remainder)
    .slice(0, remaining)
    .forEach(({ index }) => { allocated[index].pct += 1; remaining -= 1; });
  return allocated.map(({ id, label, pct }) => ({ id, label, pct }));
}

export function deterministicComposition(repositoryId) {
  const random = seededRandom(`aright-repo-vibe-v1:${repositoryId}`);
  const humanPct = 8 + Math.floor(random() * 31);
  const aiTotal = 100 - humanPct;
  const ai = allocateIntegers(aiTotal, [
    { id: "codex", label: "Codex", weight: 0.30 + random() * 0.28 },
    { id: "chatgpt", label: "ChatGPT models", weight: 0.20 + random() * 0.20 },
    { id: "claude", label: "Claude", weight: 0.10 + random() * 0.15 },
    { id: "copilot", label: "GitHub Copilot", weight: 0.08 + random() * 0.13 },
    { id: "gemini", label: "Gemini", weight: 0.05 + random() * 0.11 },
    { id: "other-ai", label: "Other AI", weight: 0.04 + random() * 0.09 },
  ]);
  return [...ai, { id: "human", label: "Human", pct: humanPct }];
}

export function codeHumanPlan(totalLines, humanPct, sourceFiles) {
  const lines = Math.max(1, Math.floor(Number(totalLines) || 1));
  const current = Math.max(0, Math.min(100, Number(humanPct) || 0));
  const target = 51;
  const humanLines = Math.floor(lines * current / 100);
  const targetNumeratorGap = Math.max(0, target * lines - 100 * humanLines);
  const rewriteLines = Math.ceil(targetNumeratorGap / 100);
  const addOnlyLines = Math.ceil(targetNumeratorGap / (100 - target));
  const files = Math.max(1, Math.floor(Number(sourceFiles) || 1));
  const filesToRewrite = rewriteLines ? Math.min(files, Math.max(1, Math.ceil(rewriteLines / 200))) : 0;
  const testsToWrite = rewriteLines ? Math.max(3, Math.ceil(filesToRewrite * 2), Math.ceil(rewriteLines / 150)) : 0;
  return {
    baselineHumanPct: current,
    targetHumanPct: target,
    gapPct: Math.max(0, target - current),
    estimatedTotalLines: lines,
    rewriteLines,
    addOnlyLines,
    filesToRewrite,
    testsToWrite,
  };
}

function githubHeaders(token, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "Airight-Console/1.0",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function readResponseBytes(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) throw new GithubImportError("GitHub returned more data than this importer accepts.", 502, "GITHUB_RESPONSE_TOO_LARGE");
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new GithubImportError("GitHub returned more data than this importer accepts.", 502, "GITHUB_RESPONSE_TOO_LARGE");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new GithubImportError("GitHub returned more data than this importer accepts.", 502, "GITHUB_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function githubHttpError(response, payload = {}) {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  const message = String(payload?.message || payload?.error || "");
  if ((response.status === 403 && (remaining === "0" || retryAfter || /secondary rate limit|rate limit/i.test(message))) || response.status === 429) {
    return new GithubImportError("GitHub's public API rate limit was reached. Try again after the reset time or configure GITHUB_API_TOKEN on the server.", 429, "GITHUB_RATE_LIMIT");
  }
  if (response.status === 401) return new GithubImportError("The server's GitHub credential was rejected.", 502, "GITHUB_AUTH_FAILED");
  if (response.status === 404) return new GithubImportError("That public GitHub repository was not found or is not accessible.", 404, "GITHUB_REPOSITORY_UNAVAILABLE");
  if (response.status === 409) return new GithubImportError("The GitHub repository is empty.", 409, "GITHUB_EMPTY_REPOSITORY");
  if (response.status === 422) return new GithubImportError("GitHub could not build a repository tree for that URL.", 422, "GITHUB_TREE_UNAVAILABLE");
  if (response.status >= 500) return new GithubImportError("GitHub is temporarily unavailable.", 502, "GITHUB_UPSTREAM_ERROR");
  return new GithubImportError("GitHub could not import that repository.", 502, `GITHUB_HTTP_${response.status}`);
}

async function githubJson(url, { fetchImpl, token, maxBytes = JSON_MAX_BYTES, accept } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: githubHeaders(token, accept),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new GithubImportError(timeout ? "GitHub took too long to respond." : "GitHub is temporarily unreachable.", timeout ? 504 : 502, timeout ? "GITHUB_TIMEOUT" : "GITHUB_UNREACHABLE");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new GithubImportError("This repository moved. Paste its current github.com URL and try again.", 409, "GITHUB_REPOSITORY_MOVED");
  }
  if (!response.ok) {
    const errorBytes = await readResponseBytes(response, 64 * 1024).catch(() => Buffer.alloc(0));
    let errorPayload = {};
    try { errorPayload = JSON.parse(errorBytes.toString("utf8")); } catch {}
    throw githubHttpError(response, errorPayload);
  }
  const bytes = await readResponseBytes(response, maxBytes);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new GithubImportError("GitHub returned an invalid response.", 502, "GITHUB_INVALID_RESPONSE");
  }
}

function selectSample(entries, repositoryId) {
  const sorted = entries
    .filter((entry) => Number(entry.size) > 0 && Number(entry.size) <= SAMPLE_FILE_MAX_BYTES)
    .map((entry) => ({ ...entry, order: sha256(`${repositoryId}:${entry.sha}:${entry.path}`) }))
    .sort((a, b) => a.order.localeCompare(b.order));
  const selected = [];
  let total = 0;
  for (const entry of sorted) {
    if (selected.length >= SAMPLE_FILE_LIMIT || total + Number(entry.size) > SAMPLE_TOTAL_MAX_BYTES) continue;
    selected.push(entry);
    total += Number(entry.size);
  }
  return selected;
}

function isSourceText(buffer) {
  if (!buffer.length || buffer.includes(0)) return false;
  const head = buffer.subarray(0, Math.min(buffer.length, 200)).toString("utf8");
  return !head.startsWith("version https://git-lfs.github.com/spec/v1");
}

async function importSampleFiles(entries, context) {
  const files = [];
  const warnings = [];
  let sampledBytes = 0;
  let sampledLines = 0;
  for (const entry of entries) {
    try {
      const url = `${GITHUB_API}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/git/blobs/${encodeURIComponent(entry.sha)}`;
      const payload = await githubJson(url, { fetchImpl: context.fetchImpl, token: context.token, maxBytes: 180 * 1024 });
      if (payload.encoding !== "base64" || typeof payload.content !== "string") continue;
      const bytes = Buffer.from(payload.content.replace(/\s+/g, ""), "base64");
      if (bytes.length > SAMPLE_FILE_MAX_BYTES || !isSourceText(bytes)) continue;
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      const lines = text ? text.split(/\r?\n/).length : 0;
      sampledBytes += bytes.length;
      sampledLines += lines;
      files.push({ path: entry.path, language: languageForPath(entry.path), size: bytes.length, lines });
    } catch (error) {
      if (error instanceof GithubImportError && error.code === "GITHUB_RATE_LIMIT") {
        warnings.push("GitHub rate limiting stopped the source sample early; repository-tree totals are still included.");
        break;
      }
      warnings.push(`Skipped ${entry.path} because its source sample was unavailable.`);
    }
  }
  return { files, warnings: warnings.slice(0, 4), sampledBytes, sampledLines };
}

export async function importGithubRepository(repositoryUrl, options = {}) {
  const parsed = parseGithubRepositoryUrl(repositoryUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const token = String(options.token || "").trim();
  const cacheKey = parsed.canonicalUrl;
  for (const [key, entry] of cache) {
    if (Date.now() - entry.createdAt >= CACHE_TTL_MS) cache.delete(key);
  }
  while (cache.size > 100) cache.delete(cache.keys().next().value);
  const cached = cache.get(cacheKey);
  if (!options.disableCache && cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return structuredClone(cached.result);

  const repoEndpoint = `${GITHUB_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const metadata = await githubJson(repoEndpoint, { fetchImpl, token });
  if (metadata.private === true || metadata.visibility && metadata.visibility !== "public") {
    throw new GithubImportError("Private repositories are not supported by this prototype.", 422, "GITHUB_PRIVATE_UNSUPPORTED");
  }
  if (!Number.isSafeInteger(Number(metadata.id)) || !metadata.default_branch || !metadata.full_name) {
    throw new GithubImportError("GitHub returned incomplete repository metadata.", 502, "GITHUB_INVALID_RESPONSE");
  }

  const [canonicalOwner, canonicalRepo] = String(metadata.full_name).split("/");
  const treeEndpoint = `${GITHUB_API}/repos/${encodeURIComponent(canonicalOwner)}/${encodeURIComponent(canonicalRepo)}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`;
  const tree = await githubJson(treeEndpoint, { fetchImpl, token, maxBytes: TREE_MAX_BYTES });
  if (!Array.isArray(tree.tree)) throw new GithubImportError("GitHub returned an invalid repository tree.", 502, "GITHUB_INVALID_TREE");
  const entries = tree.tree.filter(eligibleCodeFile);
  if (!entries.length) throw new GithubImportError("No supported source-code files were found in this repository.", 422, "GITHUB_NO_SUPPORTED_CODE");

  const languageMap = new Map();
  let sourceBytes = 0;
  for (const entry of entries) {
    const language = languageForPath(entry.path);
    const size = Math.max(0, Number(entry.size) || 0);
    sourceBytes += size;
    const current = languageMap.get(language) || { language, files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += size;
    languageMap.set(language, current);
  }
  const languages = [...languageMap.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  const selected = selectSample(entries, metadata.id);
  const sample = await importSampleFiles(selected, {
    owner: canonicalOwner,
    repo: canonicalRepo,
    fetchImpl,
    token,
  });
  if (!sample.files.length) {
    throw new GithubImportError("No readable source-code sample could be imported from this repository.", 422, "GITHUB_NO_READABLE_CODE");
  }
  const bytesPerLine = sample.sampledBytes && sample.sampledLines ? sample.sampledBytes / sample.sampledLines : 48;
  const estimatedLines = Math.max(entries.length, Math.round(sourceBytes / Math.max(12, bytesPerLine)));
  const composition = deterministicComposition(metadata.id);
  const humanPct = composition.find((item) => item.id === "human").pct;
  const aiPct = 100 - humanPct;
  const humanPlan = codeHumanPlan(estimatedLines, humanPct, entries.length);
  const canonicalUrl = `https://github.com/${String(metadata.full_name)}`;
  const importedAt = new Date().toISOString();
  const result = {
    data: {
      checked: true,
      aiPct,
      humanPct,
      policyVerdict: aiPct >= 75 ? "likely_ai" : aiPct <= 25 ? "likely_human" : "inconclusive",
      verdict: "Illustrative URL-seeded contribution mix — not forensic model attribution",
      composition,
      humanPlan,
      repository: {
        id: Number(metadata.id),
        fullName: String(metadata.full_name),
        url: canonicalUrl,
        defaultBranch: String(metadata.default_branch),
        treeSha: String(tree.sha || ""),
        fingerprint: sha256(`${metadata.id}:${tree.sha || metadata.default_branch}`),
        archived: Boolean(metadata.archived),
        fork: Boolean(metadata.fork),
        license: metadata.license?.spdx_id || "NOASSERTION",
        sourceFiles: entries.length,
        sourceBytes,
        estimatedLines,
        treeTruncated: Boolean(tree.truncated),
        sampledFiles: sample.files,
        sampledFileCount: sample.files.length,
        sampledBytes: sample.sampledBytes,
        languages,
        warnings: sample.warnings,
      },
      model: {
        id: "aright/github-vibe-estimator",
        revision: "repo-vibe-v1",
        provider: "GitHub REST metadata + deterministic Aright demo",
        scope: "illustrative repository contribution mix",
        deterministic: true,
        forensicAttribution: false,
      },
      semantics: "Deterministic illustrative estimate seeded by GitHub repository identity; it does not detect which model authored code.",
    },
    raw: {
      provider: "GitHub REST API + Aright deterministic demo",
      importedAt,
      repository: {
        id: Number(metadata.id),
        fullName: String(metadata.full_name),
        url: canonicalUrl,
        defaultBranch: String(metadata.default_branch),
        treeSha: String(tree.sha || ""),
      },
      coverage: {
        eligibleSourceFiles: entries.length,
        sourceBytes,
        sampledFiles: sample.files.length,
        sampledBytes: sample.sampledBytes,
        treeTruncated: Boolean(tree.truncated),
      },
      method: {
        id: "aright/github-vibe-estimator",
        version: "repo-vibe-v1",
        deterministicSeed: "GitHub repository numeric ID",
        modelAttributionDetected: false,
      },
      warnings: sample.warnings,
    },
  };
  if (!options.disableCache) cache.set(cacheKey, { createdAt: Date.now(), result: structuredClone(result) });
  return result;
}
