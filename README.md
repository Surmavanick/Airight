# Aright

Marketing website plus the Aright Console for real AI-content screening, IPR readiness, action plans, and evidence records. The workflow follows `Airight.pdf`: analysis and scoring → action plan → review and evidence. It has two runtimes: an AI or Not–backed Vercel deployment and a local launcher with pinned open models.

Resuming this project from another computer? Start with [`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md).

## Hosted console on Vercel

The production deployment is a static site plus zero-dependency Node functions in `api/`. Set these encrypted project environment variables in Vercel before deploying:

- `AIORNOT_API_KEY`: AI or Not server credential; never expose it to browser code.
- `ADMIN_PASSWORD`: a strong console access key. Hosted detector calls deliberately stay disabled if this is missing.
- `AIORNOT_AUDIO_ENABLED` (optional): defaults to `false`. Set it to `true` only if the AI or Not account plan has the `ai_voice` model enabled. It does not affect local Spectra-AASIST3.
- `AIORNOT_TIMEOUT_MS` (optional): provider timeout; defaults to 120000.

Deploy from the Vercel dashboard after importing this repository, or with the CLI:

```powershell
corepack pnpm dlx vercel link
corepack pnpm dlx vercel env add AIORNOT_API_KEY production --sensitive
corepack pnpm dlx vercel env add ADMIN_PASSWORD production --sensitive
corepack pnpm dlx vercel --prod
```

After the first deployment, add a Vercel Firewall rate-limit rule for `/api/detect/(.*)` (for example 12 requests per 60 seconds per source). The code also has a small in-process guard, but that guard is only best-effort because serverless instances scale independently. Keep AI or Not account spend alerts/limits enabled, and rotate any credential that has ever been shared outside the provider dashboard.

Vercel Functions have a hard 4.5 MB request/response limit, so Aright caps hosted raw uploads at 4 MiB. Images and TXT files use that cap. When explicitly enabled, audio is decoded in the browser and sent as at most 60 seconds of 16 kHz mono PCM, then converted to WAV in the function. The full video never leaves the browser: 3, 5, or 8 sampled JPEG frames are checked individually. PDF/DOCX extraction remains available in the local launcher; on the hosted console, paste their extracted text or upload TXT.

## Start the working console

Double-click `start-aright.cmd`.

On the first run it creates an isolated Python 3.12 environment in `.aright-venv`, installs pinned CPU dependencies, downloads the pinned detector checkpoints, verifies all three model hashes, starts the model service, and opens:

`http://127.0.0.1:8000/admin/`

Manual equivalent:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-models.ps1
node server.js
```

Node 18+ and Python 3.12 are required. The first setup downloads roughly 1 GB of model data into the normal Hugging Face cache. Model weights load lazily and remain in one persistent worker process while the server is running. To enable the external image check, copy `.env.example` to `.env`, set `AIORNOT_API_KEY`, and restart Aright.

Opening `admin/index.html` directly is supported only as a local-only UI fallback: real analysis still needs `node server.js`. When the paid AI or Not key is configured, `file://` API access is deliberately rejected; use the same-origin HTTP console to prevent opaque-origin pages from spending provider credits. The server intentionally returns no directory listing for `/admin/`. If `PORT` is changed, the launcher reads it from `.env`. The normal HTTP console discovers its own origin automatically.

## Real detector coverage

Hosted Vercel runtime:

- **Text:** AI or Not v2 text analysis with block annotations; provider limits are 250–500,000 characters and approximately 64 words minimum.
- **Images:** AI or Not v2 `ai_generated` report. ≤25% is a low-signal band, ≥75% a high-signal band, and the middle is inconclusive. The bands are Aright review policy, not proof.
- **Video:** browser-sampled frames sent to the same image endpoint. This is not full temporal/face-swap/audio analysis and uses one provider request per frame.
- **Audio:** disabled by default because AI or Not voice access depends on the account plan. Set `AIORNOT_AUDIO_ENABLED=true` only after `ai_voice` access is confirmed. Otherwise the UI directs users to the local Spectra-AASIST3 console. It does not detect AI music.

Local launcher runtime:

- **Text and documents:** pinned Fakespot/Mozilla ApolloDFT RoBERTa model. English only; PDF, DOCX, and TXT text is extracted server-side. Long documents are scored in windows.
- **Images:** when configured, AI or Not v2 is called with only the `ai_generated` report and its score is shown beside the pinned Community Forensics ViT-384 comparison. Scores are never averaged: both must enter the same ≤25%, 25–75%, or ≥75% policy band; otherwise the result is explicitly inconclusive. Without the API key, the self-hosted model remains available as a clearly labelled local-only path. The server defaults to 12 paid provider calls per minute and 2 concurrent calls; both guards can be tightened in `.env`.
- **Video:** the browser samples 3, 5, or 8 frames and sends each through the same image-provider comparison. This uses one AI or Not image request per frame and is frame-level screening, not temporal deepfake analysis.
- **Audio:** pinned Spectra-AASIST3 INT8 ONNX model screens consecutive 4.04-second windows covering the first 60 seconds for synthetic or cloned speech. Silence and sub-second clips are rejected. It does not detect AI music, and its multi-window clip policy is an explicitly uncalibrated Aright extension. An optional script is separately sent to the text model.

Every evidence export records the model ID, revision, raw model response, score semantics, SHA-256 asset fingerprint where available, and the action-plan state. See `THIRD_PARTY_NOTICES.md` for exact licenses, revisions, hashes, and the audio-model licensing caveat.

Detector scores are screening signals, not calibrated proof of authorship or infringement. The IPR score measures readiness for review based on model signals plus declared human work, provenance, and license clarity; it is not legal advice.

## Data and access

The local Node/Python service binds to `127.0.0.1`. Text, documents, and speech are processed by the self-hosted worker. When `AIORNOT_API_KEY` is configured, image bytes and sampled video frames are also sent to AI or Not for external inference. The hosted runtime sends text, images and sampled frames to AI or Not; it sends voice audio only when `AIORNOT_AUDIO_ENABLED=true`. The vendor states uploads are deleted after inference, but its privacy policy and account billing still apply. Aright does not save uploaded bytes server-side.

Reports and workflow state are stored in the browser's `localStorage`; download JSON evidence for a durable copy. That storage is unencrypted, per-browser, user-editable, and not a tamper-evident evidence vault or multi-user security boundary.

Copy `.env.example` to `.env` and set `ADMIN_PASSWORD` to gate the console UI and model requests on this computer. The UI fails closed until the service confirms access and hides/unloads report rows again if the service becomes unreachable. Browser `localStorage` itself is still not encrypted server storage or a multi-user security boundary; anyone with access to that browser profile can inspect it. Use an appropriate OS account/browser profile and do not expose this prototype directly to the public internet.

## Project structure

- `index.html`, `css/styles.css`, `js/main.js`: marketing website
- `admin/index.html`, `css/admin.css`, `js/admin.js`: console UI and evidence workflow
- `api/status.mjs`, `api/detect/[kind].mjs`, `lib/cloud-api.mjs`, `vercel.json`: hosted Vercel provider proxy
- `server.js`: zero-package Node static/API server and persistent worker manager
- `ml_worker.py`: pinned text, image, and speech model adapters
- `requirements-ml.txt`, `verify_environment.py`, `setup-models.ps1`, `start-aright.ps1`, `start-aright.cmd`: exact direct dependency checks, versioned setup fingerprint, verified model artifacts, health-checked one-command launch
- `THIRD_PARTY_NOTICES.md`: model provenance, revisions, hashes, licenses, and limitations
- `licenses/`, `assets/fonts/OFL-*.txt`: bundled upstream model and font license texts
- `Airight.pdf`: source product presentation

## Contact form

Set `CONTACT_EMAIL` near the top of `js/main.js` before publishing if requests should open a pre-addressed email draft.
