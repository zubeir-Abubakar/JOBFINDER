# Provider Restoration — Before/After Regression Comparison

**Before:** `artifacts/provider-restoration/before-regression-snapshot.md`  
**After:** `artifacts/provider-restoration/after-regression-snapshot.md`

---

## 1. Test results

| Check | Before | After |
|---|---:|---:|
| Total tests | 573 | 579 |
| Passed | 566 | 575 |
| Failed | 3 | 0 |
| Skipped | 4 | 4 |
| Exit | 1 | 0 |

Six new tests were added. The three baseline failures were date-rollover test defects; they were corrected with relative/far-future timestamps, not by weakening assertions or changing application logic.

Focused provider/Gemini/scheduler checks after the repair: 89 tests, 85 passed, 4 skipped, 0 failed.

---

## 2. Typecheck and build

| Check | Before | After |
|---|---|---|
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run build` | exit 0 | exit 0 |

The final build was rerun after the last string-only change.

---

## 3. Provider eligibility

| Provider | Before | After |
|---|---|---|
| Gemini text/vision | `UNVERIFIED` — provider evidence empty | `FREE TIER AVAILABLE` — `owner_attested` |
| FreeLLMAPI | `UNVERIFIED` — provider evidence empty | `FREE TIER AVAILABLE` — `owner_attested` |
| Gemini Live | `available` — owner-attested | `available` — owner-attested |
| OpenRouter | Disabled, no key/model, blocked | Disabled, no key/model, blocked |
| Ollama | Local available | Local available |

### Gemini

Before, a real `gemini-3.6-flash` request succeeded, but the policy blocked it because `GEMINI_FREE_TIER_EVIDENCE` was empty. After, the same model is selected and the real request succeeds through the owner-attested path. The policy records `verification_kind=owner_attestation`, `estimated_cost_chf=0`, `maximum_authorised_cost_chf=0`, and `network_transmitted=1`.

### FreeLLMAPI

Before, the local gateway was reachable with 316 models and `gpt-oss-20b` performed real inference, but the policy blocked it because `FREELLMAPI_FREE_TIER_EVIDENCE` was empty. After, the pinned model is allowed through the owner-attested path; the real gateway returned `openai/gpt-oss-20b` (a declared alias) and the response was accepted. The resolved alias is recorded as the actual model.

### OpenRouter

Unchanged and still blocked. The repository has no `OPENROUTER_API_KEY`, no `OPENROUTER_MODEL`, and no agent assigned to OpenRouter. There is no inference client to enable. This is a genuine configuration/implementation gap, not a generic evidence-gate false negative.

The policy now gives a precise reason for disabled, missing key, missing model, non-`:free`, and exact `:free` with no assignment. Paid and dynamic routes are refused.

---

## 4. Eight-agent roster and assignments

All eight remain registered and online. No name, role, instruction, gate, delegation path or assignment was changed.

| Agent | Before | After |
|---|---|---|
| Chief | Gemini / `gemini-3.6-flash` | same |
| Saffa | Gemini / `gemini-3.6-flash` | same |
| Ali | FreeLLMAPI / `gpt-oss-20b` | same |
| Kora | Gemini / `gemini-3.6-flash` | same |
| Kali | Gemini / `gemini-3.6-flash` | same |
| Amira | FreeLLMAPI / `gpt-oss-20b` | same |
| Noor | Gemini / `gemini-3.6-flash` | same |
| Rayna | Gemini / `gemini-3.6-flash` | same |

No agent is assigned OpenRouter. No agent uses Ollama as its primary provider. Loopback Ollama remains the final fallback for all.

### Chief Coordinator

Chief's deterministic orchestration and persisted-task delegation rules were not touched. The delegated-workflow and routing suites pass. Chief's own optional text route is Gemini, as before.

---

## 5. Scheduler, recruitment and submission

| Item | Before | After |
|---|---|---|
| Recruitment time | 12:00 Europe/Zurich, all days | same |
| Next recruitment | 2026-11-26T11:00:00.000Z | same |
| Last status | `completed_with_warnings` | same |
| Latest run | `run_f8c5d6b17714f6ef6390153e` | same |
| Executive brief | 16:00 weekdays | same |
| Next brief | 2026-11-25T15:00:00.000Z | same |
| Submission failures | 0 | 0 |
| Submission unknown | 0 | 0 |
| Notification failures | 3 | 3 |

No recruitment code, schedule, threshold, automatic submission behaviour or submission policy was changed. The two scheduler test edits only make fixtures relative to the real clock; production schedule logic is untouched.

---

## 6. Database and health

| Check | Before | After |
|---|---|---|
| Integrity | ok | ok |
| Foreign-key violations | none | none |
| Schema | 26 | 26 |
| Tables | 40 | 40 |
| Users / jobs / applications | 1 / 66 / 5 | 1 / 66 / 5 |
| Documents / runs / tasks | 40 / 14 / 92 | 40 / 14 / 92 |
| Workflows / provider usage | 14 / 162 | 14 / 162 |
| Health | operational | operational |
| Workers | all running | all running |
| Registered agents | 8 | 8 |
| Active tasks | 0 | 0 |
| Failed tasks today | 1 | 1 |

No schema migration, table rewrite, data reset or production-provider write occurred during the real checks; they used temporary data directories.

---

## 7. CHF 0.00 enforcement

| Safeguard | Before | After |
|---|---|---|
| Budget cap | CHF 0.00 | CHF 0.00 |
| Paid models | blocked | blocked |
| Paid fallback | blocked | blocked |
| FreeLLMAPI routing aliases | blocked | blocked |
| Billable FreeLLMAPI ids | blocked | blocked |
| Gemini pro/ultra | blocked | blocked |
| OpenRouter paid/dynamic | blocked | blocked |
| Owner attestation vs provider evidence | only Live | separated for Gemini/FreeLLMAPI and Live |
| Synthetic cost/quota | none | none |

Adversarial tests set `AI_BUDGET_LIMIT_CHF=1000`, `AI_ALLOW_PAID_MODELS=true`, `AI_ALLOW_BILLING_FALLBACK=true`, OpenRouter paid flags, and legacy `GEMINI_PAID_AUTHORISED=true`. The policy still returned blocked or CHF 0.00 decisions.

---

## 8. Runtime activation

The before and after DBs are unchanged because the long-running production process has not been restarted. Two processes are still running:

- production supervisor: `node .../scripts/production-runtime.mjs --supervise`
- development server: `next dev`

Until the relevant process is restarted, the UI continues to serve the old provider gate. The new code, real provider calls and build were verified independently.

---

## 9. Regressions

No new regressions were found.

- Full suite failure count went from 3 to 0.
- All previous passing tests remained passing.
- No schema, roster, schedule or submission change.
- No paid route, fallback or billing activation was added.
- OpenRouter remains blocked, with a more precise reason. It is not a regression; it was never configured or implemented in this repository.

**Activation note:** restart the relevant app process to load the new build and attestation. Do not deploy or commit as part of this task.
