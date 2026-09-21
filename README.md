# Aright

Marketing website plus the Aright Console for real AI-content screening, IPR readiness, action plans, and evidence records. The workflow follows `Airight.pdf`: analysis and scoring → action plan → review and evidence. It has two runtimes: an AI or Not–backed Vercel deployment and a local launcher with pinned open models.

Resuming this project from another computer? Start with [`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md).

## Hosted console on Vercel

The production deployment is a static site plus zero-dependency Node functions in `api/`. Set these encrypted project environment variables in Vercel before deploying:

- `AIORNOT_API_KEY`: AI or Not server credential; never expose it to browser code.
- `AIORNOT_API_KEY_BACKUP` (optional): independently issued backup credential, used once only after primary HTTP 401, 402, or 403. It does not work without the primary and is not used after 429, timeout, network, 5xx, or invalid-input failures.
- `ADMIN_PASSWORD`: a strong console access key. Hosted detector calls deliberately stay disabled if this is missing.
- `AIORNOT_AUDIO_ENABLED` (optional): defaults to `false`. Set it to `true` only if the AI or Not account plan has the `ai_voice` model enabled. It does not affect local Spectra-AASIST3.
- `AIORNOT_TIMEOUT_MS` (optional): provider timeout; defaults to 120000.
- `GITHUB_API_TOKEN` (optional): server-only GitHub credential for higher public-repository API limits. The importer works without it, but GitHub's unauthenticated limit is 60 requests/hour per origin IP.

Deploy from the Vercel dashboard after importing this repository, or with the CLI:

```powershell
corepack pnpm dlx vercel link
corepack pnpm dlx vercel env add AIORNOT_API_KEY production --sensitive
corepack pnpm dlx vercel env add AIORNOT_API_KEY_BACKUP production --sensitive
corepack pnpm dlx vercel env add ADMIN_PASSWORD production --sensitive
corepack pnpm dlx vercel --prod
```

Vercel environment-variable changes apply only to new deployments; redeploy after adding or rotating either credential.

After the first deployment, add a Vercel Firewall rate-limit rule for `/api/detect/(.*)` (for example 12 requests per 60 seconds per source). The code also has a small in-process guard, but that guard is only best-effort because serverless instances scale independently. Keep AI or Not account spend alerts/limits enabled, and rotate any credential that has ever been shared outside the provider dashboard. Each detector call normally consumes one metered provider attempt. Eligible credential failover consumes one additional attempt, and the in-process guard counts attempts rather than analyses.

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

Node 18+ and Python 3.12 are required. The first setup downloads roughly 1 GB of model data into the normal Hugging Face cache. Model weights load lazily and remain in one persistent worker process while the server is running. To enable the external image check, copy `.env.example` to `.env`, set `AIORNOT_API_KEY`, optionally set the independently issued `AIORNOT_API_KEY_BACKUP`, and restart Aright.

Opening `admin/index.html` directly is supported only as a local-only UI fallback: real analysis still needs `node server.js`. When the paid AI or Not key is configured, `file://` API access is deliberately rejected; use the same-origin HTTP console to prevent opaque-origin pages from spending provider credits. The server intentionally returns no directory listing for `/admin/`. If `PORT` is changed, the launcher reads it from `.env`. The normal HTTP console discovers its own origin automatically.

## Real detector coverage

Hosted Vercel runtime:

- **Text:** AI or Not v2 text analysis with block annotations; provider limits are 250–500,000 characters and approximately 64 words minimum.
- **Images:** AI or Not v2 `ai_generated` report. ≤25% is a low-signal band, ≥75% a high-signal band, and the middle is inconclusive. The bands are Aright review policy, not proof.
- **Video:** browser-sampled frames sent to the same image endpoint. This is not full temporal/face-swap/audio analysis and normally uses one metered attempt per frame; an eligible credential failover can add one attempt for that frame.
- **Audio:** disabled by default because AI or Not voice access depends on the account plan. Set `AIORNOT_AUDIO_ENABLED=true` only after `ai_voice` access is confirmed. Otherwise the UI directs users to the local Spectra-AASIST3 console. It does not detect AI music.
- **Code:** imports a public GitHub repository tree and a bounded, non-executed source sample through GitHub's REST API. The report also maps the public repository profile, creation/push/latest-commit timeline, language mix, activity counts, top contributors and import coverage without storing source code or contributor email addresses. The ChatGPT/Codex/Claude/Copilot/Gemini/Human mix is a stable repository-ID-seeded illustration—not forensic code-authorship detection. Same repository, same result; a different repository gets a different deterministic mix.

Local launcher runtime:

- **Text and documents:** pinned Fakespot/Mozilla ApolloDFT RoBERTa model. English only; PDF, DOCX, and TXT text is extracted server-side. Long documents are scored in windows.
- **Images:** when configured, AI or Not v2 is called with only the `ai_generated` report and its score is shown beside the pinned Community Forensics ViT-384 comparison. Scores are never averaged: both must enter the same ≤25%, 25–75%, or ≥75% policy band; otherwise the result is explicitly inconclusive. Without the API key, the self-hosted model remains available as a clearly labelled local-only path. The server defaults to 12 outbound provider attempts per minute and 2 concurrent attempts; both guards can be tightened in `.env`.
- **Video:** the browser samples 3, 5, or 8 frames and sends each through the same image-provider comparison. This normally uses one AI or Not image attempt per frame; eligible credential failover can add one attempt for that frame. It is frame-level screening, not temporal deepfake analysis.
- **Audio:** pinned Spectra-AASIST3 INT8 ONNX model screens consecutive 4.04-second windows covering the first 60 seconds for synthetic or cloned speech. Silence and sub-second clips are rejected. It does not detect AI music, and its multi-window clip policy is an explicitly uncalibrated Aright extension. An optional script is separately sent to the text model.
- **Code:** uses the same safe public-GitHub importer as hosted mode. Source files are sampled only to estimate repository size/languages and are neither executed nor persisted. Configure `GITHUB_API_TOKEN` only if the public unauthenticated GitHub limit is too small.

Every modality also receives a separate **51% Human contribution plan**. For code, Aright calculates concrete substantive lines, core files and behavior tests to hand-write; text uses words, images use traceable edit categories, video uses screened shots, and audio uses recorded/edited seconds. This is a self-attested planning target and never changes the original detector signal or proves authorship.

Every evidence export records the model ID, revision, raw model response, score semantics, SHA-256 asset fingerprint where available, and the action-plan state. Each checklist task can also hold optional supporting files such as licences, approvals, source files, or before/after exports. File bytes stay in that browser's IndexedDB; `localStorage` and downloaded JSON retain only bounded metadata and SHA-256 fingerprints. Adding or removing a file never checks or unchecks the task. Hosted evidence also records the runtime credential slot, attempt count, failover flag, and normalized reason code; these are execution roles, never key material, prefixes, hashes, or provider credential bodies. See `THIRD_PARTY_NOTICES.md` for exact licenses, revisions, hashes, and the audio-model licensing caveat.

Detector scores are screening signals, not calibrated proof of authorship or infringement. The IPR score measures readiness for review based on model signals plus declared human work, provenance, and license clarity; it is not legal advice.

## Data and access

The local Node/Python service binds to `127.0.0.1`. Text, documents, and speech are processed by the self-hosted worker. When `AIORNOT_API_KEY` is configured, image bytes and sampled video frames are also sent to AI or Not for external inference; `AIORNOT_API_KEY_BACKUP` is optional and never enables the provider by itself. The hosted runtime sends text, images and sampled frames to AI or Not; it sends voice audio only when `AIORNOT_AUDIO_ENABLED=true`. The vendor states uploads are deleted after inference, but its privacy policy and account billing still apply. Aright does not save uploaded bytes server-side.

Reports and workflow state are stored in the browser's `localStorage`; optional supporting-file bytes are stored separately in IndexedDB and are not embedded in JSON exports. Download the JSON manifest and separately retain the original supporting files for a durable package. Browser storage is unencrypted, per-browser, user-editable, and not a tamper-evident evidence vault or multi-user security boundary.

Copy `.env.example` to `.env` and set `ADMIN_PASSWORD` to gate the console UI and model requests on this computer. The UI fails closed until the service confirms access and hides/unloads report rows again if the service becomes unreachable. Browser `localStorage` itself is still not encrypted server storage or a multi-user security boundary; anyone with access to that browser profile can inspect it. Use an appropriate OS account/browser profile and do not expose this prototype directly to the public internet.

## Project structure

- `index.html`, `css/styles.css`, `js/main.js`: marketing website
- `admin/index.html`, `css/admin.css`, `js/admin.js`: console UI and evidence workflow
- `api/status.mjs`, `api/detect/[kind].mjs`, `lib/cloud-api.mjs`, `vercel.json`: hosted Vercel provider proxy
- `lib/github-code.mjs`: validated public-GitHub importer and deterministic illustrative repository mix
- `server.js`: zero-package Node static/API server and persistent worker manager
- `ml_worker.py`: pinned text, image, and speech model adapters
- `requirements-ml.txt`, `verify_environment.py`, `setup-models.ps1`, `start-aright.ps1`, `start-aright.cmd`: exact direct dependency checks, versioned setup fingerprint, verified model artifacts, health-checked one-command launch
- `THIRD_PARTY_NOTICES.md`: model provenance, revisions, hashes, licenses, and limitations
- `licenses/`, `assets/fonts/OFL-*.txt`: bundled upstream model and font license texts
- `Airight.pdf`: source product presentation
- `tests/cloud-api.test.mjs`, `tests/github-code.test.mjs`: mocked hosted-provider, credential-failover and GitHub-import contract tests

## Contact form

Set `CONTACT_EMAIL` near the top of `js/main.js` before publishing if requests should open a pre-addressed email draft.
