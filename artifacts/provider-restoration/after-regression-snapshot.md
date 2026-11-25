# Provider Restoration — After Regression Snapshot

**Captured:** 2026-11-25, after the provider-eligibility repair  
**Comparison baseline:** `artifacts/provider-restoration/before-regression-snapshot.md`

No secrets are reproduced. The running application process was not restarted.

---

## 1. Final provider status

| Provider | Status | Evidence |
|---|---|---|
| Gemini text/vision | **CONFIGURED — OWNER-ATTESTED FREE TIER** | Key present, `gemini-3.6-flash`, real inference HTTP 200, explicit owner attestation |
| Gemini Live | **CONFIGURED — OWNER-ATTESTED FREE TIER** | Real ephemeral token minted, Chief/Charon, constrained `wss://` URL |
| FreeLLMAPI | **CONFIGURED — OWNER-ATTESTED FREE TIER** | Local gateway reachable, 316 models, `gpt-oss-20b`, real inference HTTP 200 |
| OpenRouter | **BLOCKED — FREE-TIER ACCESS UNAVAILABLE** | Disabled, no key, no model, no agent assignment, no inference adapter |
| Ollama | **LOCAL — AVAILABLE** | Both loopback models installed; retained as fallback only |

`GEMINI_FREE_TIER_EVIDENCE` and `FREELLMAPI_FREE_TIER_EVIDENCE` remain empty. The attestation is explicit:

- `GEMINI_FREE_TIER_ATTESTATION=owner_confirmed`
- `FREELLMAPI_FREE_TIER_ATTESTATION=owner_confirmed`
- `GEMINI_LIVE_FREE_TIER_ATTESTATION=owner_confirmed`

The runtime reports `verification_kind: owner_attestation` and `eligibility: owner_attested`. It does **not** claim provider-issued billing evidence. `evidence_reference` remains null.

---

## 2. Real inference results

These are actual provider requests, not mocks. They used a temporary `DATA_DIR`; the production database was not written by these checks.

### Gemini

```text
Agent: application (Noor)
Provider: gemini
Model: gemini-3.6-flash
HTTP/result: success
Text: "OK."
Usage: 13 prompt / 2 completion / 15 total
cost_chf: 0
cost_status: unverified
Maximum authorised external spend: CHF 0.00
Policy decision: allowed, network_transmitted=1
Verification: owner_attestation
```

### FreeLLMAPI

```text
Agent: analysis (Ali)
Provider: freellmapi
Configured model: gpt-oss-20b
Actual resolved model: openai/gpt-oss-20b (declared alias)
HTTP/result: success
Text: "OK"
Usage: 85 prompt / 40 completion / 125 total
cost_chf: 0
cost_status: unverified
Maximum authorised external spend: CHF 0.00
Policy decision: allowed, network_transmitted=1
Verification: owner_attestation
```

### Gemini Live

```text
Status: available
Eligibility: owner_attested
Verification source: owner_attestation
Model: gemini-3.8-live
Voice: Charon
Agent: Chief (coordinator)
Constrained wss URL: yes
Ephemeral token returned: yes
No microphone audio was transmitted by this check.
```

### OpenRouter

No request was made and none could legitimately be made:

- `OPENROUTER_ENABLED` is not true.
- `OPENROUTER_API_KEY` is absent.
- `OPENROUTER_MODEL` is absent.
- No agent is assigned OpenRouter in `lib/agent-models.ts`.
- There is no OpenRouter inference client in the current codebase.

The policy now distinguishes a missing configuration, a non-`:free` model, and an exact `:free` model with no assignment. All remain blocked. Paid/dynamic model identifiers are refused.

### Ollama

- `GET /api/tags`: HTTP 200.
- `llama3.2:3b` and `qwen2.5-coder:1.5b` are installed.
- Ollama was not used by the two real external checks above.
- The last production task before the restart used Ollama at 2026-11-25T12:18:36.521Z because the old process still had the pre-change external blocks.

---

## 3. Agent-to-provider assignments

Unchanged from the before snapshot:

| Agent | Key | Provider | Model |
|---|---|---|---|
| Chief | `coordinator` | Gemini | `gemini-3.6-flash` |
| Saffa | `research` | Gemini | `gemini-3.6-flash` |
| Ali | `analysis` | FreeLLMAPI | `gpt-oss-20b` |
| Kora | `cv` | Gemini | `gemini-3.6-flash` |
| Kali | `ats` | Gemini | `gemini-3.6-flash` |
| Amira | `cover` | FreeLLMAPI | `gpt-oss-20b` |
| Noor | `application` | Gemini | `gemini-3.6-flash` |
| Rayna | `email` | Gemini | `gemini-3.6-flash` |

No agent is assigned OpenRouter. No agent is assigned Ollama as a primary provider.

Fallback order remains assigned provider → other verified free provider → loopback Ollama. Fallback is recorded with `fallback_from` and a reason. It is not silent and never becomes a paid request.

---

## 4. Tests, typecheck and build

```text
npm test
  tests 579
  pass 575
  fail 0
  cancelled 0
  skipped 4
  todo 0
  duration 27.07s
  exit 0

npm run typecheck
  exit 0

npm run build
  exit 0
```

Focused provider/Gemini/scheduler tests:

```text
tests 89
pass 85
fail 0
skipped 4
```

The four skipped tests are the existing real-provider evidence placeholders.

### Baseline failures resolved

The before snapshot had three date-rollover test defects, not application failures:

1. Gemini Live exhaustion test used a fixed 24 Nov exhaustion whose reset had already passed.
2. Daily scheduler “missed occurrence” test inherited a run started because its fixed slot had become due.
3. Daily scheduler overlap test used 26 Nov as “now” while the host was on 25 Nov.

The tests now use a far-future reset / relative clock and future slot. No assertion was weakened, skipped or removed. The application scheduler logic was not changed.

### New tests

`tests/provider-owner-attestation.test.ts` covers:

- owner attestation is `owner_attested`, not `provider_verified`
- missing attestation blocks before fetch
- malformed evidence does not fall back to attestation
- paid Gemini, billable/routing FreeLLMAPI and dynamic/paid OpenRouter ids are refused
- actual Gemini and FreeLLMAPI calls use the configured agents/models
- usage rows attribute the actual provider/model
- no OpenRouter or Ollama call occurs
- Gemini Live remains separately owner-attested
- all eight assignments remain unchanged

---

## 5. Database and scheduler after the change

Read-only production SQLite inspection:

```text
PRAGMA integrity_check: ok
PRAGMA foreign_key_check: no rows
PRAGMA user_version: 26
Tables: 40
```

Counts unchanged from baseline:

- users: 1
- jobs: 66
- applications: 5
- documents: 40
- recruitment runs: 14
- tasks: 92
- workflows: 14
- provider usage: 162

The production DB still contains the pre-change blocked Gemini/FreeLLMAPI decisions because the long-running application process has not been restarted. The new code was exercised against temporary databases and real provider endpoints.

Schedules unchanged:

- Recruitment: 12:00 Europe/Zurich, all days, enabled; next run 2026-11-26T11:00:00.000Z (26 Nov, 12:00), last status `completed_with_warnings`.
- Executive brief: 16:00 Europe/Zurich weekdays; next run 2026-11-25T15:00:00.000Z.

Latest recruitment run unchanged:

- `run_f8c5d6b17714f6ef6390153e`
- `completed_with_warnings`
- finished 2026-11-25T12:18:36.545Z
- 0 discovered / 0 eligible / 0 qualified / 0 submitted

---

## 6. Application health and roster

Health: `operational`.

- Database integrity: ok; schema 26; DB mode 0600; uploads 0700.
- Workers: `ai_queue`, `document_recovery`, `notification_outbox`, `recruitment_scheduler`, `temp_cleanup` all running.
- Agents registered: 8; active tasks: 0; failed tasks today: 1.
- Notification failures: 3 (pre-existing).
- Submission failures: 0; submission unknown: 0.

All eight agents remain enabled and online. Saffa (`research`) and Noor (`application`) retain their historical `failed` stored status; this is not a current availability failure.

---

## 7. CHF 0.00 safeguards after the change

- `AI_BUDGET_LIMIT_CHF=0`
- `AI_ALLOW_PAID_MODELS=false`
- `AI_ALLOW_BILLING_FALLBACK=false`
- Adversarial tests set the budget to 1000 and enable paid flags; policy still returned CHF 0.00 / blocked decisions.
- Gemini pro/ultra ids are refused.
- FreeLLMAPI dynamic aliases and known billable ids are refused.
- OpenRouter models must match an exact `:free` id; `openrouter/free` is refused as a dynamic router, and `openai/gpt-4:free` is refused as billable.
- Confirmed quota exhaustion or billing restriction blocks the provider; ordinary rate limits cool down only.
- No synthetic cost, quota or provider evidence is created.
- A successful call is recorded with `cost_status=unverified`, never asserted as provider-proven CHF 0.00.

---

## 8. Activation state

The running production supervisor is still the old process:

```text
node .../scripts/production-runtime.mjs --supervise
```

A separate `next dev` process is also running. Neither was restarted, per scope restrictions. Until the relevant process is restarted, the live UI still serves the pre-change provider blocks. The new build and code path are verified directly.

OpenRouter remains blocked because this repository has no credential, exact free model or agent assignment. No OpenRouter inference adapter exists to enable.
