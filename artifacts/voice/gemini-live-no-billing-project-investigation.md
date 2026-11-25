# Gemini Live on a Billing-Disabled Google AI Studio Project

**Status:** Investigation complete; no production code or configuration changed  
**Date:** 2026-11-24  
**Scope:** `gemini-3.8-live` via the Gemini Live API, with the existing Gemini provider and agent voices preserved  
**Cost boundary:** CHF 0.00; billing must never be enabled, and no paid fallback is permitted

---

## 1. Recommendation

### **GO — conditional**

A dedicated Google AI Studio / Gemini API project with **no billing account at all** can provide an enforceable account-level CHF 0.00 boundary, provided the application verifies all of the following before minting a Live session token:

1. The configured Gemini API key resolves, through Google's official API Keys API, to the exact dedicated project number.
2. The dedicated project has **no billing account**: `billingEnabled == false` **and** `billingAccountName` is blank.
3. The billing response reports the exact configured project ID.
4. `gemini-3.8-live` is free-tier eligible and the Live API version is supported.
5. Any missing value, permission error, timeout, 403, 429, 5xx, billing change, or ambiguous response **blocks the microphone and the session**.

This is **not** a GO for immediate activation. It is a GO for a controlled implementation and a read-only preflight against a real dedicated project. The current production gate remains unchanged and must remain blocked until that preflight passes.

### What would make this **NO-GO**

Stop and keep Live blocked if any of these is true:

- Google refuses `apikeys.googleapis.com` or `cloudbilling.googleapis.com` calls from a project with no billing account, after a legitimate preflight.
- The API key cannot be authoritatively resolved to the dedicated project.
- The project cannot be shown to have **no billing account** (not merely `billingEnabled == false`).
- `gemini-3.8-live` is not available on the free tier for the project/account/region.
- The only way to make the checks work is to attach billing to the Gemini project or to use a billing-enabled project as the Gemini data path.

Do **not** treat a CHF 0 budget, a spending limit, or a prepaid credit as a substitute. Budgets alert; they do not cap spend. A billing account must be absent.

---

## 2. Official documentation reviewed

| Source | What it establishes |
|---|---|
| [Gemini API pricing — Live API](https://ai.google.dev/gemini-api/docs/pricing) | `gemini-3.8-live` has a published Free Tier price of **“Free of charge”** for the relevant input/output rows. Free-tier eligibility is model-level and still subject to project/account eligibility and quotas. |
| [Gemini API billing](https://ai.google.dev/gemini-api/docs/billing) | Gemini API keys are tied to a Google Cloud project; usage is charged to that project's billing account. There is no separate Gemini wallet that makes a key independent of project billing. |
| [Gemini API terms](https://ai.google.dev/gemini-api/terms) | Paid services are the services available with a linked billing account. The free tier is a separate service offering. |
| [Live API — ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) | Ephemeral tokens are the supported way to start a Live session without exposing the long-lived API key to the client. They are short-lived and scoped to Live. |
| [Gemini API versions](https://ai.google.dev/gemini-api/docs/api-versions) | Live API and ephemeral tokens are supported in `v1beta`, which is the version the application already uses. |
| [API Keys API — `keys.lookupKey`](https://docs.cloud.google.com/api-keys/docs/reference/rest/v2/keys/lookupKey) | Official OAuth-only endpoint: `GET https://apikeys.googleapis.com/v2/keys:lookupKey?keyString=...`. Returns the key's `parent` project and resource `name`. Requires `apikeys.keys.lookup` on the parent project. |
| [API Keys IAM roles](https://docs.cloud.google.com/iam/docs/roles-permissions/serviceusage) | `roles/serviceusage.apiKeysViewer` contains `apikeys.keys.lookup`; least-privilege custom roles can grant only that permission. |
| [API Keys pricing](https://cloud.google.com/api-keys/pricing) | The API Keys API is documented as free of charge. |
| [Cloud Billing API — `projects.getBillingInfo`](https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo) | Official endpoint: `GET https://cloudbilling.googleapis.com/v1/projects/{project}/billingInfo`. Returns `billingEnabled`, `billingAccountName` and `projectId`. Requires `resourcemanager.projects.get` on the project. |
| [Cloud Billing `ProjectBillingInfo`](https://docs.cloud.google.com/billing/docs/reference/rest/v1/ProjectBillingInfo) | `billingEnabled` is false when the project has a closed billing account **or no billing account at all**, and therefore cannot use paid services. `billingAccountName` blank means no billing account. |
| [Verify billing is enabled](https://docs.cloud.google.com/billing/docs/how-to/verify-billing-enabled) | The documented check uses `billingEnabled`; a blank `billingAccountName` means there is no Cloud Billing account. |
| [Create or modify a project's billing](https://docs.cloud.google.com/billing/docs/how-to/modify-project) | New AI Studio projects can be created without linking a billing account and begin on the free tier; disabling billing downgrades AI Studio usage to the free tier. |
| [Cloud Billing API pricing](https://cloud.google.com/billing/v1/pricing) | The Cloud Billing API is documented as free. |
| [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) | Limits are applied per project, not per API key. Exhaustion produces `429`; a project with no billing account cannot be charged for overage. |

### Documentation caveat that must not be hidden

The API Keys “Get started” page includes a generic instruction to verify that billing is enabled before enabling the API. That page is written for the general API Keys product, while the API Keys pricing page states that the API is free. **It is not proven from documentation alone that a project with no billing account can enable and call the API Keys and Cloud Billing APIs.** That is why this report recommends a real read-only preflight before any code is wired to the gate. If the preflight fails, the recommendation becomes **NO-GO**; a billing-enabled verifier project must not be used to bypass the boundary.

---

## 3. Technical findings

### 3.1 The billing-disabled project is the right control point

A Gemini API key inherits the billing relationship of its parent Google Cloud project. Therefore the reliable question is not “does this key look free?” but:

> **Which project owns this key, and does that project have a billing account?**

`keys.lookupKey` answers the first half authoritatively. `projects.getBillingInfo` answers the second. Both are official, read-only metadata calls.

### 3.2 `billingEnabled == false` alone is insufficient

`ProjectBillingInfo.billingEnabled` is false in two different situations:

- no billing account at all; or
- a billing account is linked but closed/suspended.

The second case may leave the project unable to use free services and may be reactivated by the owner. The application must therefore require **both**:

```text
billingEnabled === false
billingAccountName === ""
```

A non-empty `billingAccountName` with `billingEnabled === false` must block, not pass.

### 3.3 The key lookup is authoritative and OAuth-only

`keys.lookupKey` is not callable with the Gemini API key itself. It requires an OAuth 2.0 access token and the `apikeys.keys.lookup` permission on the key's parent project.

Documented shape:

```http
GET https://apikeys.googleapis.com/v2/keys:lookupKey?keyString=REDACTED
Authorization: Bearer REDACTED
```

```json
{
  "parent": "projects/123456789012/locations/global",
  "name": "projects/123456789012/locations/global/keys/abc123..."
}
```

Controls:

- Parse `parent` strictly as `projects/{number}/locations/global`.
- Require the number to equal `GEMINI_LIVE_PROJECT_NUMBER`.
- Require `name` to be non-empty and to share the same parent.
- If the key was deleted or purged, or the response is ambiguous, block.
- Do not infer the project from the key prefix or from a cached value.

### 3.4 Billing is checked independently

Use the project ID for the billing path and verify the response:

```http
GET https://cloudbilling.googleapis.com/v1/projects/{projectId}/billingInfo
Authorization: Bearer REDACTED
```

```json
{
  "name": "projects/example-project/billingInfo",
  "projectId": "example-project",
  "billingAccountName": "",
  "billingEnabled": false
}
```

Require:

- `projectId === GEMINI_LIVE_PROJECT_ID`;
- `billingEnabled === false`;
- `billingAccountName === ""` (missing or blank, never a non-empty account);
- the lookup's project number equals `GEMINI_LIVE_PROJECT_NUMBER`.

`gcloud beta billing projects describe` accepts a project ID or project number, but the REST verifier should use the configured project ID and separately check the number from the key lookup. Do not silently accept a mismatch.

### 3.5 Free-tier Live is plausible but not guaranteed by model price alone

The Live pricing page lists `gemini-3.8-live` Free Tier as “Free of charge.” The Live API and ephemeral tokens are documented in `v1beta`, matching the current integration. This establishes model-level eligibility, not account-level eligibility.

The following still have to be true at runtime:

- the model is available to the project/account/region;
- the free-tier Live quota is not exhausted;
- the API version still supports ephemeral tokens for that model;
- Google has not changed the free-tier offering.

Any 403, 404, 429 or 5xx must fail closed. There is no paid fallback, no model downgrade to a paid model, and no “try another key” behavior.

### 3.6 No billing account means no paid overage, but not unlimited service

With no billing account, the project cannot use paid services. If free-tier quota is exhausted, the API returns an error (typically 429); it cannot silently bill an overage. The user-visible result is a blocked Live session, not a charge.

The application cannot reliably pre-check remaining Live quota. It should treat 429 as a temporary block, record the reason, and never convert it into a paid request.

### 3.7 Mid-session billing attachment is a residual risk

The gate proves the project state at check time. It does not prevent the project owner from attaching a billing account later or during a session.

Mitigations:

- Recheck billing immediately before minting the ephemeral token.
- Recheck again after minting and immediately before returning the session URL.
- Keep token/session lifetimes short.
- Block on any change at the next check.
- Document that this is detection, not a cryptographic guarantee against a trusted owner who deliberately changes the project mid-session.

A project owner who attaches billing between the final check and audio transmission can create a small exposure window. This cannot be eliminated by application code alone. The boundary is appropriate only if the project is controlled by a trusted operator and billing attachment is itself controlled.

### 3.8 The API key is a secret in a query string

`lookupKey` places `keyString` in the query string by API design. The verifier must ensure that neither the URL nor the key appears in:

- application logs;
- error messages;
- analytics;
- reverse-proxy or CDN logs;
- crash reports;
- test snapshots.

Use a dedicated HTTP client path and redact the full request URL on failure. Never log the `Authorization` header or OAuth token either.

---

## 4. Proposed implementation (not implemented)

### 4.1 Project and identity setup

1. Create a **dedicated** Google AI Studio / Gemini API project. Do not link a billing account.
2. Create a Gemini API key in that project and restrict it to the Generative Language API.
3. Enable only what is needed:
   - `generativelanguage.googleapis.com`
   - `apikeys.googleapis.com`
   - `cloudbilling.googleapis.com`
4. Create a dedicated service account for the verifier, or use operator ADC.
5. Grant a least-privilege custom role on the dedicated project:
   - `apikeys.keys.lookup`
   - `resourcemanager.projects.get`
6. Do not grant project-wide Owner/Editor. Do not put the service-account JSON in the repository.

OAuth scopes for the verifier token:

```text
https://www.googleapis.com/auth/cloud-platform.read-only
https://www.googleapis.com/auth/cloud-billing.readonly
```

`cloud-platform.read-only` covers the API Keys lookup; `cloud-billing.readonly` covers `getBillingInfo`. A single broad `cloud-platform` token is not necessary.

### 4.2 Configuration

Add only after approval:

```text
GEMINI_LIVE_PROJECT_NUMBER=123456789012
GEMINI_LIVE_PROJECT_ID=dedicated-live-project
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/outside/repo/verifier.json
```

Keep the existing `GEMINI_API_KEY` for the Gemini data path. Do not add a second Gemini key or a paid fallback key.

### 4.3 Verifier flow

```text
createLiveSession()
  |
  +-- validate config and model/version
  |
  +-- obtain OAuth token (ADC / service account)
  |
  +-- lookupKey(GEMINI_API_KEY)
  |     +-- parent must equal projects/{PROJECT_NUMBER}/locations/global
  |     +-- name must be non-empty and share the parent
  |
  +-- getBillingInfo(PROJECT_ID)
  |     +-- projectId must match
  |     +-- billingEnabled must be false
  |     +-- billingAccountName must be blank
  |
  +-- mint ephemeral token
  |
  +-- getBillingInfo(PROJECT_ID) again, immediately before returning
  |
  +-- only then return the Live session URL
```

Any failure at any step returns a blocked result. No microphone permission is requested, no session URL is returned, and no token is exposed.

### 4.4 Error handling

| Condition | Result |
|---|---|
| Missing key, project ID/number, or credentials | Block |
| OAuth token unavailable or expired | Block |
| `lookupKey` 401/403 | Block; do not retry with another identity |
| `lookupKey` 404 / empty `name` | Block |
| Malformed `parent` | Block |
| Project number mismatch | Block |
| Billing 401/403 | Block |
| `billingEnabled == true` | Block |
| `billingEnabled == false` but non-empty `billingAccountName` | Block |
| Billing `projectId` mismatch | Block |
| Model not free-tier eligible or Live version unsupported | Block |
| 429 / quota exhausted | Block until reset; no paid fallback |
| 5xx / timeout / network error | Block; no session URL |
| Billing changes between checks | Block; discard the minted token |

### 4.5 Cache and TOCTOU policy

- Do not cache billing status across sessions.
- Do not cache a positive result longer than a single request.
- Revalidate before token mint and after token mint.
- If a cached value is ever used within a request, it must be invalidated on any error.
- A blocked result must never be cached as an allow.

### 4.6 Audit and user-visible behavior

Record a non-secret audit event:

```text
projectNumber=123456789012
projectId=dedicated-live-project
keyResource=projects/.../keys/...
billingEnabled=false
billingAccountPresent=false
model=gemini-3.8-live
result=allowed | blocked
reason=<stable code>
```

Never record `keyString`, the OAuth token, the full lookup URL, or the service-account JSON.

The user should see a clear blocked state such as “Gemini Live is unavailable because the dedicated project’s free-tier billing status could not be verified.” Do not expose raw Google errors or project secrets.

---

## 5. Test evidence

### 5.1 Fail-closed decision matrix

A 13-case simulated matrix was run against the proposed decision logic. It covered:

1. missing project number;
2. missing project ID;
3. missing key;
4. OAuth failure;
5. lookup 403;
6. lookup 404 / deleted key;
7. malformed parent;
8. project number mismatch;
9. `billingEnabled == true`;
10. `billingEnabled == false` with a non-empty billing account (closed/suspended);
11. billing project ID mismatch;
12. model not free-tier eligible;
13. all checks valid, followed by a post-mint billing change.

**Result: 13/13 passed.** All invalid cases blocked before session creation. The valid case allowed only after both billing checks.

### 5.2 Existing repository checks

Run on the current working tree with no production changes for this investigation:

```text
npm test
  tests 567
  pass 563
  fail 0
  skipped 4
  duration 25.05s
  exit 0

npm run typecheck
  exit 0
```

The existing Live gate still blocks locally because `GEMINI_FREE_TIER_EVIDENCE` is empty. That is the expected fail-closed behavior, not a regression.

### 5.3 What was **not** tested

- No Google Cloud project was created for this investigation.
- No billing account was inspected.
- No `lookupKey` or `getBillingInfo` request was sent to Google.
- No `gemini-3.8-live` Live session was opened.
- No paid or free provider call was made.
- The 13/13 matrix is a simulation of the policy, not live provider evidence.

This distinction is deliberate. The report does not claim live verification that was not performed.

---

## 6. Current repository state

- `lib/free-tier.ts` still uses the existing synchronous `geminiLiveFreeTierStatus()` and the static evidence gate.
- `lib/live-voice.ts` calls the authorization gate before `ai.authTokens.create()`; a blocked result does not return a microphone path or session URL.
- `app/api/voice/live/session/route.ts` remains authenticated and returns a Live session only after the gate passes.
- `GEMINI_API_KEY` is present locally.
- `GEMINI_LIVE_PROJECT_NUMBER`, `GEMINI_LIVE_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_PROJECT` are absent.
- `google-auth-library` is not installed.
- The current error is the expected fail-closed message: provider evidence is insufficient because `GEMINI_FREE_TIER_EVIDENCE` is empty; no microphone audio is transmitted.

No production gate, configuration, dependency or credential was changed by this investigation.

---

## 7. Remaining uncertainties

1. **No-billing API access is not live-proven.** Google documents the API Keys and Cloud Billing APIs as free, but the API Keys “Get started” page contains a generic billing prerequisite. A real preflight must prove that both APIs can be enabled and called from the dedicated no-billing project. If they cannot, this is NO-GO.
2. **Account/project/region eligibility for Live is not proven.** Model pricing and `v1beta` support do not guarantee that this specific project can start `gemini-3.8-live` on the free tier. A 403 or 429 must block.
3. **Quota cannot be pre-checked reliably.** The app can only react to 429. It must not convert that into a paid request.
4. **Mid-session billing attachment remains possible.** Rechecks narrow the window but do not eliminate it. The boundary depends on a trusted project owner.
5. **The model is preview/timed.** `gemini-3.8-live` and its free-tier terms can change. The allowlist must fail closed if the model or version changes.
6. **Service-account/ADC lifecycle.** A user ADC session can expire; a service-account key is a long-lived secret. The operational choice must be made before implementation.
7. **Project number/ID binding.** The lookup returns a number; billing returns an ID. The implementation must validate both explicitly. An optional Cloud Resource Manager `projects.get` can add a third binding check if required.
8. **Logging exposure.** The key is in the lookup query string by API design. Any proxy, debug logger or error reporter added later can leak it.
9. **No live evidence yet.** The recommendation is based on official documentation, local code inspection and a simulated matrix, not on an actual Google API response.

---

## 8. Conditions for activation

Proceed from conditional GO to activation only when all of the following exist:

- [ ] Dedicated project confirmed with no billing account (`billingEnabled == false`, blank `billingAccountName`).
- [ ] API key resolved by `lookupKey` to the exact configured project number.
- [ ] `getBillingInfo` returns the exact configured project ID.
- [ ] Both metadata APIs proven callable from the no-billing environment.
- [ ] `gemini-3.8-live` free-tier availability confirmed for the project/account/region.
- [ ] Verifier implemented with the two-scope OAuth token and least-privilege IAM.
- [ ] Pre-mint and post-mint billing checks implemented.
- [ ] All failure paths block before microphone access and session URL return.
- [ ] No paid fallback, no alternate key, no billing-enabled Gemini project.
- [ ] Logs proven not to contain the key, token or full lookup URL.
- [ ] Staging test with a free Live session completed and recorded.
- [ ] Rollback is a configuration disable that returns the app to the current blocked state.

Until every box is checked, the current production gate stays in place and Gemini Live stays blocked.

---

## 9. Bottom line

**GO — conditional implementation, not activation.** The combination of `keys.lookupKey` and `projects.getBillingInfo` gives the application an authoritative, read-only way to bind the Gemini key to a dedicated project and prove that the project has no billing account. That is a materially stronger CHF 0.00 boundary than a static evidence string or a model-price claim.

The unresolved item is operational, not theoretical: whether the API Keys and Cloud Billing APIs are usable from a project with no billing account. That must be proven with a real, read-only preflight. If it cannot be proven, the answer is **NO-GO** and Live remains blocked. No billing account should be enabled to make the check work.
