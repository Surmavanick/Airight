/* Aright report exports
   Builds a local, dependency-free ZIP evidence package and adds a browser
   Print / Save PDF action. A package fingerprint is not a digital signature. */

(function initArightReportExport(global) {
  "use strict";

  const DB_NAME = "aright.task-evidence.v1";
  const DB_STORE = "files";
  const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
  const MAX_ZIP_ENTRIES = 128;
  const encoder = new TextEncoder();

  let crcTable;

  function utf8(value) {
    return encoder.encode(String(value ?? ""));
  }

  async function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    return utf8(value);
  }

  function concatBytes(parts) {
    const size = parts.reduce((total, part) => total + part.byteLength, 0);
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return joined;
  }

  function makeCrcTable() {
    return Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
      return value >>> 0;
    });
  }

  function crc32(bytes) {
    if (!crcTable) crcTable = makeCrcTable();
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipDate(value = new Date()) {
    const date = value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    return {
      time: ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
      date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f),
    };
  }

  function safePathPart(value, fallback = "item") {
    const cleaned = String(value || fallback)
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/^\.+|\.+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
  }

  function uniquePath(path, used) {
    const normalized = String(path)
      .split("/")
      .filter(Boolean)
      .map((part) => safePathPart(part))
      .join("/");
    const base = normalized || "item";
    if (!used.has(base.toLowerCase())) {
      used.add(base.toLowerCase());
      return base;
    }
    const slash = base.lastIndexOf("/");
    const directory = slash >= 0 ? base.slice(0, slash + 1) : "";
    const filename = slash >= 0 ? base.slice(slash + 1) : base;
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : "";
    let index = 2;
    let candidate;
    do {
      candidate = `${directory}${stem}-${index}${extension}`;
      index += 1;
    } while (used.has(candidate.toLowerCase()));
    used.add(candidate.toLowerCase());
    return candidate;
  }

  async function sha256(bytes) {
    if (!global.crypto?.subtle) throw new Error("SHA-256 is unavailable in this browser context.");
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function buildZipBytes(entries, modifiedAt = new Date()) {
    if (!Array.isArray(entries) || !entries.length) throw new Error("The ZIP package has no files.");
    if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`The ZIP package exceeds the ${MAX_ZIP_ENTRIES}-file limit.`);

    const usedPaths = new Set();
    const prepared = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const name = uniquePath(entry.name, usedPaths);
      const nameBytes = utf8(name);
      const data = await toBytes(entry.data);
      totalBytes += data.byteLength;
      if (totalBytes > MAX_PACKAGE_BYTES) throw new Error("The evidence package exceeds the 64 MB browser export limit.");
      prepared.push({ name, nameBytes, data, crc: crc32(data) });
    }

    const stamp = zipDate(modifiedAt);
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    for (const entry of prepared) {
      const local = new Uint8Array(30 + entry.nameBytes.byteLength);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, stamp.time, true);
      localView.setUint16(12, stamp.date, true);
      localView.setUint32(14, entry.crc, true);
      localView.setUint32(18, entry.data.byteLength, true);
      localView.setUint32(22, entry.data.byteLength, true);
      localView.setUint16(26, entry.nameBytes.byteLength, true);
      localView.setUint16(28, 0, true);
      local.set(entry.nameBytes, 30);
      localParts.push(local, entry.data);

      const central = new Uint8Array(46 + entry.nameBytes.byteLength);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, stamp.time, true);
      centralView.setUint16(14, stamp.date, true);
      centralView.setUint32(16, entry.crc, true);
      centralView.setUint32(20, entry.data.byteLength, true);
      centralView.setUint32(24, entry.data.byteLength, true);
      centralView.setUint16(28, entry.nameBytes.byteLength, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, localOffset, true);
      central.set(entry.nameBytes, 46);
      centralParts.push(central);
      localOffset += local.byteLength + entry.data.byteLength;
    }

    const centralDirectory = concatBytes(centralParts);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, prepared.length, true);
    endView.setUint16(10, prepared.length, true);
    endView.setUint32(12, centralDirectory.byteLength, true);
    endView.setUint32(16, localOffset, true);
    endView.setUint16(20, 0, true);
    return concatBytes([...localParts, centralDirectory, end]);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not recorded";
  }

  function normalizeEvidence(record) {
    return (record.tasks || []).flatMap((task) => (Array.isArray(task.evidence) ? task.evidence : []).map((item) => ({
      taskId: String(task.id || "task"),
      taskTitle: String(task.title || "Task"),
      id: String(item.id || "evidence"),
      name: String(item.name || "Evidence file"),
      size: Number(item.size) || 0,
      mime: String(item.mime || "application/octet-stream"),
      sha256: /^[a-f\d]{64}$/i.test(String(item.sha256 || "")) ? String(item.sha256).toLowerCase() : null,
      addedAt: item.addedAt || null,
    })));
  }

  function fallbackEvidenceRecord(record) {
    return {
      id: record.id,
      name: record.name,
      type: record.type,
      analyzedAt: record.createdAt,
      sha256: record.fingerprint || null,
      status: record.protectedAt ? "Review complete" : "Review open",
      reviewCompletedAt: record.protectedAt || null,
      previousReviewCompletedAt: record.previousReviewCompletedAt || null,
      detection: {
        detector: record.detection?.model?.name || record.detection?.provider || "Recorded detector",
        aiModelScore: record.detection?.aiPct ?? null,
        verdict: record.detection?.verdict || null,
      },
      actionPlan: (record.tasks || []).map((task) => ({
        id: task.id,
        title: task.title,
        detail: task.detail,
        priority: task.priority,
        done: Boolean(task.done && task.completedAt),
        completionConfirmed: Boolean(task.done && task.completedAt),
        completedAt: task.completedAt || null,
        previouslyMarkedDone: Boolean(task.previouslyMarkedDone),
        supportingEvidence: Array.isArray(task.evidence) ? task.evidence : [],
      })),
      evidenceCopilot: record.copilot ? {
        schemaVersion: record.copilot.schemaVersion || 0,
        model: record.copilot.model || null,
        responseId: record.copilot.responseId || null,
        generatedAt: record.copilot.generatedAt || null,
        summary: record.copilot.summary || null,
        detailedPlan: Array.isArray(record.copilot.detailedPlan) ? record.copilot.detailedPlan : [],
        editableHumanWorkStatement: record.copilot.evidenceDraftText || null,
        userEdited: Boolean(record.copilot.draftEdited),
        draftUpdatedAt: record.copilot.draftUpdatedAt || null,
        rechecks: record.copilot.rechecks || {},
      } : null,
    };
  }

  function reportHtml(record, evidenceRecord, packageAttachments, exportedAt) {
    const score = evidenceRecord.detection?.aiModelScore;
    const arightPlan = Array.isArray(evidenceRecord.evidenceCopilot?.detailedPlan)
      ? evidenceRecord.evidenceCopilot.detailedPlan
      : [];
    const planByTask = new Map(arightPlan.map((item) => [String(item.taskId || ""), item]));
    const list = (title, items) => Array.isArray(items) && items.length
      ? `<section class="task-detail"><strong>${escapeHtml(title)}</strong><ol>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></section>`
      : "";
    const taskRows = (record.tasks || []).map((task) => {
      const files = packageAttachments.filter((item) => item.taskId === String(task.id));
      const detail = planByTask.get(String(task.id));
      const evidence = files.length
        ? `<ul>${files.map((item) => `<li>${escapeHtml(item.name)} — ${escapeHtml(item.packageStatus)}${item.actualSha256 ? ` — SHA-256 <code>${escapeHtml(item.actualSha256)}</code>` : ""}</li>`).join("")}</ul>`
        : "None attached";
      const fullPlan = detail ? `<div class="aright-plan"><b>Aright detailed plan</b>${detail.why ? `<p>${escapeHtml(detail.why)}</p>` : ""}${list("Recommended steps", detail.steps)}${list("Acceptance criteria", detail.acceptanceCriteria)}${list("Evidence to collect", detail.evidenceToCollect)}</div>` : "";
      const confirmed = Boolean(task.done && task.completedAt);
      const status = confirmed ? "Confirmed" : task.previouslyMarkedDone ? "Previously marked done" : "Open";
      const statusNote = confirmed
        ? `<small>${escapeHtml(formatDate(task.completedAt))}</small>`
        : task.previouslyMarkedDone
          ? `<small>Reconfirmation required under the current workflow</small>`
          : "";
      return `<tr><td>${status}${statusNote}</td><td><strong>${escapeHtml(task.title)}</strong><br><span>${escapeHtml(task.detail || "")}</span>${fullPlan}</td><td>${escapeHtml(task.priority || "")}</td><td>${evidence}</td></tr>`;
    }).join("");
    const draft = evidenceRecord.evidenceCopilot?.editableHumanWorkStatement;
    const draftSection = draft ? `<h2>Editable Human-work statement</h2><p class="note">Aright plan draft · AI-assisted using OpenAI · review every claim before use.</p><pre class="draft">${escapeHtml(draft)}</pre>` : "";
    const planMeta = evidenceRecord.evidenceCopilot?.generatedAt
      ? `<p class="note">Aright detailed plan generated ${escapeHtml(formatDate(evidenceRecord.evidenceCopilot.generatedAt))}${evidenceRecord.evidenceCopilot.model ? ` · model ${escapeHtml(evidenceRecord.evidenceCopilot.model)}` : ""}.</p>`
      : `<p class="note">No generated Aright detailed plan was available at export time; the basic checklist is preserved below.</p>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aright evidence report — ${escapeHtml(record.id)}</title><style>
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#20211e;max-width:980px;margin:40px auto;padding:0 24px}h1{margin-bottom:4px}h2{margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:8px}.meta{display:grid;grid-template-columns:180px 1fr;gap:6px 18px}.meta dt{color:#666}.meta dd{margin:0;font-weight:600}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border:1px solid #ddd;padding:10px}th{background:#f3f1ec}td span,.note{color:#666}td small{display:block;color:#666;margin-top:4px}.aright-plan{margin-top:12px;padding:12px;border-left:3px solid #0b526a;background:#f4f8f9}.aright-plan p{margin:6px 0}.task-detail{margin-top:9px}.task-detail strong{font-size:12px;text-transform:uppercase;letter-spacing:.04em}.task-detail ol{margin:5px 0 0;padding-left:20px}.draft{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;border:1px solid #ddd;background:#faf9f6;font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}code{font-size:11px;overflow-wrap:anywhere}@media print{body{margin:0;max-width:none}tr,.aright-plan{break-inside:avoid}}
</style></head><body>
<header><p>ARIGHT · EVIDENCE REPORT</p><h1>${escapeHtml(record.name || "Analysis record")}</h1><p class="note">Exported ${escapeHtml(formatDate(exportedAt))}</p></header>
  <h2>Record</h2><dl class="meta"><dt>Record ID</dt><dd>${escapeHtml(record.id)}</dd><dt>Type</dt><dd>${escapeHtml(record.type)}</dd><dt>Analyzed</dt><dd>${escapeHtml(formatDate(record.createdAt))}</dd><dt>Detector signal</dt><dd>${score == null ? "Not available" : `${escapeHtml(score)}%`}</dd><dt>Original fingerprint</dt><dd><code>${escapeHtml(record.fingerprint || "Not computed")}</code></dd>${evidenceRecord.previousReviewCompletedAt ? `<dt>Earlier workflow review</dt><dd>${escapeHtml(formatDate(evidenceRecord.previousReviewCompletedAt))} · reconfirmation required</dd>` : ""}</dl>
<h2>Aright plan</h2>${planMeta}<table><thead><tr><th>Status</th><th>Task and detailed plan</th><th>Priority</th><th>Supporting evidence</th></tr></thead><tbody>${taskRows || '<tr><td colspan="4">No tasks recorded.</td></tr>'}</tbody></table>
${draftSection}
<h2>Important limitation</h2><p class="note">Detector scores are screening signals, not proof of authorship, infringement, or legal protection. A task counts only after explicit user confirmation, which remains a user declaration rather than independent proof. This local package uses SHA-256 fingerprints for integrity checking; it is not digitally signed, independently timestamped, or tamper-evident.</p>
</body></html>`;
  }

  function openEvidenceDb() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error("Browser evidence storage is unavailable."));
        return;
      }
      const request = global.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Browser evidence storage could not be opened."));
      request.onblocked = () => reject(new Error("Browser evidence storage is blocked by another tab."));
    });
  }

  async function storedAttachment(recordId, taskId, evidenceId) {
    const db = await openEvidenceDb();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(DB_STORE, "readonly");
        const request = transaction.objectStore(DB_STORE).get(`${recordId}:${taskId}:${evidenceId}`);
        request.onsuccess = () => resolve(request.result?.blob || null);
        request.onerror = () => reject(request.error || new Error("The evidence attachment could not be read."));
      });
    } finally {
      db.close();
    }
  }

  async function assembleEvidencePackage(record, options = {}) {
    if (!record?.id) throw new Error("No analysis record is open.");
    const exportedAt = options.exportedAt || new Date().toISOString();
    const evidenceRecord = options.evidenceRecord || fallbackEvidenceRecord(record);
    const resolveAttachment = options.attachmentResolver || ((taskId, item) => storedAttachment(record.id, taskId, item.id));
    const evidence = normalizeEvidence(record);
    const usedPaths = new Set(["manifest.json", "report.html", "hashes.sha256", "verification.json"]);
    const attachmentEntries = [];
    const packageAttachments = [];
    let attachmentBytes = 0;

    for (const item of evidence) {
      let value = null;
      try {
        value = await resolveAttachment(item.taskId, item);
      } catch {
        value = null;
      }
      if (value == null) {
        packageAttachments.push({ ...item, packagePath: null, packageStatus: "missing-from-browser", actualSha256: null });
        continue;
      }
      const data = await toBytes(value);
      attachmentBytes += data.byteLength;
      if (attachmentBytes > MAX_PACKAGE_BYTES - (2 * 1024 * 1024)) throw new Error("The evidence attachments exceed the browser package limit.");
      const path = uniquePath(`attachments/${safePathPart(item.taskId, "task")}/${safePathPart(item.id, "evidence")}-${safePathPart(item.name, "file")}`, usedPaths);
      const actualSha256 = await sha256(data);
      const packageStatus = item.sha256 && item.sha256 !== actualSha256 ? "hash-mismatch" : item.sha256 ? "included-and-matched" : "included-unverified";
      packageAttachments.push({ ...item, packagePath: path, packageStatus, actualSha256 });
      attachmentEntries.push({ name: path, data });
    }

    const manifest = {
      format: "aright-evidence-package/1",
      exportedAt,
      record: evidenceRecord,
      package: {
        attachmentBytesIncluded: true,
        attachmentStorageSource: "browser-indexeddb",
        attachments: packageAttachments,
        limitation: "This is a browser-built evidence bundle with a local verification fingerprint. It is not a digital signature, trusted timestamp, or tamper-evident legal record.",
      },
    };
    const manifestBytes = utf8(`${JSON.stringify(manifest, null, 2)}\n`);
    const htmlBytes = utf8(reportHtml(record, evidenceRecord, packageAttachments, exportedAt));
    const hashedEntries = [
      { name: "manifest.json", data: manifestBytes },
      { name: "report.html", data: htmlBytes },
      ...attachmentEntries,
    ];
    const hashes = [];
    for (const entry of hashedEntries) hashes.push(`${await sha256(entry.data)}  ${entry.name}`);
    const hashesBytes = utf8(`${hashes.join("\n")}\n`);
    const fingerprint = await sha256(hashesBytes);
    const problems = packageAttachments.filter((item) => !["included-and-matched", "included-unverified"].includes(item.packageStatus));
    const verification = {
      format: "aright-local-verification/1",
      packageId: `ARPK-${fingerprint.slice(0, 24).toUpperCase()}`,
      verificationFingerprint: `sha256:${fingerprint}`,
      fingerprintTarget: "hashes.sha256",
      algorithm: "SHA-256",
      status: problems.length ? "attention-required" : "package-complete",
      digitalSignature: false,
      trustedTimestamp: false,
      attachmentSummary: {
        declared: evidence.length,
        included: attachmentEntries.length,
        missing: packageAttachments.filter((item) => item.packageStatus === "missing-from-browser").length,
        hashMismatches: packageAttachments.filter((item) => item.packageStatus === "hash-mismatch").length,
        includedWithoutPriorHash: packageAttachments.filter((item) => item.packageStatus === "included-unverified").length,
      },
      limitation: "Local verification fingerprint only. This file does not claim a digital signature, signer identity, trusted timestamp, or independent custody.",
    };
    const verificationBytes = utf8(`${JSON.stringify(verification, null, 2)}\n`);
    const zipBytes = await buildZipBytes([
      ...hashedEntries,
      { name: "hashes.sha256", data: hashesBytes },
      { name: "verification.json", data: verificationBytes },
    ], new Date(exportedAt));
    const safeId = safePathPart(record.id, "record");
    return {
      filename: `aright-evidence-${safeId}-${fingerprint.slice(0, 8)}.zip`,
      zipBytes,
      manifest,
      verification,
    };
  }

  function currentAnalysisRecord() {
    const reportId = global.document?.querySelector("#report")?.dataset.recordId;
    try {
      if (typeof currentRecord === "function") {
        const record = currentRecord();
        if (record && (!reportId || record.id === reportId)) return record;
      }
    } catch {
      // Fall through to the browser record below.
    }
    try {
      const records = JSON.parse(global.localStorage?.getItem("aright.console.assets.v1") || "[]");
      return Array.isArray(records) ? records.find((item) => item?.id === reportId) || null : null;
    } catch {
      return null;
    }
  }

  function evidenceRecordFor(record) {
    try {
      if (typeof evidenceOf === "function") return evidenceOf(record);
    } catch {
      // The fallback intentionally exports a smaller, safe record.
    }
    return fallbackEvidenceRecord(record);
  }

  function announce(message) {
    const live = global.document?.querySelector("#evidenceLive");
    if (!live) return;
    live.textContent = "";
    global.requestAnimationFrame(() => { live.textContent = message; });
  }

  function download(filename, bytes, type) {
    const url = global.URL.createObjectURL(new Blob([bytes], { type }));
    const link = Object.assign(global.document.createElement("a"), { href: url, download: filename });
    global.document.body.append(link);
    link.click();
    link.remove();
    global.setTimeout(() => global.URL.revokeObjectURL(url), 1000);
  }

  async function downloadZip({ record, evidenceJson, getAttachment, exportedAt } = {}) {
    const attachmentResolver = typeof getAttachment === "function"
      ? (taskId, evidence) => getAttachment({ recordId: record?.id, taskId, evidence })
      : undefined;
    const result = await assembleEvidencePackage(record, {
      evidenceRecord: evidenceJson || fallbackEvidenceRecord(record),
      attachmentResolver,
      exportedAt,
    });
    if (global.document) download(result.filename, result.zipBytes, "application/zip");
    return result;
  }

  function exportButton(kind, label) {
    const button = global.document.createElement("button");
    button.className = "btn btn--outline report-export__button";
    button.type = "button";
    button.dataset.reportExport = kind;
    button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${kind === "print" ? "text" : "download"}"/></svg>${label}`;
    return button;
  }

  function installButtons() {
    const report = global.document?.querySelector("#report");
    if (!report) return;
    if (report.querySelector('[data-report-export="print"]') && report.querySelector('[data-report-export="package"]')) return;
    const actions = report.querySelector(".plan-export-actions") || report.querySelector(".summary__actions") || report.querySelector(".review-package .actions");
    if (!actions) return;
    if (!report.querySelector('[data-report-export="print"]')) actions.append(exportButton("print", "Save report & plan as PDF"));
    if (!report.querySelector('[data-report-export="package"]')) actions.append(exportButton("package", "Download ZIP package"));
  }

  function syncPrintDrafts() {
    for (const textarea of global.document?.querySelectorAll("[data-copilot-draft]") || []) {
      let mirror = textarea.nextElementSibling;
      if (!mirror?.matches?.("[data-report-export-draft]")) {
        mirror = global.document.createElement("div");
        mirror.className = "report-export__draft-print";
        mirror.dataset.reportExportDraft = "";
        mirror.setAttribute("aria-hidden", "true");
        textarea.insertAdjacentElement("afterend", mirror);
      }
      mirror.textContent = textarea.value;
    }
  }

  function printCurrentReport() {
    const record = currentAnalysisRecord();
    if (!record) {
      announce("Open an analysis record before printing its report.");
      return;
    }
    syncPrintDrafts();
    const previousTitle = global.document.title;
    global.document.title = `Aright evidence report - ${record.id}`;
    const restore = () => { global.document.title = previousTitle; };
    global.addEventListener("afterprint", restore, { once: true });
    global.print();
    global.setTimeout(restore, 2000);
  }

  async function downloadCurrentPackage(button) {
    const record = currentAnalysisRecord();
    if (!record) {
      announce("Open an analysis record before downloading its evidence package.");
      return;
    }
    const original = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Building package…";
    try {
      const result = await downloadZip({ record, evidenceJson: evidenceRecordFor(record) });
      const summary = result.verification.attachmentSummary;
      const warning = summary.missing || summary.hashMismatches
        ? ` Review verification.json: ${summary.missing} missing and ${summary.hashMismatches} hash-mismatched attachments.`
        : "";
      announce(`Downloaded ZIP evidence package. Verification fingerprint ${result.verification.verificationFingerprint}.${warning}`);
    } catch (error) {
      announce(`The ZIP evidence package could not be built. ${error?.message || "Try again after reloading."}`);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.innerHTML = original;
    }
  }

  function installBrowserIntegration() {
    const report = global.document.querySelector("#report");
    if (!report) return;
    installButtons();
    new MutationObserver(installButtons).observe(report, { childList: true, subtree: true });
    global.addEventListener("beforeprint", syncPrintDrafts);
    global.document.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-report-export]");
      if (!button) return;
      if (button.dataset.reportExport === "print") printCurrentReport();
      if (button.dataset.reportExport === "package") void downloadCurrentPackage(button);
    });
  }

  global.ArightReportExport = Object.freeze({
    assembleEvidencePackage,
    buildZipBytes,
    crc32,
    downloadZip,
    safePathPart,
    sha256,
  });

  if (global.document) installBrowserIntegration();
})(globalThis);
