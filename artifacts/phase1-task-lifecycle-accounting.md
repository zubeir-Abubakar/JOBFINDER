# Phase 1 — Task lifecycle and accounting

Date: 2026-11-24. No deployment, no commit, CHF 0.00 external spend.

## Code changes

- `lib/recruitment-run.ts`: `safeComplete()` and `safeFail()` now isolate a
  rejected task transition. A task that another worker (stall sweeper, retry,
  manual action) already moved out of an active state can no longer abort the
  recruitment run. Each rejected transition is written to `audit_logs` as
  `recruitment.task_state_isolated`, so the run can be audited rather than
  silently swallowing the failure. The `completeTask()` guards themselves were
  not weakened.
- `lib/recruitment-run.ts` (`verifyVacancyForRun`): an injected vacancy verifier
  now persists its verdict (`vacancy_status`, `vacancy_verified_at`) on the job
  row. Without this, the generation preflight read the discovery default
  `new` and skipped a vacancy that had just been verified open. This was found
  by the Phase 6 full suite, not assumed.
- `lib/providers.ts`: `recordUsage()` and `completedUsage()` return a boolean.
  The fallback notification is emitted only when the usage row was actually
  persisted; a failed accounting write is no longer reported as a successful
  provider recovery. No token or cost figure is fabricated.

## Verification actually run

- `npx tsc --noEmit` → exit 0.
- `npx tsx --test tests/phase1-task-isolation.test.ts` → 2/2 pass:
  - a research task failed while discovery is in flight does not fail the run;
  - `completeTask()` still refuses an already-failed task.
- Full suite `npm test` → 499 tests, 499 pass, 0 fail (includes the existing
  task-contract, stall-sweeper and recruitment run tests).
- Fixture run used zero network calls and zero provider calls.

## Limitations / residual risk

- Agent health remains task-derived; a stale task can still look like an
  unhealthy agent until the next recovery sweep. No health model was invented.
- The audit log records the isolated transition but does not retry the task;
  retry remains the coordinator's separate responsibility.
