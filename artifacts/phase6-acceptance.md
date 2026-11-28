# Phase 6 — Integrated acceptance

Date: 2026-11-24. Local only. No deploy, no commit, no employer contact,
CHF 0.00 external AI spend.

## Checks actually run

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `npx tsc --noEmit` | exit 0 |
| Full test suite | `npm test` | 499 tests, 499 pass, 0 fail |
| Phase 1 isolation | `tsx --test tests/phase1-task-isolation.test.ts` | 2/2 pass |
| Phase 2 registry | `tsx --test tests/phase2-job-registry.test.ts` | 6/6 pass |
| Phase 3 links/provenance | `tsx --test tests/phase3-employer-links.test.ts` | 6/6 pass |
| Production build | `next build` in an isolated APFS-cloned copy with its own temp DATA_DIR | exit 0 |
| Health | `GET http://localhost:3000/api/health` | HTTP 200, status `operational` |
| DB integrity | `PRAGMA integrity_check` on live DB and backup | `ok` |
| Scheduler | health payload | 12:00 daily, Mon–Sun, `Europe/Zurich`, next run `2026-11-25T11:00:00.000Z` |

The build was run outside the project tree so the running dev server's `.next`
was not disturbed; `data/` and `artifacts/` were excluded from that copy.

## Live database state

- Active DB: `data/at-ai-workforce.db` (WAL), schema version 26.
- 66 jobs; 0 missing `dedupe_key` / `canonical_key` / `qualification_status`;
  0 duplicate canonical groups.
- Qualification: 50 ineligible, 9 qualified, 6 below threshold, 1 needs review.
- 57 rows retain legacy `status='rejected'`; this is an internal bucket, not an
  employer rejection.
- 1 verified submission and 1 submitted application exist and were preserved.
- 1 aggregator-only vacancy is now blocked from automatic submission.
- Backup before the Phase 2 migration:
  `artifacts/backups/at-ai-workforce-phase2-20261124T121733Z.db`.

## Preserved invariants

- All eight agents, Chief authority, architecture, profile/CV/documents,
  discovery sources and safeguards remain.
- Automatic submission remains enabled; the 85% threshold and blockers are
  unchanged; the cap remains up to five genuine applications/day.
- No paid provider, paid browser, CAPTCHA bypass, proxy or cloud service was
  added. Ollama remains the only local inference option.
- `artifacts/phase0-forensic-audit.md` was not modified.

## Open limitations (not claimed as fixed)

1. No live application was submitted, so real employer forms/ATS flows are not
   proven end-to-end today.
2. Employer-link resolution is not automatically invoked during discovery; the
   aggregator-only vacancy remains queued for a human.
3. Legacy `jobs.status='rejected'` rows still exist; readers must use
   `qualification_status` for the authoritative reason.
4. Candidate-form selectors can drift when an employer redesigns a page; the
   driver fails closed and records intervention, but no live drift test ran.
5. Two processes have listened on port 3000 (the current `next dev` server and
   an older supervised production process). The older process was not
   restarted; it predates these changes and is not part of the verified state.

## Local start

```bash
cd ~/Desktop/jobs
npm run dev
```

URL: http://localhost:3000 — DB: `data/at-ai-workforce.db`.
