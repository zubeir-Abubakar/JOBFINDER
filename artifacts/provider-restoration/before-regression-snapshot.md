# Provider Restoration — Before Regression Snapshot

**Captured:** 2026-11-25, before provider-eligibility changes  
**Scope:** Gemini text/vision, Gemini Live, FreeLLMAPI, OpenRouter, Ollama fallback, eight-agent routing, CHF 0.00 policy.

No application code, database schema, scheduler, recruitment policy or submission behaviour was changed before this snapshot. API keys and tokens are not reproduced here.

---

## 1. Root cause observed

### Gemini text/vision

Configuration is present:

- `AI_PRIMARY_PROVIDER=gemini`
- `GEMINI_API_KEY` present
- `GEMINI_MODEL=gemini-3.6-flash`
- `VISION_MODEL=gemini-3.6-flash`
- `GEMINI_FREE_TIER_VERIFIED=true`
- `GEMINI_LIVE_MODEL=gemini-3.8-live`
- `GEMINI_LIVE_FREE_TIER_ATTESTATION=owner_confirmed`
- `GEMINI_FREE_TIER_EVIDENCE` is empty
- `GEMINI_PAID_AUTHORISED=true` (legacy, ignored by policy)

Status:

```text
state: unverified
allowed: false
detail: Gemini provider evidence is not sufficient: GEMINI_FREE_TIER_EVIDENCE is empty.
        A provider-issued evidence record is required; an operator declaration alone is not accepted.
```

Real Gemini `generateContent` request with `gemini-3.6-flash` returned HTTP 200 and token usage. No paid model or billing activation was used.

### FreeLLMAPI

Configuration is present:

- `FREELLMAPI_ENABLED=true`
- `FREELLMAPI_BASE_URL=http://127.0.0.1:31415/v1`
- `FREELLMAPI_API_KEY` present
- `FREELLMAPI_MODEL=gpt-oss-20b`
- `FREELLMAPI_ALLOWED_MODELS=gpt-oss-20b`
- eight declared resolution aliases
- `FREELLMAPI_FREE_TIER_VERIFIED=true`
- `FREELLMAPI_FREE_TIER_EVIDENCE` is empty

Status:

```text
state: unverified
allowed: false
detail: FreeLLMAPI provider evidence is not sufficient: FREELLMAPI_FREE_TIER_EVIDENCE is empty.
        A provider-issued evidence record is required; an operator declaration alone is not accepted.
```

Real gateway checks:

- `GET /v1/models`: HTTP 200, 316 models, pinned `gpt-oss-20b` present.
- `POST /v1/chat/completions` with `gpt-oss-20b`: HTTP 200, non-empty completion, model reported as `openai/gpt-oss-20b` (a declared alias).
- No paid endpoint, paid model or retry upgrade was used.

### OpenRouter

OpenRouter is **not configured** in the repository's only env file:

- `.env` contains `OPENROUTER_ENABLED` only.
- No `OPENROUTER_API_KEY`.
- No `OPENROUTER_MODEL`.
- `OPENROUTER_ALLOW_PAID_MODELS`, `OPENROUTER_ALLOW_CREDITS` and `OPENROUTER_ALLOW_AUTO_RECHARGE` are unset/false.
- No `.env.local` or other env file exists.

The code has a configuration block and health placeholder, but **no OpenRouter inference client and no OpenRouter route candidate**. `evaluateAiPolicy` unconditionally blocks OpenRouter.

No agent is assigned OpenRouter in `lib/agent-models.ts`.

**Therefore OpenRouter cannot be made operational without credentials/model selection and an explicit assignment decision. No credential or assignment was invented.**

### Ollama

- `OLLAMA_ENABLED=true`
- `OLLAMA_BASE_URL=http://localhost:11434`
- `OLLAMA_MODEL=llama3.2:3b`
- `OLLAMA_CODER_MODEL=qwen2.5-coder:1.5b`
- `GET /api/tags`: HTTP 200, both models installed.

Ollama is the existing local fallback and is not an external route.

---

## 2. Existing agent-to-provider assignments

These are the actual assignments in `lib/agent-models.ts`; they were preserved exactly.

| Agent | Key | Assigned provider | Configured model |
|---|---|---|---|
| Chief | `coordinator` | Gemini | `gemini-3.6-flash` |
| Saffa | `research` | Gemini | `gemini-3.6-flash` |
| Ali | `analysis` | FreeLLMAPI | `gpt-oss-20b` |
| Kora | `cv` | Gemini | `gemini-3.6-flash` |
| Kali | `ats` | Gemini | `gemini-3.6-flash` |
| Amira | `cover` | FreeLLMAPI | `gpt-oss-20b` |
| Noor | `application` | Gemini | `gemini-3.6-flash` |
| Rayna | `email` | Gemini | `gemini-3.6-flash` |

Fallback order is the assigned provider, then the other verified free provider, then loopback Ollama. Fallback is recorded with `fallback_from` and a reason; it is not silent and never becomes a paid request.

No agent is assigned OpenRouter. No agent is assigned Ollama as its primary provider.

---

## 3. Baseline tests, typecheck and build

```text
npm test
  tests 573
  pass 566
  fail 3
  skipped 4
  cancelled 0
  exit 1

npm run typecheck
  exit 0

npm run build
  exit 0
```

### The three baseline failures are date-rollover test defects, not provider application failures

1. `tests/gemini-live-evidence-audit.test.ts` — “recorded free-quota exhaustion blocks before transmission”
   - Test writes exhaustion at `2026-11-24T10:00:00Z`; reset becomes `2026-11-25T00:00:00Z`.
   - The test then creates a session using the real clock on 2026-11-25, after the reset.
   - The correctly expired block is cleared, so no rejection occurs.

2. `tests/daily-scheduler.test.ts` — “a missed occurrence is recorded once and never replayed by catch-up”
   - Previous scheduler test used `2026-11-25T11:00:00Z`, which is now in the past, so starting the scheduler can create a run during the test.
   - The next test sees “A recruitment run is already in progress” instead of its own missed-occurrence fixture.

3. `tests/daily-scheduler.test.ts` — “an in-progress recruitment run prevents overlapping execution”
   - Fixture uses `2026-11-26T11:05:00Z` as “now”; current host time is 2026-11-25, so the fixture is not due and the ticker says “not due yet”.

No assertion was weakened, skipped or removed.

---

## 4. Baseline database and application state

Read-only SQLite inspection:

```text
PRAGMA integrity_check: ok
PRAGMA foreign_key_check: no rows
PRAGMA user_version: 26
Tables: 40
```

Counts:

- users: 1
- jobs: 66
- applications: 5
- documents: 40
- recruitment runs: 14
- tasks: 92
- workflows: 14
- provider usage: 162

Recent usage includes Gemini, FreeLLMAPI, Gemini Live and Ollama. No OpenRouter usage exists.

Application health: operational.

- Database integrity: ok, schema 26, file mode 0600, uploads 0700.
- Workers: `ai_queue`, `document_recovery`, `notification_outbox`, `recruitment_scheduler`, `temp_cleanup` all `running`.
- Agents registered: 8. Active tasks: 0. Failed tasks today: 1.
- Notification failures: 3 (pre-existing).
- Latest recruitment run: `run_f8c5d6b17714f6ef6390153e`, `completed_with_warnings`, finished 2026-11-25T12:18:36.545Z, 0 discovered / 0 eligible / 0 qualified / 0 submitted.
- Scheduler: daily at 12:00 Europe/Zurich, all days, enabled; next run 2026-11-26T11:00:00.000Z.
- Executive brief: 16:00 Europe/Zurich weekdays; next run 2026-11-25T15:00:00.000Z.

---

## 5. Baseline eight-agent roster

All eight are enabled. Stored statuses are historical and are not the same as current availability.

| Agent | Key | Enabled | Stored status | Availability |
|---|---|---|---|---|
| Chief | `coordinator` | yes | completed | online |
| Saffa | `research` | yes | failed | online |
| Ali | `analysis` | yes | completed | online |
| Kora | `cv` | yes | completed | online |
| Kali | `ats` | yes | completed | online |
| Amira | `cover` | yes | completed | online |
| Noor | `application` | yes | failed | online |
| Rayna | `email` | yes | completed | online |

Saffa and Noor's stored `failed` states are pre-existing historical task outcomes.

---

## 6. Gemini Live baseline

Gemini Live is already available through the Live-only owner attestation:

```text
state: available
allowed: true
verification_source: owner_attestation
model: gemini-3.8-live
voice: Charon
apiVersion: v1beta
last_success_at: 2026-11-24T23:22:25.057Z
```

A previous real ephemeral-token mint and constrained `wss://` session creation succeeded. No paid voice fallback exists.

---

## 7. CHF 0.00 safeguards in the baseline

- `AI_BUDGET_LIMIT_CHF=0`
- `AI_ALLOW_PAID_MODELS=false`
- `AI_ALLOW_BILLING_FALLBACK=false`
- `GEMINI_PAID_AUTHORISED=true` is legacy and ignored by policy
- Paid Gemini pro/ultra models are refused
- FreeLLMAPI dynamic routing aliases and known billable ids are refused
- OpenRouter is blocked
- No paid fallback, billing activation, synthetic cost or synthetic quota exists
- A successful provider response is never treated as proof of free billing

---

## 8. Baseline conclusion

Gemini and FreeLLMAPI are technically reachable and perform real inference, but the generic provider-evidence requirement marks both `UNVERIFIED` before transmission. This is the exact regression to repair.

OpenRouter is a separate blocker: this repository has no key, model or agent assignment for it. That cannot be repaired by eligibility code alone, and no credential was invented.
