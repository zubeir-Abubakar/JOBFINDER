# Gemini Live — Before Regression Snapshot

**Captured:** 2026-11-24, before any code change for the Gemini Live restoration  
**Working tree preserved:** no `git reset`, `git checkout`, `git stash`, or overwrite of existing user changes was performed.

---

## 1. Git working tree and existing user changes

The repository already contained a large, uncommitted working tree before this task. This is the user's existing work and must be preserved.

- Branch: `main`
- Recent commits: `88ea46c adding agents topology`, `5047cfa adding natural voice flow to Agents like NOOR and Saffa`, `bf6048b adding playwright tests`, `bcbfb2c optimising voice`, `b0a5bfe Freeze verified production baseline`
- `git status --short`: 113 tracked files modified, plus untracked files and directories.
- `git diff --stat`: 113 files changed, 6,087 insertions, 1,844 deletions (pre-existing work).
- Notable already-modified Gemini/Live paths:
  - `app/api/voice/live/session/route.ts`
  - `lib/live-voice.ts`
  - `lib/free-tier.ts` is untracked but present
  - `lib/ai-spending-policy.ts` is untracked but present
  - `package.json` and `package-lock.json` already modified
  - `tests/gemini-live-evidence-audit.test.ts`, `tests/live-voice-free-tier.test.ts`, `tests/free-tier-live.test.ts` are untracked but present
- Existing untracked areas include `artifacts/voice/`, dashboard work, browser-form work, recruitment phases, and tests. No unrelated file was reverted, cleaned, or reformatted.

Full status was captured from the live working tree at the time of this snapshot. The presence of pre-existing changes is not a regression caused by this task.

---

## 2. Tests, typecheck and build

Commands match the project scripts:

```text
npm test
  tests 567
  pass 563
  fail 0
  cancelled 0
  skipped 4
  todo 0
  duration 29.28s
  exit 0

npm run typecheck
  exit 0

npm run build
  exit 0
```

The four skipped tests are the deliberately skipped real-provider checks in `tests/gemini-live-evidence-audit.test.ts`; they require genuine provider evidence/credentials and do not run in the baseline.

No pre-existing test, typecheck or build failure was observed.

---

## 3. Existing Gemini voice behaviour and exact error

Current server configuration:

- `GEMINI_API_KEY`: set in the running application environment (value not recorded)
- `GEMINI_LIVE_MODEL`: `gemini-3.8-live`
- `GEMINI_LIVE_VOICE`: `Charon`
- `GEMINI_LIVE_API_VERSION`: `v1beta`
- `GEMINI_FREE_TIER_VERIFIED`: `true`
- `GEMINI_FREE_TIER_EVIDENCE`: empty
- `GEMINI_PAID_AUTHORISED`: not a valid authorisation path

Direct runtime state:

```json
{
  "configured": true,
  "blockedByPolicy": true,
  "freeTierState": "unverified",
  "model": "gemini-3.8-live",
  "voice": "Charon",
  "apiVersion": "v1beta",
  "policyAllowed": false
}
```

Exact gate error:

```text
Gemini Live provider evidence is not sufficient: GEMINI_FREE_TIER_EVIDENCE is empty. A provider-issued evidence record is required; an operator declaration alone is not accepted.. No microphone audio is transmitted.
```

Exact policy block:

```text
Gemini Live voice is blocked before transmission: Gemini Live provider evidence is not sufficient: GEMINI_FREE_TIER_EVIDENCE is empty. A provider-issued evidence record is required; an operator declaration alone is not accepted.. No microphone audio is transmitted. Authorised external spend is CHF 0.00.
```

The most recent persisted blocked Live decisions in `ai_policy_decisions` carry the same reason. No microphone audio and no Live session URL are produced while this gate is closed.

The existing Live path is otherwise wired:

- `lib/live-voice.ts` authorises the request before `ai.authTokens.create()`.
- Only after authorisation does it mint a one-use ephemeral token and return the constrained WebSocket URL.
- The permanent API key never leaves the server.
- The configured voice is fixed server-side by the agent profile.

---

## 4. Eight-agent roster and availability

All eight registered agents are enabled. Stored task status is historical; the computed availability is online for all eight.

| Key | Name | Title | Enabled | Stored status | Computed availability |
|---|---|---|---|---|---|
| `coordinator` | Chief | Chief Coordinator / Orchestrator | yes | completed | Online |
| `research` | Saffa | Job Research Agent / Discovery | yes | completed | Online |
| `analysis` | Ali | Job Analysis Agent / Matching | yes | completed | Online |
| `cv` | Kora | CV Optimisation Agent / Documents | yes | completed | Online |
| `ats` | Kali | ATS Quality Control Agent | yes | completed | Online |
| `cover` | Amira | Application Agent / Cover Letter & Documents | yes | completed | Online |
| `application` | Noor | Application Agent / Submission | yes | failed | Online |
| `email` | Rayna | Email & Tracking Agent | yes | completed | Online |

Noor's stored `failed` state is a historical task outcome (no server-rendered application form), not a current dependency outage. The availability calculation correctly reports the agent itself as online.

Existing voice assignments are unchanged: Chief/Charon, Saffa/Leda, Ali/Fenrir, Kora/Kore, Kali/Puck, Amira/Aoede, Noor/Orus, Rayna/Zephyr.

---

## 5. Recruitment scheduler configuration and next run

Persisted `schedule_jobs`:

| Schedule | Time | Timezone | Weekdays | Enabled | Next run | Last status |
|---|---|---|---|---|---|---|
| `daily_recruitment` | 12:00 | Europe/Zurich | Monday–Sunday | yes | 2026-11-25T11:00:00.000Z (25 Nov 2026, 12:00) | completed |
| `daily_executive_brief` | 16:00 | Europe/Zurich | Monday–Friday | yes | 2026-11-25T15:00:00.000Z (25 Nov 2026, 16:00) | queued (latest brief sent) |

Latest recruitment run:

- ID: `run_b344b98b1706f31bf45408df`
- Trigger: catch-up
- Status: completed
- Scheduled for: 2026-11-24T11:00:00.000Z
- Finished: 2026-11-24T11:03:29.440Z
- Jobs discovered/eligible/qualified: 1 / 1 / 1
- Verified submissions: 0

No scheduler setting was changed by this snapshot.

---

## 6. Database integrity and schema

Read-only SQLite inspection:

```text
PRAGMA integrity_check: ok
PRAGMA foreign_key_check: no rows
PRAGMA user_version: 26
Tables: 40
```

Record counts:

- users: 1
- jobs: 66
- applications: 5
- documents: 40
- recruitment runs: 13
- tasks: 88
- workflows: 13
- agent sessions: 7

Database file mode: `0600`; uploads directory mode: `0700`. No permission warning.

The database was opened read-only for this snapshot. No schema migration, scheduler change, recruitment change or row rewrite was made.

---

## 7. Application health and critical functionality

Persisted operational health snapshot:

```text
status: operational
detail: Database, scheduler and background workers are healthy.
database.ok: true
database.integrity: ok
database.schemaVersion: 26
scheduler.enabled: true
scheduler.nextRunAt: 2026-11-25T11:00:00.000Z
scheduler.nextRunLabel: 25 Nov 2026, 12:00
scheduler.worker: running
workers: ai_queue running, document_recovery running, notification_outbox running, recruitment_scheduler running, temp_cleanup running
agents.registered: 8
agents.activeTasks: 0
agents.failedTasksToday: 4
```

Known pre-existing conditions recorded separately from this task:

- 2 failed notification outbox rows exist from earlier delivery attempts; no pending notification backlog.
- Recent recruitment runs include two failed catch-up runs from 23 Nov 2026; the latest run is completed.
- The health function was run in a standalone snapshot process, so its in-process `tickerRunning` flag is false; the persisted scheduler worker heartbeat is running. The HTTP health route returned `404` locally because no `HEALTHCHECK_TOKEN` is configured in this environment and production loopback health requires one.
- No employment submission, email send, recruitment run or scheduler mutation was triggered by this baseline.

Critical functionality represented in the passing suite includes authentication/RBAC, agent orchestration, recruitment scheduling, discovery/eligibility/scoring, document generation and quality gates, application safety, notifications, Gmail boundaries, dashboard routes and the existing Gemini Live policy.

---

## 8. Baseline conclusion

The baseline is established. The application is operational, the eight-agent roster is intact, the scheduler is unchanged, the database is clean, and the only current Gemini Live failure is the expected fail-closed provider-evidence gate.

No code was modified before this snapshot was written.
