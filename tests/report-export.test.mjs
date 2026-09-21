import assert from "node:assert/strict";
import test from "node:test";

await import("../js/report-export.js");

const exporter = globalThis.ArightReportExport;
const decoder = new TextDecoder();

function unzipStoredEntries(bytes) {
  const entries = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const checksum = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const nameSize = view.getUint16(offset + 26, true);
    const extraSize = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameSize + extraSize;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameSize));
    const data = bytes.slice(dataStart, dataStart + size);
    assert.equal(method, 0, `${name} should be stored without compression`);
    assert.equal(exporter.crc32(data), checksum, `${name} should have a valid CRC-32`);
    entries.set(name, data);
    offset = dataStart + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, "central directory should follow local entries");
  return entries;
}

test("CRC-32 matches the standard check vector", () => {
  assert.equal(exporter.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("evidence package contains a printable report, hashes, verification and available attachments", async () => {
  const goodBytes = new TextEncoder().encode("licensed source material");
  const mismatchBytes = new TextEncoder().encode("changed after it was attached");
  const goodHash = await exporter.sha256(goodBytes);
  const record = {
    id: "AR-TEST123",
    name: "Test record",
    type: "image",
    createdAt: "2026-09-21T08:00:00.000Z",
    fingerprint: "a".repeat(64),
    detection: { aiPct: 81, verdict: "High AI-model signal" },
    copilot: {
      generatedAt: "2026-09-21T08:30:00.000Z",
      model: "gpt-test",
      detailedPlan: [{
        taskId: "human-review",
        why: "The record needs a traceable human review.",
        steps: ["Inspect the source", "Record the decision"],
        acceptanceCriteria: ["A named reviewer signs off"],
        evidenceToCollect: ["Review note"],
      }],
      evidenceDraftText: "I reviewed the source and recorded the decisions.",
    },
    tasks: [{
      id: "human-review",
      title: "Complete a human review",
      detail: "Document the substantive decisions.",
      priority: "high",
      done: true,
      completedAt: "2026-09-21T08:45:00.000Z",
      evidence: [
        { id: "good", name: "approval.pdf", size: goodBytes.byteLength, mime: "application/pdf", sha256: goodHash },
        { id: "changed", name: "../changed?.txt", size: mismatchBytes.byteLength, mime: "text/plain", sha256: "b".repeat(64) },
        { id: "missing", name: "missing.txt", size: 42, mime: "text/plain", sha256: "c".repeat(64) },
      ],
    }],
  };

  const result = await exporter.assembleEvidencePackage(record, {
    exportedAt: "2026-09-21T09:00:00.000Z",
    attachmentResolver: async (_taskId, item) => ({ good: goodBytes, changed: mismatchBytes }[item.id] || null),
  });
  const zipView = new DataView(result.zipBytes.buffer, result.zipBytes.byteOffset, result.zipBytes.byteLength);
  assert.equal(zipView.getUint32(0, true), 0x04034b50, "ZIP should start with a local-file signature");
  assert.equal(zipView.getUint32(result.zipBytes.byteLength - 22, true), 0x06054b50, "ZIP should end with an EOCD signature");
  const entries = unzipStoredEntries(result.zipBytes);
  const names = [...entries.keys()];

  assert.ok(names.includes("manifest.json"));
  assert.ok(names.includes("report.html"));
  assert.ok(names.includes("hashes.sha256"));
  assert.ok(names.includes("verification.json"));
  assert.equal(names.filter((name) => name.startsWith("attachments/")).length, 2);
  assert.ok(names.every((name) => !name.includes("../") && !name.startsWith("/")), "ZIP paths should be traversal-safe");

  const manifest = JSON.parse(decoder.decode(entries.get("manifest.json")));
  const verification = JSON.parse(decoder.decode(entries.get("verification.json")));
  const report = decoder.decode(entries.get("report.html"));
  const hashes = decoder.decode(entries.get("hashes.sha256"));

  assert.equal(manifest.format, "aright-evidence-package/1");
  assert.equal(manifest.package.attachments.find((item) => item.id === "good").packageStatus, "included-and-matched");
  assert.equal(manifest.package.attachments.find((item) => item.id === "changed").packageStatus, "hash-mismatch");
  assert.equal(manifest.package.attachments.find((item) => item.id === "missing").packageStatus, "missing-from-browser");
  assert.match(report, /Aright evidence report/);
  assert.match(report, /Aright detailed plan/);
  assert.match(report, /Inspect the source/);
  assert.match(report, /Editable Human-work statement/);
  assert.match(report, /explicit user confirmation/i);
  assert.match(report, /not digitally signed/i);
  assert.match(hashes, /^[a-f\d]{64}  manifest\.json$/m);
  assert.match(hashes, /^[a-f\d]{64}  report\.html$/m);
  assert.equal(verification.digitalSignature, false);
  assert.equal(verification.trustedTimestamp, false);
  assert.equal(verification.status, "attention-required");
  assert.equal(verification.attachmentSummary.included, 2);
  assert.equal(verification.attachmentSummary.missing, 1);
  assert.equal(verification.attachmentSummary.hashMismatches, 1);
  assert.match(verification.verificationFingerprint, /^sha256:[a-f\d]{64}$/);
  assert.match(result.filename, /^aright-evidence-AR-TEST123-[a-f\d]{8}\.zip$/);
});

test("stable downloadZip API accepts a record, evidence JSON and object-shaped attachment resolver", async () => {
  const attachment = new TextEncoder().encode("review note");
  const hash = await exporter.sha256(attachment);
  const record = {
    id: "AR-API",
    name: "API contract",
    type: "text",
    createdAt: "2026-09-21T08:00:00.000Z",
    detection: { aiPct: 20 },
    tasks: [{ id: "review", title: "Review", evidence: [{ id: "note", name: "note.txt", size: attachment.length, sha256: hash }] }],
  };
  let resolverInput;
  const result = await exporter.downloadZip({
    record,
    evidenceJson: { id: record.id, custom: true },
    exportedAt: "2026-09-21T09:00:00.000Z",
    getAttachment: async (input) => {
      resolverInput = input;
      return attachment;
    },
  });
  assert.deepEqual({ recordId: resolverInput.recordId, taskId: resolverInput.taskId, evidenceId: resolverInput.evidence.id }, { recordId: "AR-API", taskId: "review", evidenceId: "note" });
  assert.equal(result.manifest.record.custom, true);
  assert.equal(result.verification.status, "package-complete");
});

test("legacy one-click completion is exported as open and requiring reconfirmation", async () => {
  const record = {
    id: "AR-LEGACY",
    name: "Legacy workflow record",
    type: "code",
    createdAt: "2026-09-20T08:00:00.000Z",
    previousReviewCompletedAt: "2026-09-20T09:00:00.000Z",
    detection: { aiPct: 71 },
    tasks: [{
      id: "human-51",
      title: "Raise Human contribution",
      detail: "Reconfirm the completed work under the current workflow.",
      priority: "high",
      done: false,
      completedAt: null,
      previouslyMarkedDone: true,
      evidence: [],
    }],
  };

  const result = await exporter.assembleEvidencePackage(record, { exportedAt: "2026-09-21T09:00:00.000Z" });
  const entries = unzipStoredEntries(result.zipBytes);
  const manifest = JSON.parse(decoder.decode(entries.get("manifest.json")));
  const report = decoder.decode(entries.get("report.html"));

  assert.equal(manifest.record.actionPlan[0].completionConfirmed, false);
  assert.equal(manifest.record.actionPlan[0].previouslyMarkedDone, true);
  assert.match(report, /Previously marked done/);
  assert.match(report, /Reconfirmation required/);
  assert.match(report, /Earlier workflow review/);
  assert.doesNotMatch(report, /<td>Confirmed<\/td>/);
});
