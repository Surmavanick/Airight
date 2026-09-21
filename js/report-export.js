/* Aright report exports
   Builds a local, dependency-free ZIP evidence package and adds a browser
   Print / Save PDF action. A package fingerprint is not a digital signature. */

(function initArightReportExport(global) {
  "use strict";

  const DB_NAME = "aright.task-evidence.v1";
  const DB_STORE = "files";
  const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
  const MAX_ZIP_ENTRIES = 128;
  const CERTIFICATE_VERSION = "aright-evidence-certificate/1";
  const CERTIFICATE_PATH = "certificate.pdf";
  const CERTIFICATE_SEAL_PATH = "../assets/img/aright-platform-seal.png";
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

  function formatUtcDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Not recorded";
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(date).replace(",", "") + " UTC";
  }

  function cleanCertificateText(value, limit = 240) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);
  }

  function normalizedCertificateClaim(record, evidenceRecord) {
    const raw = evidenceRecord?.certificateClaim || record?.certificateClaim || {};
    let holderName = cleanCertificateText(raw.holderName, 160);
    let holderType = "self-declared";
    let holderStatus = holderName ? "self-attested" : "not-provided";
    if (!holderName && record?.type === "code") {
      const repository = evidenceRecord?.repository || record?.repository || record?.detection?.repository;
      holderName = cleanCertificateText(repository?.owner?.login || String(repository?.fullName || "").split("/")[0], 160);
      if (holderName) {
        holderType = "github-repository-owner";
        holderStatus = "github-public-metadata";
      }
    }
    const confirmedAt = raw.confirmedAt && Number.isFinite(new Date(raw.confirmedAt).getTime())
      ? new Date(raw.confirmedAt).toISOString()
      : null;
    return {
      holderName,
      holderType,
      holderStatus,
      confirmedAt,
    };
  }

  function certificateSignal(record, evidenceRecord) {
    const value = Number(evidenceRecord?.detection?.aiModelScore ?? record?.detection?.aiPct);
    const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value * 10) / 10)) : null;
    const isCode = record?.type === "code";
    return {
      percent,
      label: isCode ? "Illustrative estimated AI-assisted share" : "Recorded AI-class screening signal",
      semantics: cleanCertificateText(
        evidenceRecord?.detection?.scoreSemantics || (isCode
          ? "URL-seeded illustrative estimate; not forensic model attribution"
          : "screening-model score; not a calibrated authorship probability"),
        300,
      ),
    };
  }

  async function certificateDescriptor(record, evidenceRecord, issuedAt) {
    const claim = normalizedCertificateClaim(record, evidenceRecord);
    const signal = certificateSignal(record, evidenceRecord);
    const canonical = {
      version: CERTIFICATE_VERSION,
      recordId: cleanCertificateText(record?.id, 120),
      title: cleanCertificateText(record?.name || evidenceRecord?.name || "Untitled work", 240),
      holderName: claim.holderName,
      holderType: claim.holderType,
      analyzedAt: record?.createdAt || evidenceRecord?.analyzedAt || null,
      fingerprint: /^[a-f\d]{64}$/i.test(String(record?.fingerprint || evidenceRecord?.sha256 || ""))
        ? String(record?.fingerprint || evidenceRecord?.sha256).toLowerCase()
        : null,
      signalPercent: signal.percent,
      signalSemantics: signal.semantics,
    };
    const tokenHash = await sha256(utf8(JSON.stringify(canonical)));
    return {
      version: CERTIFICATE_VERSION,
      token: `AR-CERT-${tokenHash.slice(0, 24).toUpperCase()}`,
      recordId: canonical.recordId || "Not recorded",
      title: canonical.title,
      fingerprint: canonical.fingerprint,
      issuedAt,
      analyzedAt: canonical.analyzedAt,
      claim,
      signal,
      statement: claim.holderStatus === "github-public-metadata"
        ? `The imported public GitHub repository identifies “${claim.holderName}” as its owner namespace.`
        : claim.holderName
          ? `The submitting account declared “${claim.holderName}” as the associated account or organization.`
          : "No certificate holder or organization was declared for this record.",
    };
  }

  function pdfAscii(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "?")
      .replace(/([\\()])/g, "\\$1");
  }

  function wrapPlainText(value, maxLength = 76) {
    const words = String(value || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      if (!line) {
        line = word.slice(0, maxLength);
        let rest = word.slice(maxLength);
        while (rest) {
          lines.push(line);
          line = rest.slice(0, maxLength);
          rest = rest.slice(maxLength);
        }
      } else if (`${line} ${word}`.length <= maxLength) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word.slice(0, maxLength);
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function pdfObjects(objects) {
    const header = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xff, 0xff, 0xff, 0xff, 0x0a]);
    const parts = [header];
    const offsets = [0];
    let length = header.byteLength;
    objects.forEach((body, index) => {
      const prefix = utf8(`${index + 1} 0 obj\n`);
      const suffix = utf8("\nendobj\n");
      const bytes = body instanceof Uint8Array ? body : utf8(body);
      offsets.push(length);
      parts.push(prefix, bytes, suffix);
      length += prefix.byteLength + bytes.byteLength + suffix.byteLength;
    });
    const xrefOffset = length;
    const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
    for (let index = 1; index <= objects.length; index += 1) xref.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
    xref.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    parts.push(utf8(xref.join("")));
    return concatBytes(parts);
  }

  function jpegPdfBytes(jpegBytes, width, height) {
    const mediaWidth = 595.28;
    const mediaHeight = 841.89;
    const content = utf8(`q\n${mediaWidth} 0 0 ${mediaHeight} 0 0 cm\n/Im0 Do\nQ\n`);
    const image = concatBytes([
      utf8(`<< /Type /XObject /Subtype /Image /Width ${Math.max(1, Math.round(width))} /Height ${Math.max(1, Math.round(height))} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`),
      jpegBytes,
      utf8("\nendstream"),
    ]);
    return pdfObjects([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaWidth} ${mediaHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
      image,
      concatBytes([utf8(`<< /Length ${content.byteLength} >>\nstream\n`), content, utf8("endstream")]),
    ]);
  }

  function basicCertificatePdf(descriptor) {
    const navy = "0.047 0.165 0.341";
    const lines = [
      "ARIGHT EVIDENCE RECORD CERTIFICATE",
      `Certificate token: ${descriptor.token}`,
      `Work: ${descriptor.title}`,
      `${descriptor.signal.label}: ${descriptor.signal.percent == null ? "Not available" : `${descriptor.signal.percent}%`}`,
      descriptor.statement,
      `Record ID: ${descriptor.recordId}`,
      `Issued: ${formatUtcDate(descriptor.issuedAt)}`,
      `Original fingerprint: ${descriptor.fingerprint || "Not recorded"}`,
    ];
    const content = [
      `${navy} RG ${navy} rg`,
      "1.4 w 42 42 511 757 re S",
      "BT /F1 11 Tf 72 770 Td (ARIGHT) Tj ET",
      "BT /F1 23 Tf 72 725 Td (EVIDENCE RECORD CERTIFICATE) Tj ET",
      "0.6 w 72 705 m 523 705 l S",
    ];
    let y = 660;
    lines.slice(1).forEach((line, index) => {
      const wrapped = wrapPlainText(line, index === 1 || index === 3 ? 62 : 76);
      wrapped.forEach((part) => {
        content.push(`BT /F1 ${index === 0 ? 12 : 10} Tf 72 ${y} Td (${pdfAscii(part)}) Tj ET`);
        y -= index === 0 ? 22 : 16;
      });
      y -= 10;
    });
    content.push(
      "1.8 w 420 190 72 0 360 arc S",
      "1 w 420 190 62 0 360 arc S",
      "BT /F2 28 Tf 378 184 Td (Aright) Tj ET",
      "BT /F1 9 Tf 377 99 Td (Visual platform seal) Tj ET",
      "0.6 w 72 82 m 523 82 l S",
      "BT /F1 8 Tf 72 62 Td (Platform-generated evidence record; does not establish authorship or ownership.) Tj ET",
    );
    // Replace the unsupported arc operators with Bezier circles in the fallback PDF.
    const streamText = content.join("\n").replace(
      "1.8 w 420 190 72 0 360 arc S\n1 w 420 190 62 0 360 arc S",
      "1.8 w 492 190 m 492 229.8 459.8 262 420 262 c 380.2 262 348 229.8 348 190 c 348 150.2 380.2 118 420 118 c 459.8 118 492 150.2 492 190 c S\n1 w 482 190 m 482 224.2 454.2 252 420 252 c 385.8 252 358 224.2 358 190 c 358 155.8 385.8 128 420 128 c 454.2 128 482 155.8 482 190 c S",
    );
    const stream = utf8(`${streamText}\n`);
    return pdfObjects([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>",
      concatBytes([utf8(`<< /Length ${stream.byteLength} >>\nstream\n`), stream, utf8("endstream")]),
    ]);
  }

  function canvasTextLines(context, value, maxWidth) {
    const words = String(value || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      if (!line && context.measureText(word).width > maxWidth) {
        let segment = "";
        for (const character of word) {
          if (context.measureText(segment + character).width > maxWidth && segment) {
            lines.push(segment);
            segment = character;
          } else segment += character;
        }
        line = segment;
      } else if (!line || context.measureText(`${line} ${word}`).width <= maxWidth) {
        line = line ? `${line} ${word}` : word;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawCanvasParagraph(context, value, x, y, maxWidth, lineHeight, maxLines = 8) {
    const lines = canvasTextLines(context, value, maxWidth).slice(0, maxLines);
    lines.forEach((line, index) => context.fillText(line, x, y + (index * lineHeight)));
    return y + (lines.length * lineHeight);
  }

  function loadCertificateSeal() {
    return new Promise((resolve, reject) => {
      const image = global.document.createElement("img");
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("The certificate seal asset could not be loaded."));
      image.src = new URL(CERTIFICATE_SEAL_PATH, global.document.baseURI).href;
    });
  }

  async function canvasCertificatePdf(descriptor) {
    const canvas = global.document.createElement("canvas");
    canvas.width = 1240;
    canvas.height = 1754;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Certificate rendering is unavailable.");
    const navy = "#0c2a57";
    const ink = "#202630";
    const muted = "#66707b";
    context.fillStyle = "#fbfaf7";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = navy;
    context.lineWidth = 5;
    context.strokeRect(55, 55, 1130, 1644);
    context.lineWidth = 1.5;
    context.strokeRect(72, 72, 1096, 1610);

    context.fillStyle = navy;
    context.font = "700 25px 'Segoe UI', Arial, sans-serif";
    context.letterSpacing = "4px";
    context.fillText("ARIGHT", 115, 135);
    context.letterSpacing = "0px";
    context.font = "700 49px Georgia, 'Times New Roman', serif";
    context.fillText("Evidence Record Certificate", 115, 222);
    context.fillStyle = muted;
    context.font = "400 20px 'Segoe UI', Arial, sans-serif";
    context.fillText("A platform-generated record bound to the analysis and evidence package", 117, 266);
    context.strokeStyle = "#cbd2d9";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(115, 302);
    context.lineTo(1125, 302);
    context.stroke();

    context.fillStyle = "#f2f5f7";
    context.strokeStyle = "#d4dce3";
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(115, 350, 1010, 585, 18);
    context.fill();
    context.stroke();

    context.fillStyle = muted;
    context.font = "700 17px 'Segoe UI', Arial, sans-serif";
    context.fillText("CERTIFICATE TOKEN", 155, 405);
    context.fillStyle = navy;
    context.font = "700 25px ui-monospace, SFMono-Regular, Consolas, monospace";
    context.fillText(descriptor.token, 155, 447);

    context.fillStyle = muted;
    context.font = "700 17px 'Segoe UI', Arial, sans-serif";
    context.fillText("WORK", 155, 510);
    context.fillStyle = ink;
    context.font = "650 31px 'Segoe UI', Arial, sans-serif";
    let nextY = drawCanvasParagraph(context, descriptor.title, 155, 554, 920, 40, 3) + 22;

    context.fillStyle = ink;
    context.font = "400 22px 'Segoe UI', Arial, sans-serif";
    nextY = drawCanvasParagraph(
      context,
      `Aright confirms that evidence certificate token ${descriptor.token} was generated for this work.`,
      155,
      nextY,
      920,
      31,
      4,
    ) + 18;
    nextY = drawCanvasParagraph(context, descriptor.statement, 155, nextY, 920, 31, 4) + 18;
    context.font = "600 22px 'Segoe UI', Arial, sans-serif";
    drawCanvasParagraph(
      context,
      `${descriptor.signal.label}: ${descriptor.signal.percent == null ? "Not available" : `${descriptor.signal.percent}%`}`,
      155,
      nextY,
      920,
      31,
      3,
    );

    const detailY = 1005;
    const detailRows = [
      ["Record ID", descriptor.recordId],
      ["Issued", formatUtcDate(descriptor.issuedAt)],
      ["Analyzed", formatUtcDate(descriptor.analyzedAt)],
      ["Holder status", descriptor.claim.holderName ? "User-declared" : "Not provided"],
      ["Original SHA-256", descriptor.fingerprint || "Not recorded"],
    ];
    detailRows.forEach(([label, value], index) => {
      const y = detailY + (index * 58);
      context.fillStyle = muted;
      context.font = "700 16px 'Segoe UI', Arial, sans-serif";
      context.fillText(label.toUpperCase(), 135, y);
      context.fillStyle = ink;
      if (index === 4) {
        const fingerprint = String(value).slice(0, 64);
        context.font = "400 15px ui-monospace, SFMono-Regular, Consolas, monospace";
        context.fillText(fingerprint.slice(0, 32), 365, y);
        if (fingerprint.length > 32) context.fillText(fingerprint.slice(32), 365, y + 23);
      } else {
        context.font = "500 20px 'Segoe UI', Arial, sans-serif";
        context.fillText(String(value).slice(0, 95), 365, y);
      }
    });

    let seal = null;
    try {
      seal = await loadCertificateSeal();
    } catch {
      seal = null;
    }
    if (seal) {
      context.drawImage(seal, 790, 1190, 300, 300);
    } else {
      context.strokeStyle = navy;
      context.lineWidth = 8;
      context.beginPath();
      context.arc(940, 1340, 138, 0, Math.PI * 2);
      context.stroke();
      context.lineWidth = 3;
      context.beginPath();
      context.arc(940, 1340, 120, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = navy;
      context.font = "italic 52px Georgia, serif";
      context.fillText("Aright", 858, 1355);
    }
    context.fillStyle = navy;
    context.font = "650 18px 'Segoe UI', Arial, sans-serif";
    context.textAlign = "center";
    context.fillText("Visual platform seal", 940, 1520);
    context.textAlign = "left";

    context.strokeStyle = "#cbd2d9";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(115, 1575);
    context.lineTo(1125, 1575);
    context.stroke();
    context.fillStyle = muted;
    context.font = "400 17px 'Segoe UI', Arial, sans-serif";
    drawCanvasParagraph(
      context,
      "Platform-generated evidence record; does not establish authorship or ownership.",
      115,
      1618,
      1010,
      25,
      2,
    );
    context.font = "400 15px 'Segoe UI', Arial, sans-serif";
    context.fillText("Verify the certificate hash and token in verification.json inside the same evidence package.", 115, 1662);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("The certificate PDF image could not be encoded.")), "image/jpeg", 0.94);
    });
    return jpegPdfBytes(new Uint8Array(await blob.arrayBuffer()), canvas.width, canvas.height);
  }

  async function certificatePdfBytes(descriptor, options = {}) {
    if (options.certificatePdfBytes) return toBytes(options.certificatePdfBytes);
    if (typeof options.certificateRenderer === "function") return toBytes(await options.certificateRenderer(descriptor));
    if (global.document?.createElement) {
      try {
        return await canvasCertificatePdf(descriptor);
      } catch {
        // The dependency-free fallback remains a valid, readable certificate.
      }
    }
    return basicCertificatePdf(descriptor);
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
        scoreSemantics: record.type === "code"
          ? record.detection?.semantics || "URL-seeded illustrative estimate; not forensic model attribution"
          : "screening-model score; not a calibrated authorship probability",
        verdict: record.detection?.verdict || null,
      },
      certificateClaim: normalizedCertificateClaim(record),
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

  function reportHtml(record, evidenceRecord, packageAttachments, exportedAt, certificate) {
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
  <h2>Record</h2><dl class="meta"><dt>Record ID</dt><dd>${escapeHtml(record.id)}</dd><dt>Certificate token</dt><dd><code>${escapeHtml(certificate.token)}</code></dd><dt>Certificate holder</dt><dd>${escapeHtml(certificate.claim.holderName || "Not provided")} · ${escapeHtml(certificate.claim.holderStatus)}</dd><dt>Type</dt><dd>${escapeHtml(record.type)}</dd><dt>Analyzed</dt><dd>${escapeHtml(formatDate(record.createdAt))}</dd><dt>Detector signal</dt><dd>${score == null ? "Not available" : `${escapeHtml(score)}%`}</dd><dt>Original fingerprint</dt><dd><code>${escapeHtml(record.fingerprint || "Not computed")}</code></dd>${evidenceRecord.previousReviewCompletedAt ? `<dt>Earlier workflow review</dt><dd>${escapeHtml(formatDate(evidenceRecord.previousReviewCompletedAt))} · reconfirmation required</dd>` : ""}</dl>
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
    const usedPaths = new Set(["manifest.json", "report.html", CERTIFICATE_PATH, "hashes.sha256", "verification.json"]);
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

    const certificate = await certificateDescriptor(record, evidenceRecord, exportedAt);
    const certificateBytes = await certificatePdfBytes(certificate, options);
    const certificateSha256 = await sha256(certificateBytes);
    const certificateManifest = {
      ...certificate,
      path: CERTIFICATE_PATH,
      sha256: certificateSha256,
      visualSeal: true,
      visualSealLabel: "Visual platform seal",
      holderVerification: certificate.claim.holderStatus,
      digitalSignature: false,
      qualifiedElectronicSignature: false,
      qualifiedElectronicSeal: false,
      trustedTimestamp: false,
    };
    const manifest = {
      format: "aright-evidence-package/2",
      exportedAt,
      record: evidenceRecord,
      certificate: certificateManifest,
      package: {
        attachmentBytesIncluded: true,
        attachmentStorageSource: "browser-indexeddb",
        attachments: packageAttachments,
        limitation: "This is a browser-built evidence bundle with a local verification fingerprint. It is not a digital signature, trusted timestamp, or tamper-evident legal record.",
      },
    };
    const manifestBytes = utf8(`${JSON.stringify(manifest, null, 2)}\n`);
    const htmlBytes = utf8(reportHtml(record, evidenceRecord, packageAttachments, exportedAt, certificate));
    const hashedEntries = [
      { name: "manifest.json", data: manifestBytes },
      { name: "report.html", data: htmlBytes },
      { name: CERTIFICATE_PATH, data: certificateBytes },
      ...attachmentEntries,
    ];
    const hashes = [];
    for (const entry of hashedEntries) hashes.push(`${await sha256(entry.data)}  ${entry.name}`);
    const hashesBytes = utf8(`${hashes.join("\n")}\n`);
    const fingerprint = await sha256(hashesBytes);
    const problems = packageAttachments.filter((item) => !["included-and-matched", "included-unverified"].includes(item.packageStatus));
    const verification = {
      format: "aright-local-verification/2",
      packageId: `ARPK-${fingerprint.slice(0, 24).toUpperCase()}`,
      verificationFingerprint: `sha256:${fingerprint}`,
      fingerprintTarget: "hashes.sha256",
      algorithm: "SHA-256",
      status: problems.length ? "attention-required" : "package-complete",
      digitalSignature: false,
      qualifiedElectronicSignature: false,
      qualifiedElectronicSeal: false,
      trustedTimestamp: false,
      certificate: {
        token: certificate.token,
        path: CERTIFICATE_PATH,
        sha256: certificateSha256,
        holderVerification: certificate.claim.holderStatus,
        sealType: "visual-platform-seal",
        pdfCryptographicallySigned: false,
      },
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
    if (!report.querySelector('[data-report-export="package"]')) actions.append(exportButton("package", "Download evidence package"));
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
    const holderInput = global.document.querySelector("#report [data-certificate-holder]");
    if (holderInput && !String(holderInput.value || "").trim()) {
      holderInput.setAttribute("aria-invalid", "true");
      const status = holderInput.closest(".review-certificate-claim")?.querySelector("[data-certificate-claim-status]");
      if (status) status.textContent = "Enter a full name or organization before downloading certificate.pdf.";
      holderInput.focus({ preventScroll: true });
      holderInput.scrollIntoView({ behavior: "smooth", block: "center" });
      announce("Enter the certificate holder's full name or organization before downloading the evidence package.");
      return;
    }
    holderInput?.removeAttribute("aria-invalid");
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
    certificateDescriptor,
    certificatePdfBytes,
    crc32,
    downloadZip,
    jpegPdfBytes,
    safePathPart,
    sha256,
  });

  if (global.document) installBrowserIntegration();
})(globalThis);
