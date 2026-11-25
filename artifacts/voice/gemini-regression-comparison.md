# Gemini Live — Before/After Regression Comparison

**Baseline:** `artifacts/voice/gemini-before-regression-snapshot.md`  
**After:** `artifacts/voice/gemini-after-regression-snapshot.md`  
**Scope:** Gemini Live only. All comparisons are from the recorded snapshots, not assumptions.

---

## 1. Tests

| Check | Before | After | Difference |
|---|---:|---:|---|
| Total tests | 567 | 573 | +6 new Gemini attestation tests |
| Passed | 563 | 569 | +6 |
| Failed | 0 | 0 | none |
| Skipped | 4 | 4 | unchanged real-provider placeholders |
| Exit | 0 | 0 | pass |

Focused Gemini tests after implementation: **30 tests, 26 passed, 4 skipped, 0 failed**.  
Focused agent routing/presentation/topology/operations tests: **24 passed, 0 failed**.

No pre-existing failure was hidden or reclassified. No test was skipped to make the change pass.

---

## 2. Typecheck and build

| Check | Before | After |
|---|---|---|
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run build` | exit 0 | exit 0 |

The first implementation run exposed a TypeScript narrowing error in the new preflight parser. It was fixed before completion; the final typecheck and build are both exit 0.

---

## 3. Eight-agent roster and availability

| Agent | Before | After |
|---|---|---|
| Chief (`coordinator`) | enabled, completed, online | enabled, completed, online |
| Saffa (`research`) | enabled, completed, online | enabled, completed, online |
| Ali (`analysis`) | enabled, completed, online | enabled, completed, online |
| Kora (`cv`) | enabled, completed, online | enabled, completed, online |
| Kali (`ats`) | enabled, completed, online | enabled, completed, online |
| Amira (`cover`) | enabled, completed, online | enabled, completed, online |
| Noor (`application`) | enabled, failed history, online | enabled, failed history, online |
| Rayna (`email`) | enabled, completed, online | enabled, completed, online |

No agent was added, removed, renamed, disabled, re-voiced or re-routed. Noor's stored failure is the same pre-existing submission-form limitation.

---

## 4. Coordinator and agent communication

Before and after, the full suite covered the existing Coordinator, routing, handoff, presentation, topology and agent operations paths. The after-state additionally ran 24 focused agent communication tests, all passing.

No routing table, agent definition, conversation-history path or tool declaration was changed. The only Live change is the authorization/preflight path before token minting.

**Result: unchanged.**

---

## 5. Recruitment schedule and next run

| Item | Before | After |
|---|---|---|
| Recruitment clock | 12:00 Europe/Zurich, Monday–Sunday | same |
| Recruitment enabled | yes | yes |
| Next recruitment | 2026-11-25T11:00:00.000Z (25 Nov, 12:00) | same |
| Last recruitment status | completed | completed |
| Latest run | `run_b344b98b1706f31bf45408df` | same |
| Brief clock | 16:00 Europe/Zurich, Monday–Friday | same |
| Next brief | 2026-11-25T15:00:00.000Z | same |

No scheduler, recruitment policy, run or submission was changed or triggered.

---

## 6. Database integrity and schema

| Check | Before | After |
|---|---|---|
| `PRAGMA integrity_check` | ok | ok |
| Foreign-key violations | none | none |
| Schema version | 26 | 26 |
| Tables | 40 | 40 |
| Users / jobs / applications | 1 / 66 / 5 | 1 / 66 / 5 |
| Documents / runs / tasks | 40 / 13 / 88 | 40 / 13 / 88 |
| Workflows / agent sessions | 13 / 7 | 13 / 7 |

The successful Live check added intended policy/session/settings rows only. It did not alter the schema, recruitment data or any application/document record.

---

## 7. Application health

| Check | Before | After |
|---|---|---|
| Overall status | operational | operational |
| Database | ok, schema 26 | ok, schema 26 |
| Scheduler worker | running | running |
| Background workers | all running | all running |
| Registered agents | 8 | 8 |
| Active tasks | 0 | 0 |
| Failed tasks today | 4 | 4 |
| Notification failures | 2 | 2 |
| Next recruitment | 25 Nov 2026, 12:00 | 25 Nov 2026, 12:00 |

The same pre-existing notification failures and failed-task history remain; no new health or queue failure appeared.

---

## 8. Existing functionality

The full suite passed both before and after. The changed surface is limited to:

- Gemini Live free-tier status and attestation
- Gemini Live key/model preflight
- Gemini Live session token construction
- focused Gemini tests and env documentation

No authentication, RBAC, database schema, recruitment, scheduler, application automation, Gmail, dashboard, agent identity, voice assignment, conversation history or UI component was changed.

---

## 9. Gemini voice functionality

### Before

```text
state: unverified
allowed: false
error: Gemini Live provider evidence is not sufficient:
GEMINI_FREE_TIER_EVIDENCE is empty...
```

No token was minted, no session URL returned and no microphone audio could be transmitted.

### After

```text
state: available
allowed: true
verification_source: owner_attestation
model: gemini-3.8-live
voice: Charon
apiVersion: v1beta
```

Real provider checks performed with the existing key:

- Models list: `200`, exact model present
- Model get: `200`, `bidiGenerateContent`
- Ephemeral token: minted
- Session setup: Chief / Charon, constrained `wss://` URL

No microphone audio was transmitted by the verification. The browser socket still needs to be exercised after the running server is restarted.

---

## 10. Files changed and why

| File | Change | Why necessary |
|---|---|---|
| `lib/free-tier.ts` | Added opt-in `GEMINI_LIVE_FREE_TIER_ATTESTATION=owner_confirmed` path when the evidence field is empty; retained strict provider-evidence path and all model/quota checks | The existing key is valid and Live-capable, but Cloud Billing/API Keys reject API-key auth. The owner explicitly confirmed the free tier; this records that fact without fabricating provider evidence. |
| `lib/live-voice.ts` | Added read-only key/model preflight before token mint; preserved authorization, no-paid fallback and token failure handling | Proves the configured key reaches the exact Live model and that it supports `bidiGenerateContent` before a session URL is returned. |
| `tests/gemini-live-attestation.test.ts` | Added 6 focused tests for attestation, opt-in behavior, flag/model guards, malformed evidence and preflight failure | Prevents the new path from becoming a blanket bypass. |
| `.env.example` | Documented the Live-only attestation and clarified text/vision evidence requirement | Keeps configuration honest and reproducible. |
| `deploy/env.production.example` | Same documentation for deployment | Prevents accidental silent activation elsewhere. |
| `.env` | Added `GEMINI_LIVE_FREE_TIER_ATTESTATION=owner_confirmed` (local, untracked) | Activates the owner-confirmed path for this local app. |
| `artifacts/voice/*` | Snapshots, comparison and restoration report | Required audit trail. |

Pre-existing modifications in `lib/live-voice.ts`, `.env.example` and `deploy/env.production.example` were preserved; this task's added lines are the attestation/preflight changes only.

---

## 11. Regressions and residual limitation

**New regressions found:** none.

**Pre-existing conditions, separately identified:** 4 skipped real-provider tests, 2 failed notification-outbox rows, 4 failed tasks today, Noor's historical submission failure, and earlier failed recruitment runs. None changed as a result of this task.

**Residual limitation:** billing status is **owner-attested**, not machine-verified. The configured key is an `AQ.` authorization key; Google's Cloud Billing and API Keys APIs returned `401` for API-key authentication and require an OAuth principal. The app therefore cannot independently prove the project has no billing account with the current credentials.

This limitation is asserted plainly in the runtime status text and the restoration report. The app still enforces the free-tier declaration, published-free Live model allowlist, real key/model preflight, quota/billing failure blocking and no paid fallback. It does not claim provider-issued billing evidence.

**Activation limitation:** the already-running port-3000 server must be restarted to load the new code and `.env`. The after snapshot did not stop or restart it.
