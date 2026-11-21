# AT AI Workforce

A working multi-agent recruitment operations platform for a single owner, built for a MacBook Air/M1 with 8 GB of memory. It ships as **one local Next.js application** with a SQLite database, server-side authentication, role-based access control and a real agent orchestration layer.

## What actually works

- **Authentication** — an established administrator (`abubakar@admin.com`; the legacy `admin@admin.com` address is migrated once without changing the password or related records), optional owner account created from the admin console or with `OWNER_*` / `ADMIN_*` environment variables, scrypt password hashing, database-backed sessions (hashed tokens), HttpOnly cookies, durable login throttling, optional TOTP MFA with one-time recovery codes, and audit logging. No default password is seeded or re-asserted.
- **RBAC** — the owner workspace (`/dashboard`, `/jobs`, `/documents`, …) and the administrator console (`/admin/…`) are enforced server-side in layouts and in every server action. An owner cannot reach admin pages by typing a URL.
- **Professional profile** — seeded with the facts in the brief (no invented dates, certifications or skills), fully editable; skill levels distinguish exposure from working/advanced expertise.
- **CV upload and extraction** — PDF (unpdf), DOCX (mammoth) and TXT are parsed locally, stored under `data/uploads`, and the detected name/email/phone/LinkedIn/skills are presented for review. Nothing is applied until you confirm; the original CV is never overwritten.
- **Job discovery** — the Job Research Agent queries the keyless [Arbeitnow](https://www.arbeitnow.com) job-board API, filters QA/testing titles and Swiss or remote roles, stores real descriptions and blocks duplicates (source slug + title/company). Manual vacancy entry is supported for every other board.
- **Matching** — deterministic weighted scoring (technical 35, experience 25, seniority 15, language 10, location/authorisation 10, salary 5) with matched skills, missing stack, language, permit and salary concerns. Exposure-only skills are penalised; no vacancy is rejected purely for a preferred skill and unknown salaries are never punished.
- **Documents** — tailored CV and cover letter generated as real PDF (`pdf-lib`) and DOCX (`docx`) files using only verified profile facts; each package is versioned per vacancy and audited by the ATS Quality Control Agent (keyword coverage, structure, contact details, unsupported claims). Pinning, manual deletion and retention expiry all work.
- **Applications** — one record per vacancy, all 13 requested statuses, CSV export, notes, submitted-only-with-confirmation enforcement, approval gate, document linkage and audit trail.
- **Agents** — eight specialist agents with their own instructions, tools and output contracts. A sequential background runner (`lib/workflow.ts`) executes coordinator → research → analysis → CV → ATS gate → cover letter → application preparation → inbox tracking, one stage at a time, persisting every task. The dashboard shows per-agent status (`idle`, `waiting`, `working`, `thinking`, `completed`, `failed`, `paused`, `unavailable`), provider/model attribution, task history and working start/pause/resume/stop/retry controls. `unavailable` is computed from real dependencies; it is never written over an explicit pause.
- **AI orchestration** — one shared provider service (`lib/providers.ts`) is used by every agent. FreeLLMAPI is primary; an enabled local Ollama instance is the fallback for recoverable rate limits, outages, network errors and timeouts. General calls use `OLLAMA_MODEL`; coding-specific calls use `OLLAMA_CODER_MODEL`. Configuration, authentication and malformed-request errors fail closed, with health checks, model verification, bounded retries, cooldown handling, usage tracking and provider attribution. Paid models are refused and the spending limit is CHF 0. If both providers fail, the workflow pauses and notifies the owner.
- **Gmail** — OAuth 2.0 with state validation and AES-256-GCM encrypted tokens; syncs recruiter mail, classifies invitations/rejections/questions, matches them to applications, creates Gmail drafts and updates statuses. Sending only happens from an explicit approval button.
- **AI assistant** — the Chief Coordinator handles conversation and workspace actions in two explicit paths. Conversational replies use the free provider service with a local fallback; workspace commands (search, list/filter vacancies, analyse, generate documents, review packages, show applications and recruiter messages, update preferences, pause/resume agents, reports, confirmed cleanup) execute deterministically against the database. Context from the current conversation is included, and destructive cleanup requires confirmation.
- **Analytics** — daily/weekly/monthly discovery and application charts, funnel, status distribution, conversion rates, source and CV-version performance, all from live SQL, with date filtering and daily/weekly/monthly reports.
- **Admin console** — system health, database statistics, storage usage, user management (create/disable/reset password), agent controls and JSON configuration, AI/API settings, email/Gmail OAuth settings, security policy, `VACUUM INTO` backups, retention management and audit logs.
- **Security** — path-safe file storage (random names, downloads through an authenticated route), content-signature upload validation, no public CV URLs, encrypted MFA secrets, durable SQLite API counters, trusted-proxy IP handling, production-only HSTS, outbound URL filtering, loopback/token-gated health output, and audit logging of logins, uploads, deletions, submissions and configuration changes.

## Setup

```bash
npm install
cp .env.example .env.local     # optional: owner/admin credentials
npm run build
npm run start                  # http://localhost:3000
```

### Administrator account

The existing administrator identity is `abubakar@admin.com`. On first start after this update, a legacy `admin@admin.com` account is renamed in place, keeping its password hash, role and records. If the new address already belongs to a different account, startup stops instead of overwriting it.

No default password is stored in the codebase or displayed by the login form. Accounts migrated from the old default are required to set a new password before opening the workspace. A fresh database with no accounts uses **First-run setup**; optional `OWNER_*` / `ADMIN_*` environment credentials are provisioned once and marked for a password change.

Administrators can open both the admin console and the owner workspace. To keep the two logins fully separate, create an owner account in **Admin → User accounts** (role: owner).

### Brand assets

`public/logo.svg` is the full lockup, `public/logo-mark.svg` is the monogram, and `app/icon.svg` is the favicon. The same mark is used by the sidebar wordmark and the animated route loader (`components/BrandMark.tsx`, `components/BrandLoader.tsx`).

For development: `npm run dev`. Type checking: `npm run typecheck`.

### Recruitment activity email

Scheduled recruitment runs produce a branded **AT AI Workforce | Recruitment Activity Report | [Date]** email. The HTML is built from persisted SQLite rows for the Europe/Zurich day, with a plain-text fallback and the existing `Logo.jpeg` attached inline by Content-ID so Gmail does not depend on a public image URL. It reports the executive summary, verified submissions with evidence, actual employer/ATS confirmations, pending work, failed tasks, all eight agent activity rows and next actions. A prepared package or an unverified attempt is never counted as a submitted application.

Immediate events (verified submission, submission failure, employer confirmation, agent error) use the same branded shell. Delivery remains a separate durable outbox, so a Gmail failure cannot trigger a second submission. The daily report is sent once per date; manual runs send an immediate run summary, not a duplicate daily report.

The live local policy is deliberately paused until the acceptance checks are approved: standing authorisation is inactive, approval mode is on and `recruitment_dry_run` is true. Reactivation is an explicit owner action, and the dry-run gate is also enforced inside the final submission function.

Data lives in `./data` (SQLite database, uploads, backups) and is git-ignored. Back it up from **Admin → Security → Run database backup**.

## Why these choices

| Brief | Implementation | Reason |
| --- | --- | --- |
| Next.js + TypeScript + Tailwind | Next.js 16 App Router, TypeScript, Tailwind v4 | Matches the requested frontend. |
| Python / FastAPI backend | Next.js server actions + route handlers | One process instead of two, far lighter on 8 GB RAM, same server-side guarantees. |
| LangGraph | Purpose-built coordinator + task table in `lib/agents.ts` | The brief allows an equivalent orchestration framework; sequential execution and structured task records fit the hardware constraint. |
| SQLite → PostgreSQL | SQLite via Node's built-in `node:sqlite` | No native dependency, zero setup. All SQL is portable; the schema is in `lib/db.ts`. |
| Gmail OAuth | OAuth routes + encrypted tokens + read/sync/draft/send-approval | Credentials come from the server environment; the redirect URI must be registered in Google Cloud. Tokens never reach the browser. |
| Playwright application submission | Configured HTTP form endpoint plus ATS adapters with evidence capture | Employer portals may require logins/CAPTCHA/MFA; those are never automated. A configured form endpoint (`RECRUITMENT_SUBMISSION_ENDPOINT`) or an employer-issued ATS credential can submit; success without a confirmation reference is recorded as `submission_unverified`. No live endpoint or credential is configured by default. |
| LLM provider | FreeLLMAPI primary → local Ollama fallback through one service | Deterministic scoring, matching and document facts stay authoritative. LLM output is used for planning, narrative and review notes, never invented facts. Paid models are blocked. Gemini/OpenRouter are not text fallbacks; Gemini is voice-only. |

## Local Ollama fallback

`OLLAMA_ENABLED=true` enables the fallback. `OLLAMA_BASE_URL` defaults to `http://localhost:11434`; `OLLAMA_MODEL` handles general inference and `OLLAMA_CODER_MODEL` is used only when a call marks itself as coding-specific. The admin AI page probes `/api/tags`, shows both configured models and reports the exact `ollama pull <model>` command when one is missing. Models are never downloaded automatically.

A localhost endpoint works only while `npm run dev` or `npm run start` and Ollama run on the same machine. A Vercel or other remote deployment cannot reach the operator's Mac at `localhost`; it needs a separately reachable, authenticated Ollama endpoint. Never expose port 11434 directly to the public internet. FreeLLMAPI remains primary, and a successful primary call clears any outage cooldown so routing returns to it automatically.

## Implementation status

**Implemented and tested** — persistent, configurable recruitment schedule
(default Monday–Friday at 09:00 Europe/Zurich) with DST handling, catch-up
window and missed-run records; the Chief Coordinator run with
its ten-section report and agent assignments; deterministic eligibility rules;
the 85% floor; tailored CV and cover-letter generation; the ATS/quality gate;
evidence-based submission states and duplicate blocking; discovery-only manual
runs; per-source metrics; dashboard and stored reports. `tests/recruitment.test.ts`
covers these with mocked HTTP boundaries.

**Configured live** — Arbeitnow; Ashby boards `airapps`, `clickhouse`; Greenhouse
boards `sumup`, `adyen`; Lever sites `anybotics`, `sonarsource`; and employer
pages whose postings publish JSON-LD. Only identifiers verified against the
public feeds are configured, and a live discovery run has stored real vacancies.

**Requires additional configuration** — `RECRUITMENT_SUBMISSION_ENDPOINT` (without
it, every package is queued for a human and nothing is sent); a running host or
host cron at the configured recruitment time (default 09:00 Europe/Zurich);
further board identifiers or career-page URLs
to widen coverage; Gmail credentials for inbox tracking.

**Not implemented** — portal login/CAPTCHA/MFA automation and automatic email
applications. Greenhouse, Lever and Ashby adapters exist but require an
explicitly supplied employer credential and are disabled without one. No
application has been submitted to a real employer.

## Deliberate limitations (not hidden in the UI)

- Gmail sending is never automatic: drafts require the explicit **Approve & send** action, and the Gmail account must be connected first. The configured redirect URI must be replaced with a real Google Cloud callback.
- Job discovery uses public, key-free feeds: Arbeitnow, Ashby job boards, Greenhouse job boards, Lever sites and employer pages that publish schema.org `JobPosting` JSON-LD. Ashby boards, Greenhouse boards, Lever sites and career-page URLs must be configured; jobs.ch is not scraped (terms of use). No vacancy is invented.
- The assistant can converse naturally, but it cannot invent workspace facts and does not claim an action succeeded without a backend result. Its workspace actions remain deterministic. Eligible applications are submitted autonomously; only genuine blockers (CAPTCHA, MFA, unsupported portals, missing mandatory information, ambiguous declarations) enter the Human Intervention Queue. The owner-level pause switch remains available.
- The daily run is started by an in-process scheduler while the application is running, and the same tick is exposed at `GET/POST /api/cron/recruitment` for a host cron. A switched-off machine cannot run it; a run outside the catch-up window is recorded as missed instead of being executed late. A restart marks interrupted workflow steps failed and pauses the run so it can be resumed.
- API throttling is durable across processes sharing the SQLite file, but it is not a distributed limiter for horizontal scaling.
- TOTP MFA is available per account but is not forced by policy. Enrol both the owner and administrator and store recovery codes offline before exposing the workspace.

## Project map

```
app/(app)/            owner workspace: dashboard, jobs, documents, profile, applications, agents, assistant, analytics, settings
app/admin/            administrator console
app/api/              authenticated document download + CSV export
lib/db.ts             schema, seeding, sqlite helpers
lib/agents.ts         coordinator, tasks, workflows, document packaging
lib/providers.ts      shared FreeLLMAPI/Ollama routing, health, usage, budget
lib/workflow.ts       sequential background runner, pause/stop/resume, recovery
lib/agent-definitions.ts  instructions, tools and output contracts for all eight agents
lib/agent-identity.ts  central agent-ID to illustration mapping
lib/agent-availability.ts  computed dependency health and effective display state
lib/gmail.ts          Gmail OAuth, encrypted tokens, sync, drafts and approval gate
lib/scoring.ts        match engine
lib/docgen.ts         CV/cover-letter models, DOCX + PDF rendering
lib/ats.ts            ATS self-assessment
lib/extract.ts        PDF/DOCX text extraction and field detection
lib/retention.ts      retention policy and storage statistics
lib/actions/          server actions (auth, profile, documents, jobs, applications, agents, chat, settings, admin)
lib/assistant.ts      coordinator command interpreter
```

## Autonomous recruitment (Phase 2)

The Chief Coordinator owns a full recruitment run. It is started by a persistent,
configurable schedule (`schedule_jobs` in SQLite), not by a browser tab or an
in-memory timer. The default is **Monday–Friday at 09:00 Europe/Zurich**; the
weekdays and local time can be changed in **Settings → Scheduling**. The schedule,
every run, every agent assignment, every vacancy decision and every submission
attempt are stored, so a restart does not lose them. Days that are not selected
are true rest days: scheduled discovery, document generation and submission do
not run and consume no scheduled inference tokens.

### What one run does

1. Discovery: Arbeitnow, public Ashby, Greenhouse and Lever job boards, and
   employer career pages that publish schema.org `JobPosting` JSON-LD.
2. Duplicate blocking on the source id, the application URL without tracking
   parameters, and a normalised employer + title key across all sources.
3. Eligibility: Swiss location or a remote posting that explicitly accepts
   Swiss/Europe applicants, Swiss Permit B (no sponsorship), mandatory German
   excluded, French B2 accepted, deadline and open/closed status.
4. Deterministic scoring with stored evidence. Only vacancies at **85% or higher**
   proceed; the threshold can be raised in settings but never lowered at runtime.
5. A tailored CV and cover letter per qualifying vacancy, then an independent ATS
   and package quality gate.
6. Submission through a configured HTTP application form endpoint, with evidence
   capture. A submission is recorded as `submitted` only when the employer
   endpoint returns success *and* a confirmation reference. A 2xx without a
   reference is `submission_unverified`.
7. A stored daily report with the ten requested sections, readable from
   **Autonomous recruitment** in the sidebar.

### Deliberate limits

- Login, CAPTCHA, MFA and paid applications are never automated. Those packages
  are queued as `human_intervention_required` and the run continues with other
  vacancies.
- `RECRUITMENT_SUBMISSION_ENDPOINT` must be configured for automatic HTTP
  submission. Without it, packages are prepared and queued for a human; nothing
  is marked as submitted.
- The scheduler runs inside this application. The Mac and the app/worker must be
  running at a configured recruitment time (default 09:00 Europe/Zurich). The
  database keeps the schedule and records a missed run instead of silently
  skipping it. For a future Vercel deployment the
  same tick is available at `GET/POST /api/cron/recruitment` (send
  `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set).

### Configuration

| Variable | Purpose |
| --- | --- |
| `ASHBY_JOB_BOARDS` | Comma-separated Ashby board slugs (or `ashby_job_boards` in settings). |
| `EMPLOYER_CAREER_PAGES` | Comma-separated career page URLs (or `employer_career_pages`). |
| `GREENHOUSE_BOARDS` | Comma-separated Greenhouse board tokens (or `greenhouse_boards`). |
| `LEVER_SITES` | Comma-separated Lever site names (or `lever_sites`). |
| `RECRUITMENT_SUBMISSION_ENDPOINT` | Form endpoint; placeholders `{job_id}`, `{application_url}`, `{company}`. |
| `RECRUITMENT_SUBMISSION_ENABLED` | `false` disables automatic sending. |
| `RECRUITMENT_DRY_RUN` | `true` prepares and verifies but sends nothing. |
| `RECRUITMENT_CATCHUP_HOURS` | Catch-up window before a run is recorded as missed (default 6). |
| `RECRUITMENT_SCHEDULER` | `false` disables the in-process tick (and the daily executive brief tick). |

`npx tsx --test tests/recruitment.test.ts` covers the DST-correct schedule,
schedule persistence, duplicate-run protection, the 85% floor, cross-source
deduplication, eligibility, the full orchestrated run, duplicate-submission
blocking, threshold exclusion and missed-run recording. Discovery and submission
use mocked HTTP boundaries; no test contacts a real employer.

### Daily executive brief

The Chief Coordinator publishes one consolidated executive brief. The default is
**Monday–Friday at 16:00 Europe/Zurich**, configurable independently in
**Settings → Scheduling**. It is a separate durable `schedule_jobs` row
(`daily_executive_brief`), so a completed recruitment run does not send its own
competing email. Routine
successes stay in-app; the brief carries the verified submission count, blocked
exceptions, agent-by-agent reconciliation, Coordinator assessment and next
priorities.

The brief is written to the existing `notification_outbox`, deduplicated as
`executive_brief:YYYY-MM-DD`. Gmail API acceptance, Sent-folder observation and
recipient delivery remain separate facts. A failed attempt is retried with
bounded backoff, and a retry checks the stored RFC Message-ID in Gmail Sent
before submitting again. A missing public `APP_BASE_URL` omits the dashboard CTA
but does not block the email; loopback and private links are never emitted. The
admin **Email & reports** page shows the schedule, Send Now/Resend controls,
Gmail message IDs, Sent-folder evidence and the exact delivery state.

A public `APP_BASE_URL` is mandatory for a live brief: the dashboard link must
open the existing `/dashboard` route on another device. If the origin is
missing, loopback or private, the Coordinator refuses to queue the report and
records the configuration blocker instead of sending a broken localhost link.
`npx tsx --test tests/executive-brief.test.ts` covers metric truth, missing agent
reports, empty periods, section order, plain-text/HTML rendering, the inline
logo, deduplication, scheduler/DST, retries and the no-secret boundary.
`npx tsx scripts/render-executive-brief-preview.ts` renders a clearly labelled
**TEST DATA** sample under `artifacts/` without sending anything.

## Android PWA and local HTTPS

AT AI Workforce ships a web app manifest, shell-only service worker and icons
generated from the original `Logo.jpeg`. The installed app launches in standalone
mode with the AT Workforce icon.

### Why the current LAN HTTP address is not installable

Android Chrome treats `http://<Mac-LAN-IP>:3000` as an insecure origin. It will
display the site, but service workers, PWA installation and microphone access
are blocked outside a secure context. `localhost` is special-cased only on the
Mac itself; it does not apply to the Samsung. Do not disable browser security or
expose the development server publicly.

### Start a private local HTTPS server

```bash
npm run dev:https
```

The first run creates a private local CA and a LAN certificate under `certs/`
(ignored by Git). The server certificate is regenerated on each start so the
Mac's current hotspot address is included in its SAN. The command listens on
`0.0.0.0:3000`, registers the shell-only service worker on the HTTPS origin, and
prints the LAN address(es). A plain HTTP development session does not register
the worker or count as installable.

If you only want to create or refresh the certificates:

```bash
npm run dev:https:cert
```

The generator includes `localhost`, the loopback address, the Mac's local
hostname and every current LAN IPv4 address in the certificate's Subject
Alternative Names. It also verifies those SANs and the CA signature before the
server starts, so a stale or incomplete certificate fails loudly instead of
producing a service-worker SSL error later.

### Trust the local CA on macOS

The Samsung and the Mac use separate trust stores. Trusting the CA on the phone
does not trust it in Chrome on the Mac. From the project root, add only the
public CA certificate to your login keychain:

```bash
security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" certs/local-ca.crt
```

No private key is installed or copied. If macOS asks for your login/Keychain
password, enter it. This grants trust to the current user only.

If the command reports an authorization error, or your administrator policy
requires system-wide trust, an administrator can instead run:

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certs/local-ca.crt
```

Prefer the login-keychain command above unless system-wide trust is genuinely
required. Never copy `certs/local-ca.key`, `certs/local.key` or any private key
to a browser, phone or another device, and do not install either `.key` file
anywhere.

GUI alternative: open `certs/local-ca.crt` in **Keychain Access**, add it to the
**login** keychain, double-click **AT AI Workforce Local CA**, expand **Trust**,
set **When using this certificate** to **Always Trust**, close the window and
authenticate. Fully quit and reopen Chrome afterward.

Verify the Mac trust without bypassing certificate checks:

```bash
security verify-cert -c certs/local.crt -p ssl -n localhost -L
curl -sS -o /dev/null -w '%{http_code}\n' https://localhost:3000/sw.js
```

The verification must succeed and curl must print `200`. If Chrome still shows
the old offline screen, clear the site data for `localhost` once, then reload.

### Trust the local CA on the Samsung

1. Keep `certs/local-ca.crt` private to your devices. Never copy `*.key` files.
2. Transfer only `certs/local-ca.crt` to the Samsung.
3. Open **Settings → Security and privacy → More security settings →
   Encryption & credentials → Install a certificate → CA certificate**.
4. Select the AT AI Workforce local CA and confirm the Android warning.
5. On the Samsung, open `https://<Mac-LAN-IP>:3000` in Chrome. The address must
   match the LAN address printed by `npm run dev:https`.

If the hotspot assigns a new address, stop the server, restart
`npm run dev:https`, and use the newly printed address. The CA does not need to
be reinstalled; only the server certificate is replaced.

### Install from Samsung Chrome

1. Open the HTTPS address and sign in.
2. Open Chrome's three-dot menu.
3. Choose **Add to Home screen** (or **Install app**) and confirm **Install**.
4. Launch **AT Workforce** from the home screen. It should open without the
   normal browser address bar.

Keep the Mac awake and the Next.js process running. The app still uses the
existing local SQLite backend and all existing server actions.

### If Chrome still says the app cannot be installed

Do not use the HTTP LAN address, and do not disable browser security. On the
Samsung, open **Chrome → the HTTPS address → Settings → Mobile diagnostics**
(or navigate directly to `/diagnostics`). The page checks all of the following
without uploading anything:

- `window.isSecureContext` and the exact origin
- Manifest status, content type, `start_url`, `scope`, `display` and icon URLs
- The natural dimensions of the 192, 512 and maskable icons
- Active, waiting and installing service-worker registrations
- Whether Chrome captured a `beforeinstallprompt` event

If the HTTPS address shows a certificate warning, the CA was not installed as a
**CA certificate**. Remove any CA installed under **VPN and app user
certificate**, install `certs/local-ca.crt` again under **CA certificate**, then
fully close and reopen Chrome. The lock icon must be normal before installation
can work.

If the diagnostics page shows a service-worker registration error or a stale
waiting worker, stop the dev server, restart `npm run dev:https`, and reload.
In Chrome, clear the site's storage from **Settings → Site settings → All sites →
[the app host] → Clear & reset** if the old worker keeps serving a stale
manifest. The current worker uses `atw-shell-v6` and fetches the manifest
network-first, so a corrected manifest is not hidden by the old cache.

If installation is still unavailable, copy the diagnostics report and include
it with the exact Chrome error. A 200 response for the manifest or icons alone
does not prove installability; Chrome must see a trusted secure context, an
active fetch-capable service worker and a valid manifest with usable icons.

### What the service worker caches

Only the offline shell, manifest, icons and immutable static assets are cached.
`/api/*`, `/admin`, `/login`, `/setup`, `/change-password`, `/documents`,
`/applications` and `/inbox` are never served from cache. Authentication tokens,
CV files, application records, employer correspondence and candidate data are
not stored in the PWA cache. Logout and server-side session expiry are unchanged.
