# Gemini Live free-tier evidence audit

Date: 24 November 2026, 19:05 Europe/Zurich
Scope: `GEMINI_FREE_TIER_EVIDENCE`, the Gemini Live pre-transmission gate, Google's account/project evidence surfaces, and the CHF 0.00 policy.
Final status: **BLOCKED — PROVIDER EVIDENCE UNAVAILABLE**

## 1. Executive finding

The local error is not a bug in the gate. `.env` contains a Gemini API key, declares `GEMINI_FREE_TIER_VERIFIED=true`, and leaves `GEMINI_FREE_TIER_EVIDENCE` empty. The Live gate therefore returns:

```text
Gemini Live provider evidence is not sufficient: GEMINI_FREE_TIER_EVIDENCE is empty.
A provider-issued evidence record is required; an operator declaration alone is not accepted.
No microphone audio is transmitted.
```

Google does not expose a supported API that returns a signed, project-specific attestation of **free-tier eligibility plus remaining free quota** for the Gemini Developer API / Live API. The available project-level checks are insufficient:

- Cloud Billing can report whether a known project has billing enabled, but not whether the Gemini account is on the free tier or how much free quota remains.
- Cloud Quotas exposes quota metadata and limits, not an authoritative remaining free-tier allowance or a signed eligibility record.
- AI Studio displays active limits and usage to a human; the official billing and rate-limit documentation does not provide an API-issued attestation that can be bound to this app's `GEMINI_API_KEY`.
- The Gemini API key does not return the owning project ID or a credential identity that can be checked by this server.

Filling `GEMINI_FREE_TIER_EVIDENCE` with a hand-written JSON record would only convert an operator declaration into something the current validator labels "provider evidence". That would weaken the CHF 0.00 policy. It was not done.

## 2. Local configuration and root cause

Checked without printing credential values:

| Setting | State |
| --- | --- |
| `GEMINI_API_KEY` | present |
| `GEMINI_FREE_TIER_VERIFIED` | `true` |
| `GEMINI_FREE_TIER_EVIDENCE` | empty |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` |
| `GEMINI_PAID_AUTHORISED` | set, but deliberately ignored |
| `OLLAMA_ENABLED` | `true` |

A direct runtime status read produced:

```json
{
  "state": "unverified",
  "allowed": false,
  "model": "gemini-3.8-live",
  "evidence_reference": null,
  "detail": "Gemini Live provider evidence is not sufficient: GEMINI_FREE_TIER_EVIDENCE is empty. A provider-issued evidence record is required; an operator declaration alone is not accepted.. No microphone audio is transmitted."
}
```

Root cause: the required provider-issued record cannot truthfully be produced with the interfaces Google currently exposes. The gate is correctly rejecting an absent record, but the implementation has no legitimate provider source from which to obtain one.

## 3. Official provider surfaces examined

### Gemini billing and tiers

Google's [Gemini API billing documentation](https://ai.google.dev/gemini-api/docs/billing) describes the Free tier as an active project or free trial, with access to certain models up to free-tier rate limits. Linking an active billing account moves the project to Tier 1 and permits charges. Billing tier, limits and caps are determined at the billing-account level.

This proves that billing activation can create a paid path. It does **not** provide a project-specific free-tier attestation.

### Rate limits and quota usage

Google's [rate-limits documentation](https://ai.google.dev/gemini-api/docs/rate-limits) states that limits are applied **per project, not per API key**, and directs operators to AI Studio to view active rate limits. Requests-per-day quotas reset at midnight Pacific time. The documentation describes limits, not a signed attestation or remaining-quota API.

A Gemini API key therefore cannot be used to prove which project it belongs to, nor to retrieve that project's current free-tier consumption.

### Live model pricing

Google's [Gemini Developer API pricing page](https://ai.google.dev/gemini-api/docs/pricing) lists `gemini-3.8-live` with a Free Tier input/output price of **Free of charge**, alongside paid-tier prices. This is a model-level published price. It does not prove that this account has access, that the project is on the Free tier, or that free quota remains.

### Cloud Billing API

The official [`projects.getBillingInfo`](https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo) method returns `ProjectBillingInfo` for a known project, including `projectId` and `billingEnabled`. It requires OAuth credentials with `cloud-billing`, `cloud-billing.readonly` or `cloud-platform` scope and permission to view the project.

This is a genuine provider-issued project check, but:

- It requires an OAuth identity and a known project ID; the Gemini API key does not supply either.
- It proves only that billing is enabled or disabled. It does not prove free-tier eligibility, that the Live API operation is covered, or that free quota remains.
- It is not a signed attestation record that can be embedded in the current environment schema.

A billing-disabled check would reduce paid risk, but it would not satisfy the requested free-tier and remaining-allowance requirements by itself.

### Cloud Quotas API

The [Cloud Quotas API overview](https://docs.cloud.google.com/docs/quotas/api-overview) describes listing and managing project quota metadata and quota preferences. It does not provide an authoritative current free-tier consumption ledger or a provider attestation binding a model, credential and remaining free allowance.

## 4. What the current validator accepts

`lib/free-tier.ts` reads a JSON object from `GEMINI_FREE_TIER_EVIDENCE` and requires:

| Field | Required value/rule |
| --- | --- |
| `source` | `provider_api` or `provider_console` |
| `provider` | `gemini` or `google` |
| `account` | non-empty string |
| `model` / `models` | includes the exact requested model |
| `billing` | `disabled`, `not_enabled` or `free_only` |
| `free_tier` | `true` |
| `hard_cap` | `true` |
| `quota_status` / `quota_remaining` | `available`/`remaining`, or a positive number |
| `verified_at` | valid timestamp, no more than 24 hours old, not more than 60 seconds in the future |
| `expires_at` | valid future timestamp |
| `evidence_reference` | HTTP(S) URL on `ai.google.dev`, `*.google.com` or `*.googleapis.com` |

The schema has **no** `project_id`, `credential_id`, provider signature, nonce, or verifiable provider response. `source`, `account`, `billing`, `free_tier`, `hard_cap` and `quota_remaining` are asserted booleans/strings, not values returned by a provider and checked by this server. A hand-written record with a Google-domain reference is structurally accepted. This is a material limitation, not provider verification.

## 5. Pre-transmission path

`lib/live-voice.ts` calls `geminiLiveFreeTierStatus()` through `authorizeAiRequest()` before `ai.authTokens.create()`. The Google token request is made only after the policy decision is allowed. `markPolicyNetworkTransmitted()` is called immediately before that token request, for audit attribution.

A blocked decision therefore:

1. never mints an ephemeral Live token;
2. never returns a `wsUrl` to the browser;
3. never opens a Gemini Live WebSocket;
4. never gives the browser a route on which to send microphone audio.

`GEMINI_PAID_AUTHORISED` is not consulted for authorization. No paid model, endpoint or voice fallback is selected. Text routing remains separate and can use loopback Ollama when external free tiers are unverified.

## 6. Changes made

- Added `tests/gemini-live-evidence-audit.test.ts` with mocked network boundaries and explicit fixture labelling.
- No change was made to the production authorization gate, model allowlist, CHF 0.00 cap, voice identity, agent roster, scheduler or database.
- No evidence record was invented, no environment value was changed, and no provider request was made.
- The existing test fixture helper remains a test double only and is not evidence for a live account.

## 7. Test results

Focused audit:

```text
tests 17
pass 13
fail 0
skipped 4
```

Full regression:

```text
tests 567
pass 563
fail 0
skipped 4
duration 33.4s
```

TypeScript: `npm run typecheck` exit 0.

| # | Scenario | Result |
| --- | --- | --- |
| 1 | Valid provider-issued evidence | **SKIPPED — no genuine record available** |
| 2 | Missing evidence | **PASS** — blocked, no fetch |
| 3 | Operator-only declaration | **PASS** — blocked, no fetch |
| 4 | Invalid/forged evidence | **PARTIAL** — invalid JSON and wrong-domain records rejected; a fabricated Google-domain record is not cryptographically distinguishable |
| 5 | Expired evidence | **PASS** — blocked, no fetch |
| 6 | Wrong project or credential identity | **SKIPPED** — schema has no project/credential field to validate |
| 7 | Unsupported or paid model | **PASS** — blocked, no fetch |
| 8 | Exhausted free quota | **PASS** — blocked, no fetch |
| 9 | Unavailable provider evidence endpoint | **SKIPPED** — no provider evidence endpoint exists; evidence is read from env JSON |
| 10 | Provider authentication failure | **PASS (mocked)** — attempt fails, no fallback, no session |
| 11 | Evidence changing between sessions | **PASS** — re-read; removal blocks the next attempt |
| 12 | Attempted paid fallback | **PASS** — legacy paid flag cannot authorize or transmit |
| 13 | No microphone audio when blocked | **PASS** — no token, no WebSocket URL, no Google request |
| 14 | Live succeeds only with genuine verification | **NOT ACHIEVED** — real provider evidence unavailable |
| 15 | Text remains operational while Live is blocked | **PASS (mocked)** — loopback Ollama served text |

The four skipped tests are not counted as passes. They identify capabilities that cannot be honestly verified with the available provider interfaces.

## 8. Network and cost evidence

- Blocked Live tests recorded `fetchCalls = 0`; no `auth_tokens` request, WebSocket URL or Live session exists.
- The only mocked Google request is the explicit authentication-failure test, which returns 401 before any session reaches the browser.
- Text fallback test contacted only `127.0.0.1:11434` through the mocked fetch boundary.
- No real Google endpoint, paid model, paid endpoint or external provider was contacted.
- No microphone audio was captured or transmitted. The browser never receives a Live session when the gate blocks.

## 9. Risk assessment

The current state is safe for CHF 0.00 but incomplete for free voice:

- **Safe:** empty evidence blocks Live before token minting and microphone transmission.
- **Unsafe assumption:** filling the JSON record by hand would create a green status without provider proof.
- **Unresolved:** billing can be activated after a record is created; the current static schema cannot revalidate that with Google.
- **Unresolved:** the API key cannot be bound to a project or credential identity.
- **Unresolved:** there is no authoritative remaining free-quota source.
- **Unresolved:** a forged Google-domain evidence record is structurally accepted.

Gemini Live must remain blocked until Google provides, or this app implements with official OAuth-backed interfaces, all of the following:

1. Project-specific billing/tier evidence for the project that owns the Gemini credential.
2. A supported current free-tier allowance or usage source.
3. A binding between the Live API key/credential and that project.
4. Freshness and revocation handling before each new Live session.
5. A verifiable provider response or signature that an operator cannot fabricate.

## 10. Final status

**BLOCKED — PROVIDER EVIDENCE UNAVAILABLE**

The local error is the CHF 0.00 protection working as designed. Gemini Live is not restored. Text interaction remains available through the existing local fallback, and all eight agents, voice identities, routing, recruitment safeguards and the 12:00 Europe/Zurich schedule remain unchanged.
