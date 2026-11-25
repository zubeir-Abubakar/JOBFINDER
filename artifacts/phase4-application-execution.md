# Phase 4 — Real application execution

Date: 2026-11-24. No live employer was contacted.

## What the execution path does

- `lib/submission.ts` keeps the existing channels: configured HTTP form,
  candidate-facing form driven by verified profile data, and ATS APIs only when
  an employer-issued credential exists (`submission-ats.ts`).
- CAPTCHA, MFA, paid applications and login-only portals remain hard blockers.
- The atomic claim, stale-claim recovery, duplicate-detection by `dedupe_key`,
  and “verified evidence is never overwritten” behaviour are unchanged.
- A submission counts as verified only when the endpoint returns a reference or
  equivalent employer evidence. Unverified and ambiguous failures are recorded
  separately and are not retried blindly.
- Provenance is now stored with the attempt: which listing URL, which
  application URL, which employer URL and what confidence the registry had.
- New hard gate: an aggregator-only vacancy is never submitted and is queued
  for human intervention (`applicationProvenanceBlocker`). This closes the path
  where a board page could have been posted to as if it were the employer.

## Verification actually run

- Full unit/integration suite: 499/499 pass, including the controlled fixture
  run that prepares, submits through a mock endpoint and records verified
  evidence, and the duplicate-application test.
- Live DB: 1 `submitted` application with 1 `verified` submission attempt
  remains untouched; 0 new external calls were made.
- Typecheck exit 0; isolated production build exit 0.

## Limitations

- No live submission was executed, by instruction. Therefore the live
  candidate-form/ATS selectors, employer endpoints and real confirmation flows
  are **not** verified against employers today; only the controlled fixture
  proves the internal contract.
- ATS submission still depends on an operator-supplied credential; without one
  the candidate-form path is used.
- CAPTCHA-protected forms remain manual by design.
