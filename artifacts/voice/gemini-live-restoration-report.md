# Gemini Live Restoration Report

**Date:** 2026-11-24  
**Scope:** Gemini Live only. No deployment, commit, push, scheduler change or recruitment change.

---

## Status

**Restored at the server boundary.** The existing `GEMINI_API_KEY` now passes the Live authorization gate, a real key/model preflight, and a real ephemeral-token mint for **Chief / Charon** on `gemini-3.8-live`.

The existing long-running port-3000 process must be restarted to load the new build and `.env` value. It was deliberately not stopped or restarted.

---

## Exact cause

`geminiLiveFreeTierStatus()` required a non-empty `GEMINI_FREE_TIER_EVIDENCE` JSON record:

```text
Gemini Live provider evidence is not sufficient:
GEMINI_FREE_TIER_EVIDENCE is empty. A provider-issued evidence record is
required; an operator declaration alone is not accepted.
```

The configured key was valid, but Google rejects API-key authentication on both Cloud Billing and API Keys:

```text
401 API keys are not supported by this API. Expected OAuth2 access token...
```

There is no OAuth/ADC project identity in this environment, so a real provider-issued billing record could not be obtained without inventing one.

---

## Fix

1. Added an explicit, opt-in Live-only owner attestation:
   ```text
   GEMINI_LIVE_FREE_TIER_ATTESTATION=owner_confirmed
   ```
   It applies only when `GEMINI_FREE_TIER_EVIDENCE` is empty. Malformed or invalid evidence still fails closed; text and vision still require provider evidence.

2. Added a real key/model preflight before every owner-attested token mint:
   - `GET /v1beta/models/{model}` with the existing key
   - exact model-name match
   - `bidiGenerateContent` required
   - failure blocks before `authTokens.create()`

3. Preserved:
   - `GEMINI_FREE_TIER_VERIFIED=true` requirement
   - published-free Live model allowlist
   - `GEMINI_PAID_AUTHORISED` ignored
   - no paid models, fallback or provider substitution
   - quota/billing failure blocking
   - existing text/vision evidence gate
   - all eight agents, voices, routing, conversation history, UI, database, scheduler and recruitment behavior

---

## Real provider evidence

Using the existing key:

- Models list returned `200`; `models/gemini-3.8-live` listed with `bidiGenerateContent`.
- Model get returned `200`; exact model and `bidiGenerateContent`.
- Real ephemeral Live token minted successfully.
- `createLiveSession()` returned a constrained `wss://generativelanguage.googleapis.com/...` URL and Chief/Charon setup.
- Token and URL were not recorded.

No microphone audio or WebSocket media was transmitted during verification.

---

## Files changed

- `lib/free-tier.ts` — Live-only owner attestation; strict evidence path retained
- `lib/live-voice.ts` — key/model preflight before token mint; fail-closed error handling
- `tests/gemini-live-attestation.test.ts` — new focused tests
- `.env.example` — documented the attestation
- `deploy/env.production.example` — documented the attestation
- `.env` — local `GEMINI_LIVE_FREE_TIER_ATTESTATION=owner_confirmed`
- `artifacts/voice/` — before/after snapshots, comparison, this report

---

## Checks actually run

| Check | Result |
|---|---|
| Focused Gemini tests | 30 tests, 26 passed, 4 skipped, 0 failed |
| Full suite | 573 tests, 569 passed, 4 skipped, 0 failed |
| Agent routing/presentation/topology/operations | 24 passed, 0 failed |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| SQLite integrity | `ok` |
| Foreign-key check | no violations |
| Schema version | 26, unchanged |
| Eight-agent roster | 8 enabled, 8 online, unchanged |
| Recruitment schedule | 12:00 Europe/Zurich daily, next 25 Nov 2026 12:00, unchanged |
| Application health | operational, workers running |

---

## Remaining blocker / limitation

**Billing is owner-attested, not machine-verified.** The key is an `AQ.` authorization key. Cloud Billing and API Keys returned `401` because they require OAuth, not an API key. The runtime text says this explicitly; it does not claim provider-issued billing evidence.

If machine-verified billing is required, the Google-side step is:

1. Create a dedicated service account or use ADC.
2. Grant it `apikeys.keys.lookup` and `resourcemanager.projects.get` on the Gemini project.
3. Configure `GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_LIVE_PROJECT_NUMBER` and `GEMINI_LIVE_PROJECT_ID`.
4. Implement the `keys.lookupKey` + `projects.getBillingInfo` verifier.

That is optional hardening for this owner-attested path, not a prerequisite for the key/model functionality verified here.

**Activation:** restart the existing app process to load the new build and `.env`. Browser microphone/WebSocket audio remains to be exercised after that restart.
