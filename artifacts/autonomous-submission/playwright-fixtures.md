# Autonomous submission — local Playwright fixture proof

Date: 2026-11-24
Scope: candidate-facing application forms rendered by JavaScript.

## What changed

- `lib/browser-form.ts` adds a local Playwright executor. It renders the
  employer page, maps every visible question through the same verified-answer
  rules as the static parser, uploads the tailored CV/cover letter, reads each
  completed control back, clicks the employer's own submit control and classifies
  the result.
- `lib/submission.ts` keeps the HTTP form path first. The browser is used only
  when the initial HTML has no fillable form, or the static page read failed
  before any POST. A POST is never repeated across channels.
- The existing gates are unchanged: atomic claim, readiness, duplicate,
  reconciliation, daily cap of three, 85% threshold, CHF 0.00 external spend and
  automatic submission with no per-application approval.
- `submission_evidence.outcomeClass` now records one of:
  - `submitted_verified`
  - `prepared_not_submitted`
  - `blocked_external`
  - `failed_technical`
  - `outcome_uncertain`

## Controlled ATS fixtures

All fixtures run on `127.0.0.1` in `tests/browser-form.test.ts`. Their forms are
created by JavaScript after the initial response, so the static parser cannot see
them. No employer, aggregator or real ATS is contacted.

| Fixture | Scenario | Result | Stored state |
| --- | --- | --- | --- |
| `/dynamic` | JS form with hidden CSRF, text fields, CV upload and cover text | Submitted once; confirmation `DYN-2026-9001` | `submitted` / `verified`, no `approved_at` |
| `/wizard` → `/wizard-step2` | Two-step ATS wizard: verified contact fields, then CV upload, cover-letter upload and cover text | Final step posted once; confirmation `WIZ-2026-4242` | `submitted` / `verified`, both files uploaded |
| `/dynamic-unknown` | Required question absent from verified profile | No POST | `human_intervention_required`, `prepared_not_submitted` |
| `/dynamic-captcha` | CAPTCHA injected by JavaScript | No POST; never bypassed | `human_intervention_required`, `blocked_external` |
| `/dynamic-legal` | Required legal declaration without owner authorisation | No POST; never accepted on the owner's behalf | `human_intervention_required`, `blocked_external` |
| `127.0.0.1:1/apply` | Unreachable page (closed local port) | No POST; local browser cannot load page | `submission_failed`, `failed_technical` |
| `/dynamic-500` | Employer returns HTTP 500 after the POST | POST observed; delivery unknown | `submission_unverified`, `outcome_uncertain` |

The uncertain fixture is retried by a second call. The retry is refused, no second
POST is made, and the application stays `submission_unverified`; the refusal no
longer overwrites the uncertain evidence with a human-intervention status.

## Verification run

```text
npm run typecheck
  exit 0

npx tsx --test tests/browser-form.test.ts tests/autonomous-submission.test.ts
  22 tests, 22 passed, 0 failed
  exit 0

npm test
  506 tests, 506 passed, 0 failed
  exit 0

npm run build
  Next.js 16.4.6 compiled successfully; TypeScript finished; exit 0
```

Playwright runtime check at the start of the work:

```text
playwright 1.65.1
chromium executable: ~/Library/Caches/ms-playwright/chromium-1255/...
```

## Boundaries preserved

- CAPTCHA, mandatory account login, MFA and payment are explicit external
  blockers. Nothing is bypassed.
- Unknown required facts and unauthorised consequential/legal answers stop before
  submit; they are not invented and do not create a routine approval queue for
  other applications.
- A browser launch/navigation failure is recorded as a technical failure, not as
  a package awaiting approval.
- No real employer portal was used for a test application.
- The local browser executor needs the Playwright Chromium binary on the machine
  that runs submissions. `RECRUITMENT_BROWSER_FORMS=false` disables only this
  fallback; the static HTTP path remains available.
