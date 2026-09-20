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
  license: { spdx_id: "MIT" },
};

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
  assert.equal(result.data.repository.sourceFiles, 3);
  assert.equal(result.data.repository.sampledFileCount, 3);
  assert.equal(result.data.composition.reduce((sum, item) => sum + item.pct, 0), 100);
  assert.equal(result.data.model.forensicAttribution, false);
  assert.ok(requests.length >= 5);
  assert.ok(requests.every((item) => new URL(item.url).hostname === "api.github.com"));
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /permissions\?\.includes/);
  assert.doesNotMatch(serialized, /return a \+ b/);
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
