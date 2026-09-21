import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleDetection, handleStatus } from "../lib/cloud-api.mjs";
import {
  COPILOT_DISCLAIMER,
  OPENAI_RESPONSES_ENDPOINT,
  runOpenAiCopilot,
} from "../lib/openai-copilot.mjs";

const env = {
  ADMIN_PASSWORD: "test-console-key",
  OPENAI_API_KEY: "test-openai-project-key",
  OPENAI_MODEL: "gpt-5.6-luna",
  OPENAI_TIMEOUT_MS: "5000",
  OPENAI_MAX_REQUESTS_PER_MINUTE: "1000",
  OPENAI_MAX_CONCURRENT: "8",
};

function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Origin", "https://airight.example");
  return new Request(`https://airight.example${path}`, { ...options, headers });
}

function record() {
  return {
    id: "AR-TEST123",
    type: "code",
    name: "browser-use/jev-ultrafast",
    createdAt: "2026-09-21T07:00:00.000Z",
    details: { human: "light", use: "commercial", license: "unchecked", provenance: false, tool: "Codex" },
    file: null,
    fingerprint: "a".repeat(64),
    detection: {
      checked: true,
      aiPct: 91,
      verdict: "Illustrative repository contribution estimate",
      policyVerdict: "likely_ai",
      providerVerdict: "",
      disagreement: false,
      model: "aright/github-vibe-estimator @ repo-vibe-v1",
      generatorHints: [{ name: "Codex", score: 45 }],
      frameCount: 0,
      flaggedPassageCount: 0,
    },
    repository: {
      url: "https://github.com/browser-use/jev-ultrafast",
      fullName: "browser-use/jev-ultrafast",
      description: "A test repository",
      language: "TypeScript",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      contributorCount: 4,
      fileCount: 28,
      sourceFileCount: 9,
      lines: 3386,
    },
    humanTarget: {
      baselineHumanPct: 9,
      targetHumanPct: 51,
      gapPct: 42,
      rewriteUnits: 1659,
      totalUnits: 3386,
      unit: "lines",
      rewriteLines: 1659,
      filesToRewrite: 9,
      testsToWrite: 18,
    },
    tasks: [
      {
        id: "human-51",
        title: "Raise evidenced Human contribution to 51%",
        detail: "Rewrite substantive code and retain reviewed diffs.",
        priority: "high",
        done: false,
        evidence: [],
      },
      {
        id: "licence",
        title: "Confirm commercial-use terms",
        detail: "Review the applicable licence.",
        priority: "high",
        done: true,
        evidence: [{ name: "licence.pdf", size: 1234, mime: "application/pdf", sha256: "b".repeat(64), addedAt: "2026-09-21T07:30:00.000Z" }],
      },
    ],
  };
}

function planOutput() {
  return {
    summary: "Focus the review on substantive code decisions, tests, and licence documentation.",
    detailedPlan: [
      {
        taskId: "human-51",
        title: "Document substantive manual work",
        why: "The record sets a 51% planning target and currently has no attachment for this task.",
        steps: ["Select the named core files.", "Record reviewed diffs and behavior tests."],
        acceptanceCriteria: ["Reviewed diffs and test results are retained."],
        evidenceToCollect: ["Reviewed commit diff", "Test output", "Design note"],
      },
      {
        taskId: "licence",
        title: "Record the licence review",
        why: "The task is self-attested complete and has one attachment metadata record.",
        steps: ["Check that the attachment identifies the applicable terms."],
        acceptanceCriteria: ["A reviewer records the plan and relevant clauses."],
        evidenceToCollect: ["Applicable licence terms"],
      },
    ],
    evidenceDraft: {
      title: "Human contribution statement — editable draft",
      statement: "This draft records a 91% AI-class screening signal and a 51% Human planning target. The reviewer must describe the substantive manual code work actually completed.",
      factsUsed: ["The repository record lists 3,386 lines across 9 source files.", "One licence attachment metadata record is present."],
      missingEvidence: ["Reviewed diffs for substantive manual changes", "Behavior test results"],
      warnings: ["The detector signal and this draft are not proof of authorship."],
    },
    disclaimer: "AI-generated review aid; not proof or legal advice.",
  };
}

function recheckOutput() {
  return {
    summary: "The supplied metadata partially supports the licence-review task.",
    recheck: {
      taskId: "licence",
      status: "partial",
      confidence: 62,
      rationale: "The record has one PDF attachment with a SHA-256 hash, but its contents were not supplied for review.",
      nextSteps: ["Open the file and record the applicable plan and clauses."],
    },
    disclaimer: "AI-generated review aid; not proof or legal advice.",
  };
}

function openAiResponse(output, overrides = {}) {
  return new Response(JSON.stringify({
    id: "resp_test_123",
    model: "gpt-5.6-luna",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
    ...overrides,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function copilotRequest(body, headers = {}) {
  return request("/api/detect/copilot", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": env.ADMIN_PASSWORD, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("status exposes only sanitized OpenAI capability fields and does not require AI or Not", async () => {
  const response = await handleStatus(request("/api/status"), { env });
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.ready, false);
  assert.equal(body.providers.openai.configured, true);
  assert.equal(body.providers.openai.model, "gpt-5.6-luna");
  assert.equal(body.providers.openai.storeResponses, false);
  assert.equal(body.capabilities.evidenceCopilot, true);
  assert.equal(body.worker.models.copilot.loaded, true);
  assert.doesNotMatch(text, new RegExp(env.OPENAI_API_KEY));
});

test("generate_plan uses Responses Structured Outputs with store false and returns a bounded direct envelope", async () => {
  let captured;
  const input = { action: "generate_plan", record: record() };
  const response = await handleDetection(copilotRequest(input), {
    env,
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init, body: JSON.parse(init.body) };
      return openAiResponse(planOutput());
    },
  });
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.equal(captured.url, OPENAI_RESPONSES_ENDPOINT);
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, `Bearer ${env.OPENAI_API_KEY}`);
  assert.equal(captured.body.model, "gpt-5.6-luna");
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.text.format.type, "json_schema");
  assert.equal(captured.body.text.format.strict, true);
  assert.equal(captured.body.text.format.name, "aright_generate_plan");
  assert.equal(captured.body.input[0].content[0].type, "input_text");
  assert.doesNotMatch(captured.body.input[0].content[0].text, new RegExp(env.OPENAI_API_KEY));
  assert.equal(body.action, "generate_plan");
  assert.equal(body.responseId, "resp_test_123");
  assert.equal(body.detailedPlan.length, 2);
  assert.equal(body.evidenceDraft.missingEvidence.length, 2);
  assert.equal(body.disclaimer, COPILOT_DISCLAIMER);
  assert.doesNotMatch(text, new RegExp(env.OPENAI_API_KEY));
});

test("recheck_task returns a separate support assessment without detector or checklist mutations", async () => {
  const sourceRecord = record();
  const before = structuredClone(sourceRecord);
  const result = await runOpenAiCopilot({ action: "recheck_task", record: sourceRecord, taskId: "licence" }, {
    ...env,
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    timeoutMs: 5_000,
    maxRequestsPerMinute: 1_000,
    maxConcurrent: 8,
    fetchImpl: async () => openAiResponse(recheckOutput()),
  });
  assert.deepEqual(sourceRecord, before);
  assert.equal(result.action, "recheck_task");
  assert.equal(result.recheck.taskId, "licence");
  assert.equal(result.recheck.status, "partial");
  assert.equal(result.recheck.confidence, 62);
  assert.equal(Object.hasOwn(result, "detection"), false);
  assert.equal(Object.hasOwn(result, "readiness"), false);
  assert.equal(Object.hasOwn(result, "done"), false);
});

test("origin, authorization, configuration, content type, JSON, task id, and body limits fail before OpenAI", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return openAiResponse(planOutput()); };

  const crossOrigin = new Request("https://airight.example/api/detect/copilot", {
    method: "POST",
    headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: JSON.stringify({ action: "generate_plan", record: record() }),
  });
  assert.equal((await handleDetection(crossOrigin, { env, fetchImpl })).status, 403);

  assert.equal((await handleDetection(copilotRequest({ action: "generate_plan", record: record() }, { "X-Admin-Key": "wrong" }), { env, fetchImpl })).status, 401);

  const missingKey = await handleDetection(copilotRequest({ action: "generate_plan", record: record() }), { env: { ADMIN_PASSWORD: env.ADMIN_PASSWORD }, fetchImpl });
  assert.equal(missingKey.status, 503);
  assert.equal((await missingKey.json()).type, "OPENAI_NOT_CONFIGURED");

  const wrongType = request("/api/detect/copilot", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Admin-Key": env.ADMIN_PASSWORD },
    body: "text",
  });
  assert.equal((await handleDetection(wrongType, { env, fetchImpl })).status, 415);

  const invalidJson = await handleDetection(copilotRequest("{"), { env, fetchImpl });
  assert.equal(invalidJson.status, 400);

  const missingTask = await handleDetection(copilotRequest({ action: "recheck_task", record: record(), taskId: "not-a-task" }), { env, fetchImpl });
  assert.equal(missingTask.status, 422);

  const tooLarge = await handleDetection(copilotRequest({ action: "generate_plan", record: record() }, { "Content-Length": String(64 * 1024 + 1) }), { env, fetchImpl });
  assert.equal(tooLarge.status, 413);
  assert.equal(calls, 0);
});

test("provider 429, timeout, and auth failure are sanitized and never retried", async () => {
  const scenarios = [
    { response: () => new Response(JSON.stringify({ error: { message: `secret ${env.OPENAI_API_KEY}` } }), { status: 429 }), status: 429, type: "OPENAI_RATE_LIMIT" },
    { response: () => new Response(JSON.stringify({ error: { message: `secret ${env.OPENAI_API_KEY}` } }), { status: 401 }), status: 502, type: "OPENAI_AUTH_FAILED" },
    { response: () => { const error = new Error(`secret ${env.OPENAI_API_KEY}`); error.name = "TimeoutError"; throw error; }, status: 504, type: "OPENAI_TIMEOUT" },
  ];
  for (const scenario of scenarios) {
    let calls = 0;
    const response = await handleDetection(copilotRequest({ action: "generate_plan", record: record() }), {
      env,
      fetchImpl: async () => { calls += 1; return scenario.response(); },
    });
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(calls, 1);
    assert.equal(response.status, scenario.status);
    assert.equal(body.type, scenario.type);
    assert.doesNotMatch(text, new RegExp(env.OPENAI_API_KEY));
  }
});

test("incomplete, refusal, missing output_text, and malformed structured JSON fail closed", async () => {
  const scenarios = [
    { payload: { id: "incomplete", model: env.OPENAI_MODEL, status: "incomplete", output: [] }, type: "OPENAI_INCOMPLETE_RESPONSE" },
    { payload: { id: "refusal", model: env.OPENAI_MODEL, status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }, type: "OPENAI_REFUSAL" },
    { payload: { id: "empty", model: env.OPENAI_MODEL, status: "completed", output_text: JSON.stringify(planOutput()), output: [] }, type: "OPENAI_EMPTY_RESPONSE" },
    { payload: { id: "bad-json", model: env.OPENAI_MODEL, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{" }] }] }, type: "OPENAI_INVALID_RESPONSE" },
  ];
  for (const scenario of scenarios) {
    const response = await handleDetection(copilotRequest({ action: "generate_plan", record: record() }), {
      env,
      fetchImpl: async () => new Response(JSON.stringify(scenario.payload), { status: 200 }),
    });
    const body = await response.json();
    assert.equal(response.status >= 400, true);
    assert.equal(body.type, scenario.type);
  }
});

test("mismatched re-checks and overconfident authorship claims are rejected", async () => {
  const wrongTask = recheckOutput();
  wrongTask.recheck.taskId = "human-51";
  const mismatch = await handleDetection(copilotRequest({ action: "recheck_task", record: record(), taskId: "licence" }), {
    env,
    fetchImpl: async () => openAiResponse(wrongTask),
  });
  assert.equal((await mismatch.json()).type, "OPENAI_INVALID_RESPONSE");

  const unsafe = planOutput();
  unsafe.summary = "This confirms human authorship.";
  const claim = await handleDetection(copilotRequest({ action: "generate_plan", record: record() }), {
    env,
    fetchImpl: async () => openAiResponse(unsafe),
  });
  assert.equal((await claim.json()).type, "OPENAI_UNSAFE_CLAIM");
});

test("local paid-provider routes fail closed before body reads and require same-origin JSON", async () => {
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const handlerStart = source.indexOf("async function handleApi");
  const activeOriginGuard = source.indexOf("if (!requestOriginAllowed(req))", handlerStart);
  const paidModeGuard = source.indexOf("if (PAID_MODE_LOCKED)", handlerStart);
  const authorizationGuard = source.indexOf("if (!isAuthorized(req))", handlerStart);
  const jsonGuard = source.indexOf('if (kind === "copilot")', authorizationGuard);
  const bodyRead = source.indexOf("body = await readBody", handlerStart);
  assert.ok(handlerStart >= 0);
  assert.ok(activeOriginGuard > handlerStart && activeOriginGuard < paidModeGuard);
  assert.ok(paidModeGuard < authorizationGuard);
  assert.ok(authorizationGuard < jsonGuard && jsonGuard < bodyRead);
  assert.match(source, /const PAID_MODE_LOCKED = PAID_PROVIDER_CREDENTIALS_PRESENT && !ADMIN_PASSWORD/);
  assert.match(source, /contentType !== "application\/json"/);
  assert.match(source, /configured: OPENAI_ENABLED/);
  assert.match(source, /evidenceCopilot: OPENAI_ENABLED/);
});
