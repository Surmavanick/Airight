# Airight — project handoff

Last updated: **2026-09-21**
Canonical branch: **`main`**  
Verified commit: run `git log -1 --oneline` after `git pull --ff-only`; this handoff is maintained with `main`.

ეს ფაილი არის მოკლე ანამნეზი სახლიდან ან სხვა კომპიუტერიდან სამუშაოს გასაგრძელებლად. ჯერ ეს წაიკითხე, შემდეგ გაუშვი `git status` და `git pull`.

## Links

- Production: <https://airight-blush.vercel.app/>
- Admin Console: <https://airight-blush.vercel.app/admin/#analyze>
- GitHub: <https://github.com/Surmavanick/Airight>
- Vercel project: **`airight`** in the linked Vercel team/account

## Current product state

Airight currently includes:

- a responsive legal/IP marketing website;
- a separate analysis console following the deck flow: **analysis & IPR score → action plan → review/evidence**;
- hosted AI or Not screening for text, images and browser-sampled video frames;
- local pinned models for text/documents, images and synthetic/cloned speech;
- deterministic IPR-readiness scoring, prioritized tasks, browser-local register and downloadable JSON evidence;
- password-gated hosted detector requests and server-side provider credentials;
- optional server-side AI or Not credential failover for provider HTTP 401/402/403 only, with no automatic retry for 429, timeout, network, 5xx, or invalid input;
- a full-width analysis composer with a populated desktop Evidence rail, spacious media/text inputs and a responsive mobile action flow;
- a continuous one-page report with sticky **Repository / Human plan / Evidence** section navigation, no nested report scroller, compact score summary and de-duplicated actions;
- public GitHub repository import for Code: real tree/source-sample coverage, repository profile, created/pushed/latest-commit timeline, languages, public activity and top contributors, plus a stable repository-ID-seeded ChatGPT/Codex/other/Human demo mix. It is explicitly illustrative, not forensic model attribution;
- a separate 51% Human contribution plan with concrete code lines/files/tests, text words, image edit categories, video shots or audio seconds. Completing the task never rewrites the original model signal.

Important product decision: detector scores and IPR readiness stay separate. A detector score is a review signal, never proof of authorship, infringement, ownership or legal protection.

## Resume from a home laptop

```powershell
git clone https://github.com/Surmavanick/Airight.git
cd Airight
git switch main
git pull --ff-only origin main
git status --short
```

Requirements for the full local console: **Node 18+**, **Python 3.12**, Windows PowerShell.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Fill `.env` locally if external detection is needed. Never commit `.env` or paste credentials into source files. Then double-click `start-aright.cmd`, or run:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-models.ps1
node server.js
```

Open <http://127.0.0.1:8000/admin/>. First setup downloads roughly 1 GB of pinned model artifacts.

For a terminal-only launch and health check:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-aright.ps1 -NoBrowser
Invoke-RestMethod http://127.0.0.1:8000/api/status
```

Do not use `file://` for real analysis. There is no root `package.json`, frontend build, or `npm install` step: the site is static HTML/CSS/JavaScript plus zero-dependency Node serverless functions.

To reconnect the clone to the existing Vercel project:

```powershell
corepack pnpm dlx vercel login
corepack pnpm dlx vercel link --project airight --yes
corepack pnpm dlx vercel env ls
corepack pnpm dlx vercel --prod --yes
```

Use the existing **`airight`** project. Production secrets already belong in Vercel Environment Variables; inspect them but do not overwrite them unless intentionally rotating a credential. Environment changes affect only new deployments, so redeploy after adding or rotating a credential. Choose one deployment path—GitHub integration or the CLI—so the same commit is not deployed twice.

## Secrets and data

- `AIORNOT_API_KEY`, optional `AIORNOT_API_KEY_BACKUP`, and `ADMIN_PASSWORD` must exist only in local `.env` and Vercel encrypted environment variables.
- `GITHUB_API_TOKEN` is optional and server-only. Public imports work without it at GitHub's lower unauthenticated rate; never paste a token into the browser or commit it.
- The backup is attempted once only after provider 401/402/403. It is not used for timeouts, network errors, rate limits, invalid input, or provider 5xx responses because the first attempt may already be billable.
- No credential value is recorded in this handoff or tracked source.
- Provider credentials and the current admin password were previously shared in chat. Treat every pasted credential as compromised: rotate it out-of-band, update local `.env` and the encrypted Vercel Production values, then redeploy. Never put replacement values in Git, this handoff, or chat.
- If the console password is unavailable on the home laptop, reset `ADMIN_PASSWORD` in Vercel rather than storing it in this file.
- Configure a Vercel WAF rate-limit rule for `/api/detect/*` and keep provider spend alerts/limits enabled. The in-code serverless limiter is only best-effort per instance and counts outbound attempts; credential failover can consume two attempts for one detector call.
- Reports currently live in each browser's `localStorage`. The home laptop will start with an empty register; office-browser records do **not** sync automatically. Download important JSON evidence from the original browser before leaving it.
- Browser records are editable and unsigned; this is not yet a secure, tamper-evident evidence vault.
- Before broader publication, confirm distribution rights/consent for `Airight.pdf`, founder portraits and other tracked photography, and strip unnecessary EXIF/location metadata.

## Hosted vs local coverage

| Modality | Hosted Vercel | Local launcher |
|---|---|---|
| Text | AI or Not v2 | Pinned ApolloDFT/RoBERTa |
| Image | AI or Not v2 | AI or Not + pinned Community Forensics, or local-only |
| Video | 3/5/8 sampled frames | 3/5/8 sampled frames |
| Audio | Disabled unless provider voice entitlement is explicitly enabled | Pinned Spectra-AASIST3 speech screening |
| PDF/DOCX | Paste extracted text or upload TXT | Server-side PDF/DOCX/TXT extraction |
| Code | Public GitHub tree + bounded source sample; deterministic demo mix | Same safe GitHub importer |

Video is frame-level screening, not full temporal deepfake detection. Audio screening is speech-only, not AI-music detection.

## Last verified QA

- Tracked API/import tests: **33/33 passed**, including primary/backup routing, fresh multipart bodies, no-retry failures, rate guards, secret redaction, GitHub URL/SSRF validation, shared import deadlines, secondary-limit handling, deterministic mixes and exact 51% line math.
- Admin responsive/browser regression: **11/11 passed**.
- Dedicated Code-import browser flow: **5/5 passed** at **1440×900, 1024×768, 390×844 and 320×700**, including reload, export, rescan, keyboard navigation, stable rerenders and no overflow.
- Real local end-to-end import of `Surmavanick/Airight` passed through GitHub's live REST API: 17 eligible files, 8 bounded samples, repository activity/contributor enrichment, stable 100% composition and no source-code persistence in the response.
- Report workflow passed at **1440×900, 1280×800, 1024×768, 390×844 and 320×700**.
- Tested: sticky section navigation and manual-scroll state, task rerenders/focus, Review completion/reopen, evidence download, second analysis, desktop Evidence fields, large media previews, mobile touch targets, no nested report scroll, no horizontal overflow, and no browser/page errors.
- Production deployment and the canonical alias must be smoke-tested after every provider/environment change without making an unnecessary paid detector request.
- The browser harness and screenshots currently live under ignored `tmp/`; they will not arrive in a fresh clone. The zero-dependency `tests/cloud-api.test.mjs` and `tests/github-code.test.mjs` suites are tracked.

Useful tracked check:

```powershell
node --check server.js
node --check js\admin.js
node --check lib\cloud-api.mjs
node --check lib\github-code.mjs
node --test tests\cloud-api.test.mjs tests\github-code.test.mjs
git diff --check
```

## Important files

- `README.md` — complete setup, architecture and limitations
- `index.html`, `css/styles.css`, `js/main.js` — marketing site
- `admin/index.html`, `css/admin.css`, `js/admin.js` — console UI/workflow
- `api/`, `lib/cloud-api.mjs`, `lib/github-code.mjs`, `vercel.json` — hosted serverless API and safe GitHub importer
- `server.js`, `ml_worker.py` — local API and model worker
- `Airight.pdf` — product source deck
- `THIRD_PARTY_NOTICES.md`, `licenses/` — exact model provenance/licensing

## Recommended next work

1. Replace the shared admin password and browser-only storage with real user authentication, a database and object storage.
2. Add server-side, append-only evidence records, signed/canonical report hashes and trusted timestamps before claiming a secure evidence vault.
3. Add Vercel WAF/global quota controls and rotate the exposed provider key.
4. Decide on a commercially cleared hosted audio detector or keep Audio explicitly local-only.
5. Add team/workspace roles, audit logs and cross-device record sync.
6. Promote the local Playwright/browser regression into tracked `tests/` and run it in CI.
7. Connect the currently unwired contact flow to a real endpoint and add privacy/retention documentation.

## Prompt for the next Codex session

```text
Open PROJECT_HANDOFF.md and README.md first. Inspect git status and the latest main commit before editing. Continue the Airight project from the documented production state. Preserve the detector/IPR-score separation, never expose secrets, and test locally before pushing or deploying.
```
