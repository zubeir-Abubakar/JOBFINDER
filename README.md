# AT AI Workforce

A working multi-agent recruitment operations platform for a single owner, built for a MacBook Air/M1 with 8 GB of memory. It ships as **one local Next.js application** with a SQLite database, server-side authentication, role-based access control and a real agent orchestration layer.

## What actually works

- **Authentication** — an established administrator (`abubakar@admin.com`; the legacy `admin@admin.com` address is migrated once without changing the password or related records), optional owner account created from the admin console or with `OWNER_*` / `ADMIN_*` environment variables, scrypt password hashing, database-backed sessions (hashed tokens), HttpOnly cookies, login rate limiting and audit logging. No default password is seeded or re-asserted.
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
- **Security** — path-safe file storage (random names, downloads through an authenticated route), upload size/type validation, no public CV URLs, audit logging of logins, uploads, deletions, submissions and configuration changes.

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

Data lives in `./data` (SQLite database, uploads, backups) and is git-ignored. Back it up from **Admin → Security → Run database backup**.

## Why these choices

| Brief | Implementation | Reason |
| --- | --- | --- |
| Next.js + TypeScript + Tailwind | Next.js 16 App Router, TypeScript, Tailwind v4 | Matches the requested frontend. |
| Python / FastAPI backend | Next.js server actions + route handlers | One process instead of two, far lighter on 8 GB RAM, same server-side guarantees. |
| LangGraph | Purpose-built coordinator + task table in `lib/agents.ts` | The brief allows an equivalent orchestration framework; sequential execution and structured task records fit the hardware constraint. |
| SQLite → PostgreSQL | SQLite via Node's built-in `node:sqlite` | No native dependency, zero setup. All SQL is portable; the schema is in `lib/db.ts`. |
| Gmail OAuth | OAuth routes + encrypted tokens + read/sync/draft/send-approval | Credentials come from the server environment; the redirect URI must be registered in Google Cloud. Tokens never reach the browser. |
| Playwright application submission | Configured HTTP form endpoint with evidence capture | Employer portals require logins/CAPTCHA/MFA and are never automated. An explicitly configured form endpoint (`RECRUITMENT_SUBMISSION_ENDPOINT`) can submit; it must return a confirmation reference, otherwise the application is recorded as `submission_unverified`. No ATS-specific adapter ships and no endpoint is configured by default. |
| LLM provider | FreeLLMAPI primary → local Ollama fallback through one service | Deterministic scoring, matching and document facts stay authoritative. LLM output is used for planning, narrative and review notes, never invented facts. Paid models are blocked. Gemini/OpenRouter are not text fallbacks; Gemini is voice-only. |

## Local Ollama fallback

`OLLAMA_ENABLED=true` enables the fallback. `OLLAMA_BASE_URL` defaults to `http://localhost:11434`; `OLLAMA_MODEL` handles general inference and `OLLAMA_CODER_MODEL` is used only when a call marks itself as coding-specific. The admin AI page probes `/api/tags`, shows both configured models and reports the exact `ollama pull <model>` command when one is missing. Models are never downloaded automatically.

A localhost endpoint works only while `npm run dev` or `npm run start` and Ollama run on the same machine. A Vercel or other remote deployment cannot reach the operator's Mac at `localhost`; it needs a separately reachable, authenticated Ollama endpoint. Never expose port 11434 directly to the public internet. FreeLLMAPI remains primary, and a successful primary call clears any outage cooldown so routing returns to it automatically.

## Implementation status

**Implemented and tested** — persistent 10:00 Europe/Zurich schedule with DST
handling, catch-up window and missed-run records; the Chief Coordinator run with
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
host cron at 10:00 Europe/Zurich; further board identifiers or career-page URLs
to widen coverage; Gmail credentials for inbox tracking.

**Not implemented** — ATS-specific submission adapters (Ashby, Greenhouse and
Lever apply APIs), portal login/CAPTCHA/MFA automation, and automatic email
applications. No application has been submitted to a real employer.

## Deliberate limitations (not hidden in the UI)

- Gmail sending is never automatic: drafts require the explicit **Approve & send** action, and the Gmail account must be connected first. The configured redirect URI must be replaced with a real Google Cloud callback.
- Job discovery uses public, key-free feeds: Arbeitnow, Ashby job boards, Greenhouse job boards, Lever sites and employer pages that publish schema.org `JobPosting` JSON-LD. Ashby boards, Greenhouse boards, Lever sites and career-page URLs must be configured; jobs.ch is not scraped (terms of use). No vacancy is invented.
- The assistant can converse naturally, but it cannot invent workspace facts and does not claim an action succeeded without a backend result. Its workspace actions remain deterministic and approval gates are unchanged.
- The daily run is started by an in-process scheduler while the application is running, and the same tick is exposed at `GET/POST /api/cron/recruitment` for a host cron. A switched-off machine cannot run it; a run outside the catch-up window is recorded as missed instead of being executed late. A restart marks interrupted workflow steps failed and pauses the run so it can be resumed.

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

The Chief Coordinator owns a full daily recruitment run. It is started by a
persistent schedule at **10:00 Europe/Zurich** (`schedule_jobs` in SQLite), not by
a browser tab or an in-memory timer. The schedule, every run, every agent
assignment, every vacancy decision and every submission attempt are stored, so a
restart does not lose them.

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
  running at 10:00 Europe/Zurich. The database keeps the schedule and records a
  missed run instead of silently skipping it. For a future Vercel deployment the
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
| `RECRUITMENT_SCHEDULER` | `false` disables the in-process tick. |

`npx tsx --test tests/recruitment.test.ts` covers the DST-correct schedule,
schedule persistence, duplicate-run protection, the 85% floor, cross-source
deduplication, eligibility, the full orchestrated run, duplicate-submission
blocking, threshold exclusion and missed-run recording. Discovery and submission
use mocked HTTP boundaries; no test contacts a real employer.
