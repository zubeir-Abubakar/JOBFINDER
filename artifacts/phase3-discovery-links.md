# Phase 3 — Discovery, employer-link resolution and verification

Date: 2026-11-24. CHF 0.00. No employer contacted.

## Resolution module

`lib/employer-links.ts` implements:

- `classifyDestination()` — ATS, direct employer, aggregator, or missing, using
  the same ATS/aggregator host table as identity.
- `resolveEmployerUrl()` — bounded redirect chain (max 3 hops, per-request
  timeout) from a board listing to the employer destination. A direct employer
  host needs no network call. 401/403/429, non-redirect responses, timeouts and
  network errors return `unresolved` with a reason; none is treated as “closed”.
- `canAutoSubmitResolved()` — true only for `direct` and `ats`; aggregator,
  unresolved and missing are false.

All calls are injectable (`fetchImpl`) and no real request is made in tests.

## Wiring into execution

- `lib/submission.ts`: new `applicationProvenanceBlocker()` and
  `channelFor()` gate.
  - An aggregator URL stored as `application_url` is refused.
  - A vacancy with only an aggregator listing, or with `url_confidence` of
    `aggregator | unresolved | missing`, is queued as `manual`; it is not
    submitted and cannot be counted as submitted.
  - Legacy rows with `url_confidence IS NULL` are still protected by host
    inspection of `url`.
  - `applicationProvenance()` (listing URL, application URL, employer URL,
    confidence) is attached to the attempt evidence for the ATS, blocked and
    claim paths.
- `lib/application-readiness.ts`: the employer/application-URL readiness item
  now fails for aggregator-only vacancies with an explicit reason instead of
  passing on the board URL.
- `lib/recruitment-run.ts`: passes `url_confidence` and `employer_url` into
  readiness and submission.

## Verification actually run

- `tests/phase3-employer-links.test.ts` → 6/6 pass: direct host without
  network, aggregator→Greenhouse redirect with requisition extraction, no
  redirect → unresolved, 403 and network failure → unresolved, provenance gate
  for aggregator/unresolved/legacy rows, destination classification.
- Full suite 499/499; typecheck exit 0.
- Live DB: 1 aggregator-only vacancy is now blocked by the gate. Existing
  verified submission evidence was not altered.

## Limitations

- The resolver is implemented and tested but is not automatically invoked
  during live discovery. Resolving every listing would add external traffic and
  is not required to keep the system safe; until a resolution is recorded, the
  aggregator-only vacancy stays queued for a human.
- Link resolution cannot prove that an ATS posting is still open; only the live
  vacancy verification stage does that.
