# Phase 2 — Central vacancy registry and deduplication

Date: 2026-11-24. CHF 0.00.

## Schema and identity

`jobs` now carries the authoritative registry fields:

- `dedupe_key`, `canonical_key`, `employer_key`, `requisition_id`
- `employer_url`, `ats_vendor`, `url_confidence`
- `vacancy_status` (`new | verified_open | closed | verification_unknown`)
- `qualification_status` (`pending | qualified | needs_review | ineligible | below_threshold`)

with indexes on `canonical_key`, `dedupe_key` and the qualification/vacancy
states. `lib/db.ts` owns the migration (`ensureColumn` + `CREATE INDEX IF NOT
EXISTS`) and exports `backfillJobRegistry(db)`, invoked from `getDb()` so a
restart repairs pre-existing rows.

`lib/job-identity.ts` is the single pure identity implementation:

1. employer requisition id (URL parameter or id-like path segment);
2. canonical employer vacancy URL;
3. source + stable source id;
4. normalised employer + title + location SHA-1.

No fuzzy merge. A generic path word such as `detail` is never accepted as a
requisition id. Locations Zürich and Bern stay separate vacancies.

## Writers

- `lib/recruitment-discovery.ts`: the insert writes identity, confidence and
  status columns. A confirmed aggregator destination is stored only in `url`;
  `application_url` is `NULL`.
- `lib/jobs.ts` (Arbeitnow): writes `dedupe_key` and the same identity fields.
- `lib/recruitment-run.ts`: the analysis stage writes `qualification_status`
  from eligibility, hard blockers, score and the unchanged 85% threshold.
  `status='rejected'` remains only as a legacy internal bucket; no employer
  rejection is ever inferred from an internal rule.

## Live database work (real, not simulated)

- Active DB identified: `data/at-ai-workforce.db` (2,838,528 bytes, WAL).
  `data/atw.sqlite` remains a 0-byte decoy and was not touched.
- Backup: `artifacts/backups/at-ai-workforce-phase2-20261124T121733Z.db`
  (plus WAL/SHM copies). `PRAGMA integrity_check` on the backup: `ok`.
- Before backfill: 66 jobs, 57 legacy `status='rejected'`, 3 missing
  `dedupe_key`, 66 missing `canonical_key`.
- `backfillJobRegistry()` executed against the live DB.
- After: **66 jobs, 0 missing `dedupe_key`, 0 missing `canonical_key`, 0 missing
  `qualification_status`**; 0 canonical duplicate groups.
  Qualification split: 50 `ineligible`, 9 `qualified`, 6 `below_threshold`,
  1 `needs_review`. `PRAGMA integrity_check`: `ok`; journal mode `wal`.
- UI: the jobs list renders the legacy bucket as “Not selected” instead of
  “rejected”. The filter value remains `rejected` for URL compatibility.

## Tests actually run

`tests/phase2-job-registry.test.ts` → 6/6 pass: identity precedence, aggregator
URL handling, second discovery pass, distinct locations, legacy backfill,
qualification semantics. Full suite: 499/499 pass.

## Limitations

- 57 rows still use `status='rejected'`; `qualification_status` is now the
  authoritative field, but older reports/queries that read `status` will keep
  seeing the legacy bucket.
- No live discovery crawl was run in this phase, so no new procurement of
  vacancies was claimed.
