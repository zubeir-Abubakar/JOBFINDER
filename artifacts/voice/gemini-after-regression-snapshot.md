# Gemini Live — After Regression Snapshot

**Captured:** 2026-11-24, after the Gemini-only changes  
**Comparison baseline:** `artifacts/voice/gemini-before-regression-snapshot.md`

---

## 1. Git working tree

The repository still contains the user's pre-existing uncommitted changes. They were not reset, checked out, stashed or overwritten.

Files changed or added for this task:

- `lib/free-tier.ts` — opt-in Live owner attestation; strict evidence path retained
- `lib/live-voice.ts` — Live key/model preflight before token mint; fail-closed error handling
- `tests/gemini-live-attestation.test.ts` — new focused tests
- `.env.example` — documented the Live-only attestation
- `deploy/env.production.example` — documented the Live-only attestation
- `.env` — local `GEMINI_LIVE_FREE_TIER_ATTESTATION=owner_confirmed` (not tracked)
- `artifacts/voice/` — before/after comparison and report

No unrelated source, database, scheduler, recruitment or submission file was changed.

---

## 2. Tests, typecheck and build

```text
npx tsx --test tests/gemini-live-attestation.test.ts \
  tests/gemini-live-evidence-audit.test.ts \
  tests/live-voice-free-tier.test.ts
  tests 30
  pass 26
  fail 0
  skipped 4
  exit 0

npm test
  tests 573
  pass 569
  fail 0
  cancelled 0
  skipped 4
  todo 0
  duration 29.53s
  exit 0

npm run typecheck
  exit 0

npm run build
  exit 0
```

Additional focused agent/communication checks:

```text
npx tsx --test tests/agent-routing.test.ts tests/agent-presentation.test.ts \
  tests/agent-topology.test.ts tests/agent-operations.test.ts
  tests 24
  pass 24
  fail 0
  exit 0
```

The four skipped tests are the existing real-provider evidence placeholders. They were skipped before and remain skipped.

---

## 3. Gemini voice behaviour

Current state:

```json
{
  "configured": true,
  "blockedByPolicy": false,
  "state": "available",
  "model": "gemini-3.8-live",
  "voice": "Charon",
  "apiVersion": "v1beta",
  "verificationSource": "owner_attestation",
  "policyAllowed": true
}
```

Status detail:

```text
The owner has confirmed in AI Studio that the Gemini key belongs to a free-tier
project. Google does not expose a machine-readable billing attestation to this
key, so this is an owner attestation, not provider-issued billing evidence. The
key and model are preflighted before each token is minted, and quota or billing
failures block the route. gemini-3.8-live has a published free-tier price. Chief
speaks as Charon; no paid voice fallback or voice substitution exists.
```

Real provider verification performed:

- The existing `GEMINI_API_KEY` is present and is an `AQ.` authorization key.
- `GET /v1beta/models` returned `200` and listed `models/gemini-3.8-live` with `bidiGenerateContent`.
- `GET /v1beta/models/gemini-3.8-live` returned `200`, the exact model name and `bidiGenerateContent`.
- A real ephemeral Live token was minted for `gemini-3.8-live`.
- `createLiveSession()` returned a constrained `wss://generativelanguage.googleapis.com/...` URL and a setup payload for **Chief / Charon**.
- The token and URL were not recorded or printed.

The test session did not open a WebSocket, request a microphone or transmit audio. It proves server-side authorization, key/model reachability, token minting and session construction; browser media remains to be exercised after the running app is restarted.

Persisted evidence of the successful session:

- latest Live policy decision: `allowed`, `network_transmitted = 1`, no block reason
- `gemini_live_free_tier_last_success`: updated
- `live_voice_last_session`: updated

---

## 4. Eight-agent roster and availability

All eight agents remain enabled and online. The stored statuses are unchanged.

| Key | Name | Enabled | Stored status | Computed availability |
|---|---|---|---|---|
| `coordinator` | Chief | yes | completed | Online |
| `research` | Saffa | yes | completed | Online |
| `analysis` | Ali | yes | completed | Online |
| `cv` | Kora | yes | completed | Online |
| `ats` | Kali | yes | completed | Online |
| `cover` | Amira | yes | completed | Online |
| `application` | Noor | yes | failed | Online |
| `email` | Rayna | yes | completed | Online |

Noor's stored `failed` state is the same pre-existing historical submission outcome. It is not caused by this change.

The 24 focused agent-routing/presentation/topology/operations tests pass. Existing agent identities, roles, routing, topology and conversation history were not edited.

---

## 5. Recruitment scheduler and next run

Unchanged:

| Schedule | Time | Timezone | Weekdays | Enabled | Next run | Last status |
|---|---|---|---|---|---|---|
| `daily_recruitment` | 12:00 | Europe/Zurich | Monday–Sunday | yes | 2026-11-25T11:00:00.000Z (25 Nov 2026, 12:00) | completed |
| `daily_executive_brief` | 16:00 | Europe/Zurich | Monday–Friday | yes | 2026-11-25T15:00:00.000Z (25 Nov 2026, 16:00) | queued |

Latest recruitment run is unchanged:

- `run_b344b98b1706f31bf45408df`
- completed
- finished 2026-11-24T11:03:29.440Z
- 1 discovered / 1 eligible / 1 qualified / 0 verified submissions

No schedule was edited. No recruitment run was started by this task.

---

## 6. Database integrity and schema

Read-only SQLite inspection after the changes:

```text
PRAGMA integrity_check: ok
PRAGMA foreign_key_check: no rows
PRAGMA user_version: 26
Tables: 40
```

Counts unchanged:

- users: 1
- jobs: 66
- applications: 5
- documents: 40
- recruitment runs: 13
- tasks: 88
- workflows: 13
- agent sessions: 7

No schema migration or table rewrite occurred. The only new data rows are the intended Gemini Live policy/session/settings records from the successful token-minting check.

Database file mode: `0600`; uploads directory mode: `0700`.

---

## 7. Application health

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
workers: ai_queue running, document_recovery running, notification_outbox running,
         recruitment_scheduler running, temp_cleanup running
agents.registered: 8
agents.activeTasks: 0
agents.failedTasksToday: 4
```

Pre-existing conditions remain separately identified:

- 2 failed notification outbox rows
- 4 failed tasks today
- No pending notification, recovery or AI queue backlog
- Latest recruitment run completed

No recruitment, submission, email or provider-fallback action was triggered by the Gemini check.

---

## 8. Activation note

The long-running `next-server` process on port 3000 was started before these changes and was not stopped or restarted. It must be restarted to load the new build and the new `.env` value. The build itself completed successfully.

The direct server-side session check used the new code and `.env` and succeeded; it did not exercise the browser microphone/socket UI.

---

## 9. After conclusion

Gemini Live is restored at the server boundary: the existing free-tier key passes the real key/model preflight and mints a real constrained Live token for Chief/Charon. No other application functionality was changed, and the eight-agent roster, scheduler, database and health state are unchanged.
