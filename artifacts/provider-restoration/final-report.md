# Provider Restoration — Final Report

**Date:** 2026-11-25  
**Scope:** Provider eligibility and inference routing only. No commit, push, deployment, restart, recruitment schedule change or external submission.

---

## 1. Root cause

### Gemini and FreeLLMAPI

Both providers were configured and technically reachable, but `freeTierVerification()` required a non-empty, provider-issued JSON evidence record:

- `GEMINI_FREE_TIER_EVIDENCE` was empty.
- `FREELLMAPI_FREE_TIER_EVIDENCE` was empty.

Their explicit `*_FREE_TIER_VERIFIED=true` declarations were therefore treated as `UNVERIFIED`, and every text call was blocked before transmission. This was the unnecessary fallback to Ollama.

The owner had already explicitly confirmed both services are on free-tier plans. Google and the local gateway do not expose the same machine-readable billing proof through these API-key credentials.

### OpenRouter

OpenRouter was **not** blocked by a generic evidence field. It is absent from the actual configuration:

- `OPENROUTER_ENABLED` is not true.
- No `OPENROUTER_API_KEY`.
- No `OPENROUTER_MODEL`.
- No agent assigned to OpenRouter.
- No OpenRouter inference adapter exists in the codebase.

No credential, model, assignment or provider evidence was invented.

---

## 2. Exact files changed

| File | Change |
|---|---|
| `lib/free-tier.ts` | Added provider-specific owner attestation, `FreeTierEligibility`, precise eligibility labels, exact OpenRouter `:free` validator, and separate owner/provider verification kinds. Strict evidence still wins; malformed evidence does not fall back to attestation. |
| `lib/ai-spending-policy.ts` | Carries `owner_attestation` into policy decisions; precise OpenRouter disabled/missing-key/missing-model/non-free/assignment blockers; keeps CHF 0.00 cap. |
| `lib/providers.ts` | Removed unsafe `openrouter/free` default, added exact free-model health diagnostics, updated truthful provider comments. No OpenRouter inference client was invented. |
| `app/admin/ai/page.tsx` | Shows `OWNER ATTESTED` separately from `PROVIDER VERIFIED` for Gemini, FreeLLMAPI and Live. |
| `.env.example` | Documents Gemini/FreeLLMAPI owner attestations and exact OpenRouter `:free` requirement. |
| `deploy/env.production.example` | Same production documentation. |
| `README.md` | Corrected “verified free-tier” wording to “owner-attested free-tier.” |
| `tests/provider-owner-attestation.test.ts` | Six new deterministic tests for the attestation path, model guards, assignments, usage attribution and Live separation. |
| `tests/gemini-live-evidence-audit.test.ts` | Date-rollover test repair only (far-future reset). |
| `tests/daily-scheduler.test.ts` | Date-rollover test repair only (relative/future fixtures). No scheduler logic changed. |
| `.env` | Added `GEMINI_FREE_TIER_ATTESTATION=owner_confirmed` and `FREELLMAPI_FREE_TIER_ATTESTATION=owner_confirmed` (untracked local config). |
| `artifacts/provider-restoration/` | Before/after snapshots, comparison and this report. |

No API key, token or `.env` secret is reproduced in any artifact.

---

## 3. Gemini status

**CONFIGURED — OWNER-ATTESTED FREE TIER**

- Key present; configured model `gemini-3.6-flash`.
- Free-tier declaration true.
- Explicit owner attestation: `GEMINI_FREE_TIER_ATTESTATION=owner_confirmed`.
- Verification kind: `owner_attestation`.
- Eligibility: `owner_attested`.
- Real inference: HTTP 200, text `OK.`, usage 13/2/15, `cost_chf=0`, `cost_status=unverified`.
- Maximum authorised external spend: **CHF 0.00**.
- No provider-issued billing evidence is claimed. `evidence_reference` is null.

Gemini Live remains separately configured:

- `gemini-3.8-live`, Charon, Chief.
- Real ephemeral token minted; constrained `wss://` URL returned.
- No microphone audio was transmitted by the verification.
- No paid fallback or voice substitution exists.

---

## 4. FreeLLMAPI status

**CONFIGURED — OWNER-ATTESTED FREE TIER**

- Local gateway reachable at `http://127.0.0.1:31415/v1`.
- 316 models listed; pinned `gpt-oss-20b` present.
- Explicit owner attestation: `FREELLMAPI_FREE_TIER_ATTESTATION=owner_confirmed`.
- Real inference: HTTP 200, text `OK`, actual resolved model `openai/gpt-oss-20b` (declared alias), usage 85/40/125.
- Verification kind: `owner_attestation`; eligibility `owner_attested`.
- `cost_chf=0`, `cost_status=unverified`; maximum authorised external spend CHF 0.00.
- Pinned non-billable model, allowlist, aliases and quota/billing guards remain active.

---

## 5. OpenRouter status

**BLOCKED — FREE-TIER ACCESS UNAVAILABLE**

- `OPENROUTER_ENABLED` is not true.
- No API key.
- No model.
- No agent assignment.
- No inference adapter/client.
- No request was transmitted.

The policy now refuses:
- disabled OpenRouter;
- missing key;
- missing model;
- anything that is not an exact model id ending `:free`, including `openrouter/free`;
- known billable ids such as `openai/gpt-4:free`;
- a valid exact free model with no agent assignment.

This cannot be completed from code alone without credentials and an assignment decision.

---

## 6. Actual provider assignment for each agent

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

Chief's deterministic orchestration and persisted-task delegation are unchanged.

---

## 7. Which agents still use Ollama

**No agent uses Ollama as its primary provider.**

Loopback Ollama remains the final fallback for every agent only after the assigned free provider and the other verified free provider are unavailable. It is not silently substituted; fallback is recorded with `fallback_from` and a reason.

The last production task before restart used `ollama/llama3.2:3b` because the running process still had the old external blocks. After restart, the configured Gemini/FreeLLMAPI routes will be eligible.

---

## 8. Free-tier verification method by provider

| Provider | Method |
|---|---|
| Gemini text/vision | Explicit owner attestation + key present + flash-class model + quota/billing failure blocking. Not provider-issued billing evidence. |
| FreeLLMAPI | Explicit owner attestation + complete gateway config + one pinned, allowlisted, non-billable model + quota/billing failure blocking. Not provider-issued billing evidence. |
| Gemini Live | Separate owner attestation + key/model preflight + published free-tier Live model + token mint. |
| OpenRouter | No verification possible because no credential/model/assignment exists. Exact `:free` validator is implemented; paid/dynamic routes are refused. |
| Ollama | Loopback endpoint + installed model; local, no external spend. |

Strict provider evidence remains the preferred path when supplied. If evidence is present but malformed or expired, the provider fails closed; it does **not** silently fall back to owner attestation.

---

## 9. Real inference vs mocked tests

### Real requests (successful)

- Gemini `gemini-3.6-flash`: HTTP 200, text `OK.`, usage 13/2/15.
- FreeLLMAPI `gpt-oss-20b`: HTTP 200, resolved `openai/gpt-oss-20b`, text `OK`, usage 85/40/125.
- Gemini Live: real ephemeral token and constrained session URL for Chief/Charon.
- FreeLLMAPI `/v1/models`: 316 models, pinned model present.
- Ollama `/api/tags`: 200, both models installed.

### Mocked/deterministic tests

- 579 total tests; 575 passed; 4 skipped; 0 failed.
- The six new tests use a mocked fetch boundary to verify selection, attribution, missing/malformed attestation, paid-model blocking and unchanged assignments.
- No mocked test is presented as a real provider success.

### OpenRouter

No real test was possible; no credential exists. No mock is presented as operational.

---

## 10. Evidence that paid models and paid fallbacks are blocked

- `AI_BUDGET_LIMIT_CHF=0`, `AI_ALLOW_PAID_MODELS=false`, `AI_ALLOW_BILLING_FALLBACK=false`.
- Adversarial test configuration set budget 1000, paid flags true, OpenRouter credits/auto-recharge true, and `GEMINI_PAID_AUTHORISED=true`; policy still returned CHF 0.00 or blocked.
- Gemini pro/ultra ids are refused.
- FreeLLMAPI routing aliases (`auto`, `free-router`, `fusion`, `kilo-auto`) are refused.
- FreeLLMAPI known billable ids (Claude, GPT-4/5, o1/o3/o4, etc.) are refused even if allowlisted.
- OpenRouter requires an exact `:free` model; `openrouter/free` is refused as dynamic and `openai/gpt-4:free` as billable.
- No paid fallback, billing activation, synthetic quota or synthetic cost exists.
- A successful response is recorded with `cost_status=unverified`, never claimed as provider-proven zero cost.
- Quota exhaustion / billing restriction blocks the provider; ordinary rate limits cool down only.

---

## 11. Before/after regression comparison

| Area | Before | After |
|---|---|---|
| Tests | 573 total / 566 pass / 3 fail / 4 skip | 579 / 575 / 0 fail / 4 skip |
| Typecheck | 0 | 0 |
| Build | 0 | 0 |
| Gemini text | UNVERIFIED / blocked | available / owner-attested |
| FreeLLMAPI | UNVERIFIED / blocked | available / owner-attested |
| Gemini Live | available / owner-attested | available / owner-attested |
| OpenRouter | blocked / unconfigured | blocked / unconfigured |
| Eight agents | 8 online | 8 online |
| Assignments | 6 Gemini, 2 FreeLLMAPI | unchanged |
| Chief delegation | unchanged | unchanged |
| Recruitment schedule | 12:00 daily, next 26 Nov | unchanged |
| Submission safeguards | unchanged | unchanged |
| DB integrity/schema | ok / 26 / 40 tables | ok / 26 / 40 tables |
| Provider usage | 162 | 162 (production; real checks used temp DB) |
| Health | operational | operational |

The three baseline failures were date-rollover test defects, corrected with relative/far-future timestamps. No assertions were weakened or removed.

---

## 12. Test, typecheck, build and database results

```text
npm test:        tests 579, pass 575, fail 0, skipped 4, exit 0
npm run typecheck: exit 0
npm run build:     exit 0

SQLite PRAGMA integrity_check: ok
PRAGMA foreign_key_check: no rows
PRAGMA user_version: 26
Tables: 40
```

Focused provider/Gemini/scheduler suite: 89 tests, 85 passed, 4 skipped, 0 failed.

Database counts unchanged: users 1, jobs 66, applications 5, documents 40, recruitment runs 14, tasks 92, workflows 14, provider usage 162.

No schema migration, reset or production provider write was performed.

---

## 13. Remaining configuration steps requiring your involvement

### OpenRouter

To make OpenRouter operational, all of the following are genuinely required:

1. Add `OPENROUTER_ENABLED=true`.
2. Add a valid `OPENROUTER_API_KEY`.
3. Set `OPENROUTER_MODEL` to an exact free model id ending in `:free` (not `openrouter/free`).
4. Decide which of the eight agents should be assigned OpenRouter.
5. Add an OpenRouter inference adapter and route candidate; the current repository has none. This was not invented because no credential or assignment exists.

Until then, OpenRouter stays `BLOCKED — FREE-TIER ACCESS UNAVAILABLE`; no request is transmitted.

### Restart

The long-running production supervisor and dev server are still serving the pre-change code. I did **not** restart them, per your instruction. The current production supervisor command is:

```text
node scripts/production-runtime.mjs --supervise
```

Restart it through your normal service manager, or stop it and use the repository's production start command. The development server is `next dev`; restart it with `npm run dev` if that is your active UI.

Until that restart, the UI will continue to show the old blocked provider state even though the new build and direct calls pass.

### Billing evidence

Provider-issued billing evidence was **not** fabricated. Gemini and FreeLLMAPI are owner-attested. If you require machine-verified billing, the remaining step is an OAuth/ADC principal with the relevant Google project/billing permissions; that was outside this repair and is not required for the owner-attested free-tier path.

---

## Final status summary

```text
Gemini:      CONFIGURED — OWNER-ATTESTED FREE TIER (real inference verified)
FreeLLMAPI:  CONFIGURED — OWNER-ATTESTED FREE TIER (real inference verified)
Gemini Live: CONFIGURED — OWNER-ATTESTED FREE TIER (real token mint verified)
OpenRouter:  BLOCKED — FREE-TIER ACCESS UNAVAILABLE (no key/model/assignment/adapter)
Ollama:      LOCAL — AVAILABLE (fallback only)
Spend cap:   CHF 0.00 (enforced)
```

No commit, push, deployment or restart was performed.
