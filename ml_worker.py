"""Persistent, keyless ML worker used by server.js.

The worker speaks newline-delimited JSON over stdin/stdout. Model logs go to
stderr so stdout remains a machine-readable protocol. Models are loaded lazily
and stay in memory between requests.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import math
import os
import re
import sys
import time
import unicodedata
from html import unescape
from pathlib import Path
from typing import Any

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

ROOT = Path(__file__).resolve().parent

TEXT_MODEL_ID = "fakespot-ai/roberta-base-ai-text-detection-v1"
TEXT_MODEL_REV = "f9cdb14d1f8b105f597d80fa7b56f20c6ea0e9db"
TEXT_MODEL_SHA256 = "adc87ded15a8fbea26dec51a747adfd59ad1e9021073287e7e5e29209564e56c"
IMAGE_MODEL_ID = "OwensLab/commfor-model-384"
IMAGE_MODEL_REV = "6076002bf0d9dd37537f965ee2f06f826c333b61"
IMAGE_MODEL_SHA256 = "b89f36275f3bf5e2b040eee36597a8f19db051bff9a473a9cf7b2466284fb387"
AUDIO_MODEL_ID = "Limitless-8/spectra-aasist3-int8-audio-deepfake"
AUDIO_MODEL_REV = "b56aed04853cb4e5bf825025c54c93d4bc345c61"
AUDIO_MODEL_SHA256 = "444f832d306a2be4f823119f84e698e8821db6a1aab248593d4b05b7a9a48108"
AUDIO_MODEL_FILE = "spectra-aasist3-int8-dynamic.onnx"
AUDIO_SAMPLES = 64_600
AUDIO_RATE = 16_000
AUDIO_THRESHOLD = 0.939693808555603

_text_model = None
_text_tokenizer = None
_image_model = None
_image_transform = None
_audio_session = None
_preflight = None


def log(message: str) -> None:
    print(f"[ml] {message}", file=sys.stderr, flush=True)


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decode_payload(payload: dict[str, Any]) -> bytes:
    encoded = payload.get("data")
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("The uploaded file is empty.")
    try:
        return base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise ValueError("The uploaded file could not be decoded.") from exc


def preflight() -> dict[str, Any]:
    global _preflight
    if _preflight is not None:
        return _preflight

    required_modules = [
        "torch",
        "torchvision",
        "timm",
        "transformers",
        "safetensors",
        "huggingface_hub",
        "onnxruntime",
        "PIL",
        "numpy",
        "pypdf",
        "docx",
    ]
    errors = [f"Missing Python module: {name}" for name in required_modules if importlib.util.find_spec(name) is None]
    artifacts = {}
    if not errors:
        from huggingface_hub import try_to_load_from_cache

        checks = [
            ("text", TEXT_MODEL_ID, TEXT_MODEL_REV, "model.safetensors", TEXT_MODEL_SHA256),
            ("image", IMAGE_MODEL_ID, IMAGE_MODEL_REV, "model.safetensors", IMAGE_MODEL_SHA256),
            ("audio", AUDIO_MODEL_ID, AUDIO_MODEL_REV, AUDIO_MODEL_FILE, AUDIO_MODEL_SHA256),
        ]
        for kind, repo, revision, filename, expected_hash in checks:
            cached = try_to_load_from_cache(repo, filename, revision=revision)
            if not isinstance(cached, str) or not Path(cached).is_file():
                errors.append(f"{kind.capitalize()} model is not cached at the pinned revision.")
                artifacts[kind] = {"cached": False, "sha256Verified": False}
                continue
            actual_hash = sha256_file(cached)
            verified = actual_hash == expected_hash
            if not verified:
                errors.append(f"{kind.capitalize()} model hash mismatch: {actual_hash}")
            artifacts[kind] = {
                "cached": True,
                "bytes": Path(cached).stat().st_size,
                "sha256": actual_hash,
                "sha256Verified": verified,
            }

    _preflight = {"ready": not errors, "errors": errors, "artifacts": artifacts}
    return _preflight


def clean_text(text: str) -> str:
    """Fakespot's published markdown cleaner, kept behavior-compatible."""
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]*`", "", text)
    text = re.sub(r"!\[.*?\]\(.*?\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\(.*?\)", r"\1", text)
    text = re.sub(r"(\*\*|__)(.*?)\1", r"\2", text)
    text = re.sub(r"(\*|_)(.*?)\1", r"\2", text)
    text = re.sub(r"#+ ", "", text)
    text = re.sub(r"^>.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^(\s*[-*+]|\d+\.)\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*_]{3,}\s*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\|.*?\|", "", text)
    text = re.sub(r"<.*?>", "", text)
    text = unescape(text)
    text = text.replace("\n", " ").replace("\t", " ").replace("^M", " ").replace("\r", " ")
    return re.sub(r" +", " ", text.replace(" ,", ",")).strip()


def load_text_model():
    global _text_model, _text_tokenizer
    if _text_model is not None:
        return _text_model, _text_tokenizer
    started = time.perf_counter()
    import torch
    from huggingface_hub import hf_hub_download
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
    log(f"loading {TEXT_MODEL_ID}@{TEXT_MODEL_REV[:12]}")
    checkpoint = hf_hub_download(TEXT_MODEL_ID, "model.safetensors", revision=TEXT_MODEL_REV)
    actual_hash = sha256_file(checkpoint)
    if actual_hash != TEXT_MODEL_SHA256:
        raise RuntimeError(f"Text model hash mismatch: {actual_hash}")
    _text_tokenizer = AutoTokenizer.from_pretrained(TEXT_MODEL_ID, revision=TEXT_MODEL_REV)
    _text_model = AutoModelForSequenceClassification.from_pretrained(
        TEXT_MODEL_ID,
        revision=TEXT_MODEL_REV,
        use_safetensors=True,
    ).to("cpu").eval()
    log(f"text model ready in {time.perf_counter() - started:.2f}s")
    return _text_model, _text_tokenizer


def word_windows(text: str, size: int = 320, step: int = 260, limit: int = 16):
    matches = list(re.finditer(r"\S+", text))
    if not matches:
        return []
    if len(matches) <= size:
        return [(0, len(text), text, len(matches))]
    windows = []
    for first in range(0, len(matches), step):
        last = min(len(matches), first + size)
        start = matches[first].start()
        end = matches[last - 1].end()
        windows.append((start, end, text[start:end], last - first))
        if last == len(matches) or len(windows) >= limit:
            break
    return windows


def analyze_text(text: str) -> dict[str, Any]:
    import torch

    original = str(text or "").strip()
    normalized = clean_text(original)
    if len(normalized) < 80:
        raise ValueError("Add at least 80 characters. Short text is not reliable enough for this model.")
    letters = [character for character in normalized if character.isalpha()]
    latin_letters = sum("LATIN" in unicodedata.name(character, "") for character in letters)
    if letters and latin_letters / len(letters) < 0.75:
        raise ValueError("This text detector supports English only. Use English text or connect a detector validated for this language.")

    model, tokenizer = load_text_model()
    windows = word_windows(normalized)
    started = time.perf_counter()
    encoded = tokenizer(
        [item[2] for item in windows],
        return_tensors="pt",
        padding=True,
        truncation=True,
        max_length=512,
    )
    with torch.inference_mode():
        logits = model(**encoded).logits
        probabilities = torch.softmax(logits, dim=-1)[:, 1].cpu().tolist()

    ranked = []
    for (start, end, passage, word_count), score in zip(windows, probabilities):
        ranked.append({
            "start": start,
            "end": end,
            "score": round(float(score), 6),
            "words": word_count,
            "text": passage[:900],
        })
    sorted_scores = sorted(probabilities)
    mid = len(sorted_scores) // 2
    aggregate = (
        sorted_scores[mid]
        if len(sorted_scores) % 2
        else (sorted_scores[mid - 1] + sorted_scores[mid]) / 2
    )
    flagged = [item for item in ranked if item["score"] >= 0.75]
    verdict = "inconclusive"
    if aggregate >= 0.75:
        verdict = "likely_ai"
    elif aggregate <= 0.25:
        verdict = "likely_human"

    feedback = {
        "likely_ai": "High AI-class model signal. Review the scored passages and preserve the human editing trail.",
        "likely_human": "Low AI-class model signal. This does not prove human authorship; keep source and edit evidence.",
        "inconclusive": "The model is inconclusive. Treat provenance and human review as the stronger evidence.",
    }[verdict]
    return {
        "fakePercentage": round(aggregate * 100, 2),
        "label": verdict,
        "feedback": feedback,
        "h": [item["text"] for item in flagged[:6]],
        "textWords": len(re.findall(r"\S+", normalized)),
        "aiWords": sum(item["words"] for item in flagged),
        "input_text": original,
        "segments": ranked,
        "model": {
            "id": TEXT_MODEL_ID,
            "revision": TEXT_MODEL_REV,
            "sha256": TEXT_MODEL_SHA256,
            "license": "Apache-2.0",
            "language": "English",
            "aggregation": f"median of {len(ranked)} model-scored word window(s)",
            "scoreSemantics": "AI-class confidence signal, not the percentage of words written by AI",
        },
        "latencyMs": round((time.perf_counter() - started) * 1000, 1),
    }


def load_image_model():
    global _image_model, _image_transform
    if _image_model is not None:
        return _image_model, _image_transform
    started = time.perf_counter()
    import timm
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file
    from torchvision import transforms

    log(f"loading {IMAGE_MODEL_ID}@{IMAGE_MODEL_REV[:12]}")
    checkpoint = hf_hub_download(IMAGE_MODEL_ID, "model.safetensors", revision=IMAGE_MODEL_REV)
    actual_hash = sha256_file(checkpoint)
    if actual_hash != IMAGE_MODEL_SHA256:
        raise RuntimeError(f"Image model hash mismatch: {actual_hash}")
    model = timm.create_model(
        "vit_small_patch16_384.augreg_in21k_ft_in1k",
        pretrained=False,
        num_classes=1,
    )
    state = load_file(checkpoint)
    model.load_state_dict({key.removeprefix("vit."): value for key, value in state.items()}, strict=True)
    _image_model = model.to("cpu").eval()
    _image_transform = transforms.Compose([
        transforms.Resize(440),
        transforms.CenterCrop(384),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    log(f"image model ready in {time.perf_counter() - started:.2f}s")
    return _image_model, _image_transform


def analyze_image(data: bytes) -> dict[str, Any]:
    import torch
    from PIL import Image, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = 50_000_000
    try:
        image = Image.open(io.BytesIO(data)).convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("The image could not be decoded. Use JPG, PNG or WEBP.") from exc
    width, height = image.size
    if width < 128 or height < 128:
        raise ValueError("Use an image at least 128 × 128 pixels; smaller images carry too little evidence.")
    model, transform = load_image_model()
    started = time.perf_counter()
    tensor = transform(image).unsqueeze(0)
    with torch.inference_mode():
        score = float(torch.sigmoid(model(tensor)).item())
    verdict = "inconclusive"
    if score >= 0.75:
        verdict = "likely_ai"
    elif score <= 0.25:
        verdict = "likely_human"
    label = {
        "likely_ai": "AI-image signal detected",
        "likely_human": "No strong AI-image signal detected",
        "inconclusive": "Inconclusive image signal",
    }[verdict]
    return {
        "ai_score": round(score, 6),
        "label": label,
        "verdict": verdict,
        "dimensions": {"width": width, "height": height},
        "model": {
            "id": IMAGE_MODEL_ID,
            "revision": IMAGE_MODEL_REV,
            "sha256": IMAGE_MODEL_SHA256,
            "license": "MIT",
            "benchmark": {"mAP": 0.987, "mAcc": 0.893},
            "scoreSemantics": "synthetic-image model score, not forensic proof",
        },
        "latencyMs": round((time.perf_counter() - started) * 1000, 1),
    }


def load_audio_session():
    global _audio_session
    if _audio_session is not None:
        return _audio_session
    started = time.perf_counter()
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download

    log(f"loading {AUDIO_MODEL_ID}@{AUDIO_MODEL_REV[:12]}")
    model_path = hf_hub_download(AUDIO_MODEL_ID, AUDIO_MODEL_FILE, revision=AUDIO_MODEL_REV)
    actual_hash = sha256_file(model_path)
    if actual_hash != AUDIO_MODEL_SHA256:
        raise RuntimeError(f"Audio model hash mismatch: {actual_hash}")
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
    options.inter_op_num_threads = 1
    _audio_session = ort.InferenceSession(
        model_path,
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    log(f"audio model ready in {time.perf_counter() - started:.2f}s")
    return _audio_session


def softmax_pair(values):
    high = float(max(values))
    a = math.exp(float(values[0]) - high)
    b = math.exp(float(values[1]) - high)
    total = a + b
    return a / total, b / total


def analyze_audio(raw: bytes, sample_rate: int) -> dict[str, Any]:
    import numpy as np

    if sample_rate != AUDIO_RATE:
        raise ValueError("Audio PCM must be resampled to 16 kHz before analysis.")
    if len(raw) % 4:
        raise ValueError("Audio PCM payload is malformed.")
    waveform = np.frombuffer(raw, dtype="<f4").astype(np.float32, copy=True)
    if waveform.size < AUDIO_RATE:
        raise ValueError("Use at least 1 second of audible speech. Very short clips are not reliable enough for this model.")
    if waveform.size > AUDIO_RATE * 60:
        waveform = waveform[: AUDIO_RATE * 60]
    waveform = np.nan_to_num(waveform, copy=False)
    np.clip(waveform, -1.0, 1.0, out=waveform)
    rms = float(np.sqrt(np.mean(waveform.astype(np.float64) ** 2)))
    if not math.isfinite(rms) or rms < 0.003:
        raise ValueError("No audible speech was detected. Use a clear voice recording rather than silence or near-silence.")
    emphasized = np.empty_like(waveform)
    emphasized[0] = waveform[0]
    emphasized[1:] = waveform[1:] - np.float32(0.97) * waveform[:-1]

    if emphasized.size < AUDIO_SAMPLES:
        repeats = int(math.ceil(AUDIO_SAMPLES / emphasized.size))
        windows = np.tile(emphasized, repeats)[:AUDIO_SAMPLES][None, :]
        starts = [0]
        short_clip_repeated = True
    else:
        starts = list(range(0, emphasized.size - AUDIO_SAMPLES + 1, AUDIO_SAMPLES))
        tail = emphasized.size - AUDIO_SAMPLES
        if starts[-1] != tail:
            starts.append(tail)
        windows = np.stack([emphasized[start : start + AUDIO_SAMPLES] for start in starts])
        short_clip_repeated = False
    windows = windows.astype(np.float32, copy=False)

    session = load_audio_session()
    started = time.perf_counter()
    logits = session.run(["logits"], {"wav": windows})[0]
    segments = []
    for start, pair in zip(starts, logits):
        spoof, bonafide = softmax_pair(pair)
        segments.append({
            "start": round(start / AUDIO_RATE, 3),
            "end": round(min(waveform.size, start + AUDIO_SAMPLES) / AUDIO_RATE, 3),
            "score": round(spoof, 6),
            "bonafideScore": round(bonafide, 6),
        })
    score = max(item["score"] for item in segments)
    above_threshold = sum(item["score"] >= AUDIO_THRESHOLD for item in segments)
    near_threshold = sum(item["score"] >= AUDIO_THRESHOLD - 0.05 for item in segments)
    if above_threshold >= (1 if len(segments) == 1 else 2):
        verdict = "likely_ai"
        label = "Synthetic or cloned-speech signal detected"
    elif above_threshold or near_threshold:
        verdict = "inconclusive"
        label = "Inconclusive speech signal"
    else:
        verdict = "likely_human"
        label = "No strong synthetic-speech signal detected"
    return {
        "ai_score": round(score, 6),
        "label": label,
        "verdict": verdict,
        "segments": segments,
        "duration": round(waveform.size / AUDIO_RATE, 3),
        "inputChecks": {
            "rms": round(rms, 6),
            "shortClipRepeatedToModelWindow": short_clip_repeated,
            "speechPresence": "audibility/RMS gate only; speech content is not independently verified",
        },
        "model": {
            "id": AUDIO_MODEL_ID,
            "revision": AUDIO_MODEL_REV,
            "sha256": AUDIO_MODEL_SHA256,
            "artifactLicense": "Apache-2.0",
            "upstreamSourceLicense": "CC-BY-NC-ND-4.0",
            "commercialRedistribution": "requires human model-provenance and license review",
            "integrationStatus": "research/prototype",
            "threshold": AUDIO_THRESHOLD,
            "aggregation": "maximum spoof score across consecutive 4.04-second windows covering the first 60 seconds, with a tail-anchored final window",
            "clipPolicy": "one above-threshold window for a single-window clip; two for a multi-window clip; application-level policy not independently calibrated",
            "policyValidated": False,
            "scoreSemantics": "speech anti-spoofing model score, not a calibrated probability",
            "scope": "speech only; not an AI-music detector",
        },
        "latencyMs": round((time.perf_counter() - started) * 1000, 1),
    }


def extract_document(data: bytes, name: str) -> str:
    suffix = Path(name).suffix.lower()
    if suffix == ".txt":
        return data.decode("utf-8-sig", errors="strict")
    if suffix == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join((page.extract_text() or "") for page in reader.pages)
    if suffix == ".docx":
        from docx import Document

        document = Document(io.BytesIO(data))
        return "\n".join(paragraph.text for paragraph in document.paragraphs)
    raise ValueError("Use TXT, PDF or DOCX for document analysis.")


def status() -> dict[str, Any]:
    return {
        "worker": True,
        "preflight": preflight(),
        "models": {
            "text": {"id": TEXT_MODEL_ID, "revision": TEXT_MODEL_REV, "loaded": _text_model is not None},
            "image": {"id": IMAGE_MODEL_ID, "revision": IMAGE_MODEL_REV, "loaded": _image_model is not None},
            "video": {"id": IMAGE_MODEL_ID, "mode": "sampled frames", "loaded": _image_model is not None},
            "audio": {"id": AUDIO_MODEL_ID, "revision": AUDIO_MODEL_REV, "loaded": _audio_session is not None},
        },
    }


def handle(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    if kind == "status":
        return status()
    if kind == "text":
        return analyze_text(str(payload.get("text") or ""))
    if kind == "document":
        data = decode_payload(payload)
        text = extract_document(data, str(payload.get("name") or "document"))
        if not text.strip():
            raise ValueError("No extractable text was found in this document.")
        return analyze_text(text)
    if kind == "image":
        return analyze_image(decode_payload(payload))
    if kind == "audio":
        return analyze_audio(decode_payload(payload), int(payload.get("sampleRate") or 0))
    raise ValueError(f"Unknown detector kind: {kind}")


def main() -> None:
    if "--check" in sys.argv[1:]:
        result = preflight()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if not result["ready"]:
            raise SystemExit(1)
        return

    if "--preload" in sys.argv[1:]:
        log("preloading all detector models")
        load_text_model()
        load_image_model()
        load_audio_session()
        print(json.dumps(status(), ensure_ascii=False, indent=2))
        return

    log("worker ready; models load on first use")
    for line in sys.stdin.buffer:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            result = handle(str(request.get("kind") or ""), request.get("payload") or {})
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as exc:
            log(f"request failed: {type(exc).__name__}: {exc}")
            response = {
                "id": request_id,
                "ok": False,
                "error": str(exc) or type(exc).__name__,
                "errorType": type(exc).__name__,
            }
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
