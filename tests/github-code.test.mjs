import assert from "node:assert/strict";
import test from "node:test";

import {
  GithubImportError,
  codeHumanPlan,
  deterministicComposition,
  importGithubRepository,
  parseGithubRepositoryUrl,
} from "../lib/github-code.mjs";
import { handleDetection } from "../lib/cloud-api.mjs";

const repoMetadata = {
  id: 424242,
  full_name: "Acme/Demo",
  default_branch: "main",
  private: false,
  visibility: "public",
  archived: false,
  fork: false,
  is_template: false,
  disabled: false,
  description: "A modern legal-operations workspace.",
  homepage: "https://acme.example/products/demo",
  language: "JavaScript",
  topics: ["legal-tech", "ai-governance"],
  created_at: "2024-01-12T08:00:00Z",
  updated_at: "2026-09-19T10:30:00Z",
  pushed_at: "2026-09-20T11:45:00Z",
  stargazers_count: 284,
  forks_count: 31,
  open_issues_count: 12,
  size: 1842,
  owner: { login: "acme", html_url: "https://github.com/acme", type: "Organization" },
  license: { spdx_id: "MIT" },
};

const contributorsPayload = [
  { login: "alex-dev", html_url: "https://github.com/alex-dev", type: "User", contributions: 184 },
  { login: "maya-code", html_url: "https://github.com/maya-code", type: "User", contributions: 96 },
  { login: "build-bot", html_url: "https://github.com/build-bot", type: "Bot", contributions: 28 },
  { login: null, name: "Anonymous", email: "private@example.com", contributions: 4 },
];

const latestCommitPayload = [{
  sha: "abcdef1234567890",
  html_url: "https://github.com/acme/demo/commit/abcdef1234567890",
  author: { login: "alex-dev", html_url: "https://github.com/alex-dev" },
  commit: {
    message: "Refine evidence review workflow\n\nInternal details must not be returned.",
    author: { name: "Alex Developer", email: "private@example.com", date: "2026-09-20T12:00:00Z" },
    verification: { verified: true },
  },
  files: [{ patch: "@@ source patch must not be returned @@" }],
}];

const treePayload = {
  sha: "tree-sha-123",
  truncated: false,
  tree: [
    { type: "blob", path: "src/app.js", sha: "blob-app", size: 58 },
    { type: "blob", path: "src/auth.ts", sha: "blob-auth", size: 74 },
    { type: "blob", path: "styles/site.css", sha: "blob-css", size: 45 },
    { type: "blob", path: "dist/bundle.js", sha: "blob-dist", size: 400 },
    { type: "blob", path: "package-lock.json", sha: "blob-lock", size: 900 },
  ],
};

const sourceBySha = {
  "blob-app": "export function add(a, b) {\n  return a + b;\n}\n",
  "blob-auth": "export const canEdit = (user) => Boolean(user?.permissions?.includes('edit'));\n",
  "blob-css": ":root { --ink: #171915; }\nbody { color: var(--ink); }\n",
};

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function githubMock(requests) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    requests.push({ url: parsed.href, init });
    assert.equal(parsed.protocol, "https:");
    assert.equal(parsed.hostname, "api.github.com");
    if (parsed.pathname === "/repos/acme/demo") return jsonResponse(repoMetadata);
    if (parsed.pathname.endsWith("/git/trees/main")) return jsonResponse(treePayload);
    if (parsed.pathname.endsWith("/contributors")) return jsonResponse(contributorsPayload);
    if (parsed.pathname.endsWith("/commits")) return jsonResponse(latestCommitPayload);
    const sha = decodeURIComponent(parsed.pathname.split("/").at(-1));
    if (sourceBySha[sha]) {
      return jsonResponse({ encoding: "base64", content: Buffer.from(sourceBySha[sha]).toString("base64") });
    }
    return jsonResponse({ message: "not found" }, 404);
  };
}

test("GitHub URL parser canonicalizes repository roots and rejects unsafe locations", () => {
  assert.deepEqual(parseGithubRepositoryUrl("https://github.com/Acme/Demo.git/"), {
    owner: "Acme",
    repo: "Demo",
    canonicalUrl: "https://github.com/acme/demo",
  });
  for (const value of [
    "http://github.com/acme/demo",
    "https://github.com.evil/acme/demo",
    "https://user:secret@github.com/acme/demo",
    "https://github.com/acme/demo/tree/main",
    "https://github.com/acme/demo?tab=readme",
    "https://github.com/acme%2Fdemo/other",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => parseGithubRepositoryUrl(value), GithubImportError, value);
  }
});

test("repository contribution mix is stable per repository and always sums to 100", () => {
  const first = deterministicComposition(424242);
  const again = deterministicComposition(424242);
  const other = deterministicComposition(424243);
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, other);
  assert.equal(first.reduce((sum, item) => sum + item.pct, 0), 100);
  assert.ok(first.some((item) => item.id === "human"));
  assert.ok(first.every((item) => Number.isInteger(item.pct) && item.pct >= 0 && item.pct <= 100));
});

test("51 percent Human code plan uses minimal replacement and add-only quantities", () => {
  const plan = codeHumanPlan(1000, 10, 20);
  assert.equal(plan.rewriteLines, 410);
  assert.equal(plan.addOnlyLines, 837);
  assert.ok((100 + plan.rewriteLines) / 1000 >= 0.51);
  assert.ok((100 + plan.addOnlyLines) / (1000 + plan.addOnlyLines) >= 0.51);
  assert.ok((100 + plan.addOnlyLines - 1) / (1000 + plan.addOnlyLines - 1) < 0.51);
  assert.equal(codeHumanPlan(1000, 60, 20).rewriteLines, 0);
  assert.equal(codeHumanPlan(49, 0, 1).addOnlyLines, 51);
});

test("import reads only constructed GitHub API URLs and returns metadata without source text", async () => {
  const requests = [];
  const result = await importGithubRepository("https://github.com/acme/demo", {
    fetchImpl: githubMock(requests),
    disableCache: true,
  });
  assert.equal(result.data.repository.fullName, "Acme/Demo");
  assert.equal(result.data.repository.owner.login, "acme");
  assert.equal(result.data.repository.owner.type, "Organization");
  assert.equal(result.data.repository.description, "A modern legal-operations workspace.");
  assert.equal(result.data.repository.primaryLanguage, "JavaScript");
  assert.deepEqual(result.data.repository.topics, ["legal-tech", "ai-governance"]);
  assert.equal(result.data.repository.createdAt, "2024-01-12T08:00:00.000Z");
  assert.equal(result.data.repository.pushedAt, "2026-09-20T11:45:00.000Z");
  assert.deepEqual(result.data.repository.stats, { stars: 284, forks: 31, openIssuesAndPulls: 12, githubSizeKb: 1842 });
  assert.deepEqual(result.data.repository.contributors.map(({ login, contributions }) => ({ login, contributions })), [
    { login: "alex-dev", contributions: 184 },
    { login: "maya-code", contributions: 96 },
    { login: "build-bot", contributions: 28 },
  ]);
  assert.equal(result.data.repository.latestCommit.message, "Refine evidence review workflow");
  assert.equal(result.data.repository.latestCommit.verified, true);
  assert.equal(result.data.repository.sourceFiles, 3);
  assert.equal(result.data.repository.sampledFileCount, 3);
  assert.equal(result.data.composition.reduce((sum, item) => sum + item.pct, 0), 100);
  assert.equal(result.data.model.forensicAttribution, false);
  assert.ok(requests.length >= 5);
  assert.ok(requests.some((item) => item.url.includes("/contributors?per_page=13&anon=0")));
  assert.ok(requests.some((item) => item.url.includes("/commits?sha=main&per_page=1")));
  assert.ok(requests.every((item) => new URL(item.url).hostname === "api.github.com"));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /permissions\?\.includes/);
  assert.doesNotMatch(serialized, /return a \+ b/);
  assert.doesNotMatch(serialized, /private@example\.com/);
  assert.doesNotMatch(serialized, /source patch must not be returned/);
});

test("optional contributor rate limiting keeps the core import usable and skips later enrichment", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    requests.push({ url: parsed.href, init });
    if (parsed.pathname === "/repos/acme/demo") return jsonResponse(repoMetadata);
    if (parsed.pathname.endsWith("/git/trees/main")) return jsonResponse(treePayload);
    if (parsed.pathname.endsWith("/contributors")) {
      return jsonResponse({ message: "You have exceeded a secondary rate limit." }, 403, { "Retry-After": "60" });
    }
    const sha = decodeURIComponent(parsed.pathname.split("/").at(-1));
    if (sourceBySha[sha]) return jsonResponse({ encoding: "base64", content: Buffer.from(sourceBySha[sha]).toString("base64") });
    return jsonResponse({ message: "not found" }, 404);
  };

  const result = await importGithubRepository("https://github.com/acme/demo", { fetchImpl, disableCache: true });
  assert.equal(result.data.repository.fullName, "Acme/Demo");
  assert.deepEqual(result.data.repository.contributors, []);
  assert.equal(result.data.repository.latestCommit, null);
  assert.ok(result.data.repository.warnings.some((warning) => /contributor enrichment/i.test(warning)));
  assert.equal(requests.some((item) => item.url.includes("/commits?")), false);
});

test("a source-sample rate limit is preserved as 429 instead of a no-code error", async () => {
  const fetchImpl = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/repos/acme/demo") return jsonResponse(repoMetadata);
    if (pathname.endsWith("/git/trees/main")) return jsonResponse(treePayload);
    return jsonResponse({ message: "You have exceeded a secondary rate limit." }, 403, { "Retry-After": "60" });
  };
  await assert.rejects(
    () => importGithubRepository("https://github.com/acme/demo", { fetchImpl, disableCache: true }),
    (error) => error instanceof GithubImportError && error.code === "GITHUB_RATE_LIMIT" && error.status === 429,
  );
});

test("a partial source sample survives rate limiting and skips activity enrichment", async () => {
  let blobCalls = 0;
  let enrichmentCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/repos/acme/demo") return jsonResponse(repoMetadata);
    if (parsed.pathname.endsWith("/git/trees/main")) return jsonResponse(treePayload);
    if (parsed.pathname.endsWith("/contributors") || parsed.pathname.endsWith("/commits")) {
      enrichmentCalls += 1;
      return jsonResponse([]);
    }
    blobCalls += 1;
    if (blobCalls === 1) return jsonResponse({ encoding: "base64", content: Buffer.from("export const ready = true;\n").toString("base64") });
    return jsonResponse({ message: "You have exceeded a secondary rate limit." }, 403, { "Retry-After": "60" });
  };

  const result = await importGithubRepository("https://github.com/acme/demo", { fetchImpl, disableCache: true });
  assert.equal(result.data.repository.sampledFileCount, 1);
  assert.equal(enrichmentCalls, 0);
  assert.ok(result.data.repository.warnings.some((warning) => /rate limiting stopped the source sample/i.test(warning)));
  assert.ok(result.data.repository.warnings.some((warning) => /activity enrichment was skipped/i.test(warning)));
});

test("the whole GitHub import respects a shared processing deadline", async () => {
  let calls = 0;
  await assert.rejects(
    () => importGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async () => { calls += 1; return jsonResponse(repoMetadata); },
      disableCache: true,
      deadlineAt: Date.now() - 1,
    }),
    (error) => error instanceof GithubImportError && error.code === "GITHUB_TIMEOUT" && error.status === 504,
  );
  assert.equal(calls, 0);
});

test("private repositories are rejected even if a server token could see them", async () => {
  const fetchImpl = async () => jsonResponse({ ...repoMetadata, private: true, visibility: "private" });
  await assert.rejects(
    () => importGithubRepository("https://github.com/acme/demo", { fetchImpl, disableCache: true }),
    (error) => error instanceof GithubImportError && error.code === "GITHUB_PRIVATE_UNSUPPORTED" && error.status === 422,
  );
});

test("an eligible tree with no readable source sample is not presented as analyzed", async () => {
  const fetchImpl = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/repos/acme/demo") return jsonResponse(repoMetadata);
    if (pathname.endsWith("/git/trees/main")) return jsonResponse({ sha: "tree", truncated: false, tree: [{ type: "blob", path: "src/app.js", sha: "binary", size: 12 }] });
    return jsonResponse({ encoding: "base64", content: Buffer.from([0, 1, 2, 3]).toString("base64") });
  };
  await assert.rejects(
    () => importGithubRepository("https://github.com/acme/demo", { fetchImpl, disableCache: true }),
    (error) => error instanceof GithubImportError && error.code === "GITHUB_NO_READABLE_CODE" && error.status === 422,
  );
});

test("secondary GitHub rate limits map to a retryable 429 without leaking the body", async () => {
  const fetchImpl = async () => jsonResponse(
    { message: "You have exceeded a secondary rate limit." },
    403,
    { "X-RateLimit-Remaining": "4999", "Retry-After": "60" },
  );
  await assert.rejects(
    () => importGithubRepository("https://github.com/acme/demo", { fetchImpl, disableCache: true }),
    (error) => error instanceof GithubImportError && error.code === "GITHUB_RATE_LIMIT" && error.status === 429,
  );
});

test("hosted GitHub route requires console auth before making any GitHub request", async () => {
  const env = { AIORNOT_API_KEY: "provider-test-key", ADMIN_PASSWORD: "console-test-key" };
  let calls = 0;
  const unauthorized = await handleDetection(new Request("https://airight.example/api/detect/github", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://airight.example" },
    body: JSON.stringify({ repositoryUrl: "https://github.com/acme/demo" }),
  }), { env, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls, 0);

  const requests = [];
  const authorized = await handleDetection(new Request("https://airight.example/api/detect/github", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": env.ADMIN_PASSWORD, Origin: "https://airight.example" },
    body: JSON.stringify({ repositoryUrl: "https://github.com/acme/demo" }),
  }), { env, fetchImpl: githubMock(requests) });
  const body = await authorized.json();
  assert.equal(authorized.status, 200);
  assert.equal(body.data.repository.fullName, "Acme/Demo");
  assert.equal(body.data.composition.reduce((sum, item) => sum + item.pct, 0), 100);
  assert.ok(requests.length > 0);
});
