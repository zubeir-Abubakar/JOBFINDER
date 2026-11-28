# Investigation — Bank Julius Bär application block and Gmail authorization failure

**Date of investigation:** 26 November 2026
**Reported by:** Chief (Coordinator, `agent_key = coordinator`)
**Investigator:** Buffy (read-only forensic review)
**Environment:** AT AI Workforce, branch `main`, database `data/at-ai-workforce.db`
**Method:** read-only SQLite queries (`sqlite3 -readonly`), source inspection, and a single non-mutating OAuth token-endpoint probe. No employer was contacted, no email was sent, no application was submitted, no CAPTCHA was touched, and no commit/push/deploy was performed.

---

## 1. Executive summary

| Item | Finding |
| --- | --- |
| Julius Bär Senior Test Manager application | **BLOCKED — not submitted, not failed, not uncertain.** Prepared documents exist; Noor stopped at the employer's CAPTCHA before any POST. |
| Julius Bär Senior Automation Test Engineer application | **BLOCKED** for the same reason, same run, same cause. |
| Employer submission recorded without confirmation | **None.** `submission_attempts.status = 'blocked'`, `http_status = NULL`, `reference = NULL`; `applications.submitted_at = NULL`. |
| Gmail root cause | **Refresh-token grant is dead.** Google token endpoint returns **HTTP 400 `invalid_grant` — "Token has been expired or revoked."** |
| Gmail API disabled? | **Not the cause** of this failure. An API-disabled condition surfaces as HTTP 403 at the Gmail API, not as `invalid_grant` at the token endpoint. The token endpoint was never successfully passed, so the Gmail API was never reached. |
| Missing OAuth scopes? | **No.** All required scopes were granted at connect time and are stored. |
| Client/project mismatch? | **No evidence.** The token endpoint authenticated this installation's client credentials and then rejected the grant, which proves the client ID/secret match the client that was issued the token (project number `791881214039`). |
| Reconnection required? | **Yes.** Only a fresh authorization-code flow can restore access. Enabling the Gmail API would not do it. |
| Other work affected | 12 notification-outbox items blocked since 24 Nov 15:30Z, including the 25 Nov executive brief and the 4 Julius Bär intervention alerts. In-app records remain intact. |

---

## 2. Evidence sources

- `jobs`, `applications`, `submission_attempts`, `application_events`, `application_interventions`
- `recruitment_runs`, `recruitment_run_agents`, `tasks`, `schedule_jobs`, `agents`, `settings`
- `notification_outbox`, `notifications`, `audit_logs`, `gmail_accounts`
- Source: `lib/gmail.ts`, `lib/gmail-profile.ts`, `lib/submission.ts`, `lib/browser-form.ts`, `lib/candidate-forms.ts`, `lib/handoff.ts`, `lib/ai-spending-policy.ts`
- OAuth probe: one `POST https://oauth2.googleapis.com/token` with the stored refresh token, executed in memory. Only HTTP status and Google's error code were printed; no token, client secret or ciphertext was written to this report or to any log.

---

## A. Bank Julius Bär application

### A.1 Exact vacancy and application records

Two Julius Bär vacancies were live and eligible. The one named in the report as the **Senior Test Manager** vacancy is:

| Field | Value |
| --- | --- |
| Job ID | `job_7965d42df9c57408` |
| Title | Senior Test Manager / Tester - Multiple Applications 100% (f/m/d) — (Contract through our external payroll partner with immediate start until 30.09.2027, possible extension) |
| Company | Bank Julius Bär & Co. AG |
| Location | Zürich |
| Source / external ID | `jobs_ch` / `d488efe3-349b-4fad-8acf-4e9d55b31be7` |
| ATS | Workday (`juliusbaer.wd3.myworkdayjobs.com`), requisition `r-20528-1` |
| Match score | 94 |
| Qualification | `qualified` (threshold 85) |
| Eligibility | `eligible` — Permit B to 2028-02, German "highly desirable" only (not mandatory) |
| Current job status | `documents` (unchanged) |
| Application ID | `app_473408240ffbfbe2dd0f79fb` |
| Tailored CV | `doc_b1ab042c6b9792e9249c415a` |
| Cover letter | `doc_554bf5843d7685b790f5d450` |
| Run | `run_61d3687ad6e760cdbcf6975b` |

The second Julius Bär record was blocked in the same run and is included because it is part of the same failure:

| Field | Value |
| --- | --- |
| Job ID | `job_db13a5f3f4db47bb` |
| Title | Senior Automation Test Engineer - Java, Selenium, Playwright 90-100% (f/m/d) |
| Requisition | `r-19996-1` |
| Match score | 95, `qualified`, `eligible` |
| Current job status | `documents` |
| Application ID | `app_1a9451a555a294ab73f5771d` |
| Tailored CV / cover letter | `doc_f5ccf7fca4142b368900618f` / `doc_3739e9462629cf2868170879` |

A third, unrelated application (`app_7d1d388ef65d137982ed14dd`, Talan) was also blocked in the same run for a browser security challenge, which shows the behaviour is systematic rather than specific to Julius Bär.

### A.2 Precise submission state

For both Julius Bär applications the state is **prepared, then blocked**:

```
applications.status                = 'human_intervention_required'
applications.submission_status     = 'blocked'
applications.method                = 'candidate_form'
applications.approved_at           = NULL
applications.submitted_at          = NULL
applications.confirmation          = NULL
applications.confirmation_ref      = NULL
applications.applied_channel       = NULL
applications.match_score_at_submit = NULL
submission_attempts.status         = 'blocked'
submission_attempts.http_status    = NULL
submission_attempts.reference      = NULL
submission_attempts.endpoint       = NULL
submission_attempts.error          = NULL
```

This is **not** `submitted`, **not** `failed`, and **not** `uncertain`:

- **Not submitted** — no employer confirmation, no reference, no `submitted_at`, and the run recorded `applications_submitted = 0`.
- **Not failed** — `submission_failed` is only written when a channel produced a definite negative outcome. Here the run classified the block as `blocked_external` and reported `sent: false`.
- **Not uncertain/unverified** — `submission_unverified` is reserved for an ambiguous POST outcome (timeout, 5xx, missing id after a request was sent). No POST was sent, so there is nothing ambiguous to retry.

Run totals for `run_61d3687ad6e760cdbcf6975b` (2026-11-25):

```
jobs_discovered = 12   jobs_eligible = 5   jobs_qualified = 4
packages_prepared = 3  applications_submitted = 0
applications_unverified = 0  applications_intervention = 3  failures = 0
```

### A.3 CAPTCHA detection evidence and the exact point where Noor stopped

The stored evidence, byte-for-byte from `submission_attempts.evidence`:

```json
{
  "sent": false,
  "blockers": ["The application form contains a CAPTCHA, which is never bypassed."],
  "questions": [],
  "executor": "http",
  "externalRequirement": "security_challenge",
  "formStatus": "security",
  "finalUrl": "https://juliusbaer.wd3.myworkdayjobs.com/de-DE/External/job/Zrich/.../_r-20528-1?Location_Country=...",
  "policyEngine": "standing-authorisation-v1",
  "outcomeClass": "blocked_external"
}
```

The corresponding persisted records:

| Record | Value |
| --- | --- |
| `application_interventions.int_d422ab3ac13d10bfe621939d` | kind `security`, status `open`, question/reason "The application form contains a CAPTCHA, which is never bypassed." |
| `application_interventions.int_b9cbd4b4e10931ec89df54b5` | kind `security`, status `open`, same reason |
| `application_events` 24/25/26/27/28/29 | `submission.submitting` → `question.intervention` → `submission.blocked` |
| `tasks.task_3e2a5c645bc96e79338fa356` | Noor, Senior Test Manager, `status = failed`, `error = "Submission needs intervention: The application form contains a CAPTCHA, which is never bypassed."` |
| `tasks.task_e936e9c5e6e846f5493db9bd` | Noor, Senior Automation Test Engineer, same error |

**Exact stopping point.** The sequence is unambiguous:

1. `16:25:08.980Z` / `16:25:20.480Z` — application rows created; documents prepared (`documents.prepared`, ATS 93 and 91).
2. `16:23:25.440Z` (run-start timestamp) — deterministic submission claim recorded.
3. `16:25:21.419Z` / `16:25:21.850Z` — `submission.submitting`: *"An atomic submission claim was recorded; the employer has not yet been contacted."*
4. `16:25:21.640Z` / `16:25:22.009Z` — form read, security challenge detected, `question.intervention` and `submission.blocked` written.
5. No HTTP POST, no upload, no click on submit.

The form was inspected and classified as a security challenge. Noor stopped **after** reading the form and **before** transmitting anything. `executor = "http"` and `http_status = NULL` confirm that the HTTP channel classified the page at fetch/inspection time and never issued the submission request.

Detection is implemented in three independent layers, all human-only:

- `lib/browser-form.ts:189-201` — recaptcha/hcaptcha iframes, `.g-recaptcha`, `.h-captcha`, `input[name*="captcha"]` → *"The application form contains a CAPTCHA, which is never bypassed."*
- `lib/candidate-forms.ts:95` — text pattern (`recaptcha|hcaptcha|i'm not a robot|captcha`).
- `lib/submission.ts:248` — channel-level declaration check.
- `lib/submission.ts:1138` — maps the plan to `security_challenge`; `lib/handoff.ts:135` tells the owner to complete the CAPTCHA personally.

### A.4 No employer submission was recorded without confirmation

Verified affirmatively:

- **Zero** `submission_attempts` with a non-null `reference` for either Julius Bär job.
- **Zero** `submission_attempts` with `http_status` set.
- Both rows carry `status = 'blocked'`, which is not counted as submitted anywhere.
- The run-level `applications_submitted` counter is `0`.
- Both jobs remain `status = 'documents'` — the `applied` transition only happens on verified employer evidence (`lib/gmail.ts` acknowledgement path or a verified submission reference).
- Account-wide, exactly **one** application is in `status = 'submitted'` (the Akros AG submission of 23 Nov with a real employer reference). Neither Julius Bär record is among the submitted set.

### A.5 Preservation and no automatic retry

- Application rows, documents, evidence and history are untouched. Nothing was deleted, rewritten or re-timestamped by this investigation.
- **Zero** new `submission_attempts` for either Julius Bär job after `2026-11-25T23:59:59Z`, including during the 26 Nov catch-up run (`run_c091fdea585e3c88a5e1662a`) and the two manual runs (`run_42816e9674cc989258b55864`, `run_4a622b6ebd5feb1e78fcfe3f`).
- The 26 Nov runs recorded `applications_intervention = 0` and created no new intervention for these jobs; the two existing interventions remain `status = 'open'` and unresolved, which is the correct durable state for "outcome uncertain? no — blocked, awaiting the owner".
- Re-running is safe: `existingVerifiedSubmission` and the open-intervention guard both prevent an accidental duplicate once the owner completes the form.

**Data-integrity observation (not a submission error):** `submission_attempts.attempted_at` and `applications.last_update` are `2026-11-25T16:23:25.440Z` — identical to `recruitment_runs.started_at` — while the application rows were created at `16:25:08`/`16:25:20`. The attempt timestamp therefore records the run's start time rather than the moment the browser step ran, and `last_update` precedes `created_at`. This is a timestamp-source inconsistency worth fixing separately; it does not affect the submission outcome or the evidence. It was **not** modified.

### A.6 CAPTCHA remains a human-only blocker

No CAPTCHA was solved, bypassed, outsourced or pre-answered. The block is durable by design and no code path exists that treats a security challenge as an approval gate. The correct owner action is in the handoff queue (`lib/handoff.ts:135`): open the employer page, complete the CAPTCHA personally, attach the prepared CV and cover letter, submit, then record the employer confirmation reference. Until that reference exists, the application must stay `blocked`.

### A.7 Other eligible vacancies continue normally

The blocked Julius Bär records did not stall the pipeline: the 26 Nov catch-up run (`run_c091fdea585e3c88a5e1662a`, scheduled for 11:00Z = 12:00 Europe/Zurich) completed with `status = completed_with_warnings`, discovered 1 vacancy, and had no failures. Its warnings were unrelated (`join.com responded HTTP 410`, and a withheld coordinator narrative). The 12:39Z manual run also completed. No eligible vacancy was skipped because of the Julius Bär block.

---

## B. Gmail authorization

### B.1 The actual API error and HTTP response

The only error recorded by the application is its own mapped message, repeated in 12 outbox rows and in `settings.email_delivery_last`:

```
Gmail authorisation expired or was revoked. Reconnect Gmail to continue.
```

That message is produced by `lib/gmail.ts` `accessToken()` when the refresh call fails with `/invalid_grant|expired|revoked|invalid refresh/i`. Because it collapses several distinct causes into one string, the stored text alone cannot identify the root cause. The token endpoint was therefore queried directly, in memory, without persisting or printing any credential:

```
POST https://oauth2.googleapis.com/token
grant_type=refresh_token

HTTP status: 400
error: invalid_grant
error_description: Token has been expired or revoked.
has access_token: false
```

**This is the precise failure: the refresh-token grant is invalid. No access token could be minted, so no Gmail API request was ever made.** `gmail_response` is empty in every failed outbox row because the failure occurs before the send.

### B.2 OAuth token state (no credentials exposed)

| Property | Value |
| --- | --- |
| Mailbox | `zubeir.abubakar525@gmail.com` (id 1) |
| Tokens at rest | Encrypted, AES-256-GCM, `v1.` envelope (`tokenEncrypted = true`) |
| Access token | Present, encrypted, **expired** — `expires_at = 2026-11-24T15:30:57.015Z` (now 2026-11-26T12:56Z) |
| Refresh token | Present, encrypted, decrypts correctly (127 chars) — **rejected by Google** |
| Connected at | `2026-11-17T15:30:57.742Z` |
| Last successful sync | `2026-11-19T15:14:02.129Z` |
| Stored scopes | `gmail.compose`, `gmail.readonly`, `gmail.send`, `userinfo.email`, `openid` |
| Client project | Client ID prefix `791881214039` |
| Redirect URI | `http://localhost:3000/api/gmail/oauth/callback` |

Note the exact interval: connection at **17 Nov 15:30:57Z**, token invalid from **24 Nov 15:30:57Z** — precisely **7 days**. This is the documented lifetime of a refresh token issued while the Google OAuth consent screen is in **Testing** publishing status.

### B.3 Cause discrimination

| Candidate cause | Verdict | Evidence |
| --- | --- | --- |
| **Gmail API disabled** | **Ruled out as this failure** | An unenabled API returns HTTP 403 `accessNotConfigured` / "has not been used in project" from `gmail.googleapis.com`. The failure here is HTTP 400 `invalid_grant` at `oauth2.googleapis.com`. The Gmail API was never reached, so its enablement cannot be the observed fault. |
| **Expired access token** | **Contributing, but self-healing in principle** | `expires_at` is in the past. Normally `accessToken()` refreshes transparently; it could not, because the grant behind the refresh is dead. This is a symptom, not the root cause. |
| **Invalid or revoked refresh token** | **CONFIRMED ROOT CAUSE** | HTTP 400 `invalid_grant`, "Token has been expired or revoked." The decryption succeeded, so the stored token is intact — Google rejected it. Three sub-causes fit: 7-day Testing-mode expiry (strongest fit, exact 7-day interval), owner revocation at `myaccount.google.com/permissions`, or exceeding the 50-refresh-token-per-client limit. The server cannot distinguish these after the fact. |
| **Missing OAuth scopes** | **Ruled out** | Stored scopes contain all three required Gmail scopes plus identity scopes. `accountStatus().needsReconnect` is driven by `missingGrantedScopes`, which would have produced a *permission* message, not an authentication message. `.env` `GMAIL_SCOPES` lists only `readonly,send`, but `gmailConfig()` unions in `REQUIRED_GMAIL_SCOPES` (`readonly`, `compose`, `send`) and `GMAIL_IDENTITY_SCOPES`, so the requested set is complete. |
| **OAuth consent / application configuration** | **Probable secondary cause** | The exact 7-day validity points to a consent screen still in Testing. In Testing, refresh tokens expire after 7 days regardless of use. This is a configuration condition, not a scope or API problem. |
| **Incorrect redirect URI / client configuration** | **Ruled out for this failure** | `invalid_client` / `redirect_uri_mismatch` would be returned instead. Google authenticated the client (`invalid_grant`, not `invalid_client`), so the client ID and secret in `.env` match the client that was issued the token. A redirect mismatch would have failed at the authorization step on 17 Nov, and it did not — the connection succeeded then. |

**Bottom line:** the connector is using the intended Google Cloud project and OAuth client (`791881214039`), with the correct redirect URI, and with all required scopes granted. Authorization was valid until **24 Nov 15:30:57Z** and then lapsed. The stored access token also expired at that instant because no refresh could renew it.

### B.4 Intended project and OAuth client — verification

- The `GOOGLE_CLIENT_ID` prefix `791881214039` is the project that issued the stored token; Google's `invalid_grant` response proves the presented client is the token's rightful client, because a foreign client receives `invalid_client` or `unauthorized_client` instead.
- `GOOGLE_REDIRECT_URI` is `http://localhost:3000/api/gmail/oauth/callback`, matching `GMAIL_ENABLED=true` and the callback route `app/api/gmail/oauth/callback/route.ts`; it is registered correctly enough that the 17 Nov flow completed and stored tokens.
- Limitation: the Google Cloud console state (publishing status, OAuth client list, API enablement toggles) is not queryable from this installation. The 7-day interval is strong circumstantial evidence of Testing status, not a direct console read.

### B.5 Impact of the Gmail failure

| Window | Effect |
| --- | --- |
| Up to 24 Nov 15:00:27Z | Delivery healthy. Daily brief `mailout_9a8e1ebe2309e15de1d1050a` reached `sent_folder_observed` (message `1a20e128ba993386`). |
| From 24 Nov 15:30:57Z | Token invalid. |
| 25 Nov 15:00Z | Daily executive brief `executive_brief:2026-11-25` blocked. |
| 25 Nov 16:25Z | 4 `application_intervention` alerts blocked — **including the two Julius Bär CAPTCHA alerts** — so the owner was notified in-app only (`notifications`), never by email. |
| 26 Nov 11:53Z, 12:34Z | `scheduler_failure` and `provider_fallback` notices blocked. |

Totals since the token lapsed: **12 outbox rows `failed` / `blocked`** with the Gmail authorization error, plus 1 unrelated `fetch failed` row (5 attempts) from 25 Nov 11:21Z. Delivery state remains honestly recorded: `provider = NULL`, `gmail_response = ""`, no acceptance is claimed. In-app notifications were unaffected, so no operational signal was lost — only the email copy.

### B.6 Reconnection — exact user-facing steps

Reconnection is genuinely necessary; there is no way to revive the rejected grant.

1. Sign in to the app as the owner and open **Admin → Email** (`/admin/email`).
2. Confirm the status badge reads `reconnect required · zubeir.abubakar525@gmail.com`. The card will list the missing-permission reason supplied by the stored scopes; in this case the real reason is the dead grant, not a scope change.
3. Click **Reconnect Gmail**. This calls `connectGmailAction` → `/api/gmail/oauth/start`, which requests `gmail.readonly`, `gmail.compose`, `gmail.send`, `openid`, `email` with `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`.
4. In the Google account chooser, select **zubeir.abubakar525@gmail.com** — the same mailbox that is currently stored, otherwise the sender identity and draft history diverge.
5. On the consent screen, approve **all** requested permissions. Declining any one causes `exchangeCode` to reject the connection with the missing-scope message rather than storing a partial grant.
6. Google redirects to `/api/gmail/oauth/callback`. On success the app stores a fresh encrypted access and refresh token, sets `email.connected = true`, and writes the `gmail.connected` audit entry.
7. Verify with **Admin → Email → Sync inbox** (read-only) before relying on sending. Optionally use the explicit test-send flow; this investigation deliberately did not send anything.

**To stop this recurring every 7 days:** in Google Cloud Console → APIs & Services → OAuth consent screen, publish the app (move it from **Testing** to **In production**) for the project that owns client `791881214039`, then reconnect once more. While the app remains in Testing, refresh tokens will keep expiring after 7 days. If publishing is not possible, add the mailbox as a test user and reconnect weekly.

**Explicitly:** enabling the Gmail API is **not** a fix for this failure and must not be presented as one. API enablement is a project-level capability; OAuth authorization is a per-user grant. The grant here is expired/revoked and can only be replaced by the consent flow above. Enabling the API alone would leave the same `invalid_grant`.

### B.7 Security handling

No token, refresh token, client secret, ciphertext or `APP_SECRET_KEY` value was printed, logged or written to this report. The probe read the encrypted row, decrypted in memory, called Google, and printed only the HTTP status and error code.

---

## C. Regression and safeguards

| Safeguard | State | Evidence |
| --- | --- | --- |
| Eight agents and assignments | **Preserved** | `agents`: 8 rows, 8 enabled — Chief (coordinator), Saffa (research), Ali (analysis), Kora (cv), Kali (ats), Amira (cover), Noor (application), Rayna (email). |
| 12:00 Europe/Zurich daily schedule | **Preserved** | `schedule_jobs.daily_recruitment`: time `12:00`, timezone `Europe/Zurich`, enabled, weekdays `[1..7]`, `last_scheduled_for = 2026-11-26T11:00:00Z`, next run `2026-11-27T11:00:00Z`. |
| Automatic submission for eligible vacancies | **Preserved** | `autonomous_submission = true`, `recruitment_submission_enabled = true`, `recruitment_dry_run = false`, `approval_mode = false`, standing authorisation activated `2026-11-20T13:18:15Z`. |
| 85% qualification threshold | **Preserved** | `min_match_score = 85`; both Julius Bär roles scored 94/95 and were correctly `qualified`. |
| Eligibility rules | **Preserved** | `eligibility-rules-v2`; Swiss Life and Inventx correctly excluded on mandatory German. |
| CHF 0.00 external AI spending | **Preserved** | `lib/ai-spending-policy.ts`: `MAX_AUTHORISED_EXTERNAL_AI_SPEND_CHF = 0`, `AI_BUDGET_LIMIT_CHF=0`, `AI_ALLOW_PAID_MODELS=false`, `AI_ALLOW_BILLING_FALLBACK=false`. `GEMINI_PAID_AUTHORISED=true` is a **legacy flag that the policy explicitly ignores** (`GEMINI_AUTHORISATION_ENV`, documented at lines 32 and 264) and cannot authorise a paid model. No charge was created. |
| CAPTCHA / human-only restrictions | **Preserved** | Detection unchanged at `browser-form.ts:189-201`, `candidate-forms.ts:95`, `submission.ts:248`; blocked applications remain `blocked_external`. |
| No test emails or employer contact | **Honoured** | Only one outbound call was made: the read-only token refresh probe to `oauth2.googleapis.com`. No Gmail send, no employer request. |
| No test applications | **Honoured** | 0 new `submission_attempts` after 25 Nov 23:59:59Z. |
| No commit / push / deploy | **Honoured** | No repository mutation was performed; only this report was added. |
| Unrelated functionality | **Unmodified** | No application code changed. |

### C.1 Observations outside the requested scope (reported, not changed)

1. **Late scheduled start.** The 26 Nov daily run was `trigger = catch_up`, `scheduled_for = 2026-11-26T11:00:00Z` but `started_at = 11:40:30Z` (12:40 Europe/Zurich) — 40 minutes late. It completed normally. The schedule definition itself is correct; this looks like runtime wake-up latency, not a schedule drift.
2. **Timestamp source.** As noted in A.5, `submission_attempts.attempted_at` mirrors the run start rather than the channel execution time, producing `last_update < created_at`.
3. **Error conflation.** `lib/gmail.ts accessToken()` maps expired access token, `invalid_grant`, revocation and refresh-token expiry to one message, which is why the stored data could not identify the cause without the probe. Splitting `invalid_grant` from transient refresh errors would make future incidents diagnosable from the audit trail alone.
4. **`.env` scope list.** `GMAIL_SCOPES` omits `gmail.compose`; the code compensates by unioning required scopes, so behaviour is correct, but the env value is misleading to an operator reading it.

---

## D. Corrective actions

| # | Action | Owner | Urgency |
| --- | --- | --- | --- |
| 1 | Reconnect Gmail using the steps in B.6, selecting `zubeir.abubakar525@gmail.com` and approving every scope. Verify with a read-only inbox sync. | Owner | High — all outbound mail is blocked |
| 2 | Move the OAuth consent screen for project `791881214039` to **In production**, or accept weekly reconnection while it stays in Testing. | Owner | High — prevents recurrence |
| 3 | Do **not** treat Gmail API enablement as the fix. If it is also disabled, enable it separately — but the grant still has to be re-established. | Owner | Informational |
| 4 | Complete the two Julius Bär applications manually from the prepared packages (`app_473408240ffbfbe2dd0f79fb`, `app_1a9451a555a294ab73f5771d`), then record the employer confirmation reference so the status can move off `blocked`. | Owner | Normal |
| 5 | Optionally split the Gmail error taxonomy in `lib/gmail.ts` so `invalid_grant` is distinguishable from a transient refresh failure in the outbox `last_error`. | Engineering | Low — follow-up, not part of this investigation |
| 6 | Optionally align `submission_attempts.attempted_at` with the actual channel execution time. | Engineering | Low — data hygiene |

Actions 5 and 6 were **not** implemented, because this task is an investigation and the brief forbids modifying unrelated functionality.

---

## E. Test results

Focused suites covering the two safeguards in question, run with `npx tsx --test`:

```
tests/gmail-profile.test.ts tests/browser-form.test.ts tests/submission-ats.test.ts
tests/autonomous-submission.test.ts tests/handoff.test.ts tests/policy-safety.test.ts

tests 41  suites 0  pass 41  fail 0  cancelled 0  skipped 0
exit status 0
```

Relevant passing assertions:

- `CAPTCHA and MFA stop the workflow before any POST`
- `a JavaScript-rendered CAPTCHA is an external blocker and is never bypassed`
- `a channel-level CAPTCHA declaration is classified as an external blocker`
- `an ambiguous response is unverified and cannot be blindly retried`
- `an uncertain POST outcome is unverified and is never retried blindly`
- `a duplicate application is blocked and does not create another attempt`
- `expired credentials are reported as reconnection required`
- `insufficient scopes name the missing permissions`
- `a blocked application has a complete persistent handoff package`
- `fresh installs submit eligible applications automatically with no per-application approval`
- `the daily cap and threshold floor survive a policy save`

Operational checks performed:

- Insert-free, read-only database access throughout (`sqlite3 -readonly`, `DatabaseSync({ readOnly: true })`).
- One OAuth probe; result HTTP 400 `invalid_grant`, no credential emitted.
- Confirmed 0 submission attempts for the affected jobs after the block, so no silent retry occurred and none is queued.
- No email sent; `notification_outbox` gained no rows during this investigation.

**Not run:** the full regression suite, `npm run typecheck`, and `npm run build`. No application code changed, so those were outside the minimal verification needed for a read-only investigation and report. No browser or UI check was performed.

---

## F. Limitations

- Google Cloud console state (publishing status, API enablement, client inventory) cannot be read from this installation. The Testing-mode diagnosis rests on the exact 7-day token lifetime plus `invalid_grant`, which is strong but circumstantial.
- Google does not disclose *why* a refresh token was invalidated (expiry, owner revocation, or token-limit eviction); only that it was.
- The CAPTCHA classification reflects what the HTTP/browser channel observed on 25 Nov. The employer page may render differently today.
- Evidence is as of `2026-11-26T12:56Z`; later runs could change `last_seen_at` or job status.

---

## G. Conclusion

Both failures are real, correctly detected, and correctly recorded. No employer was contacted for either Julius Bär role, no submission was falsely claimed, and the CAPTCHA was respected as a human-only step. The Gmail failure is a dead OAuth refresh grant (`invalid_grant`, HTTP 400) with a 7-day expiry signature consistent with a Testing-mode consent screen — not a disabled Gmail API, not missing scopes, and not a client or redirect misconfiguration. The connector is using the intended project and client.

The single action that restores mail is a fresh Gmail reconnection; the action that prevents recurrence is publishing the OAuth consent screen. The two Julius Bär applications remain, by design, waiting on the owner to complete the CAPTCHA — with their documents and full history intact.
