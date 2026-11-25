# Daily Scheduler Correction

**Scope:** one automated recruitment run per calendar day at 12:00 `Europe/Zurich`, Monday–Sunday. The former 10:00 schedule and all `[2,4,6,8,10]`-hour incremental runs are removed.
**Baseline:** `artifacts/phase0-forensic-audit.md` (accepted). No Phase 1 work, no qualification/submission/provider change, no commit, no deploy, no test application.
**Snapshot:** 24 Nov 2026, ~11:47Z.

---

## 1. Original scheduling behaviour

| Aspect | Before |
|---|---|
| Main run | 10:00 `Europe/Zurich`, Monday–Saturday (`RECRUITMENT_TIME`, `RECRUITMENT_WEEKDAYS`) |
| Incremental runs | +2 h, +4 h, +6 h, +8 h, +10 h → 12:00, 14:00, 16:00, 18:00, 20:00 |
| Slots per day | **6** (one `full` + five `incremental`) |
| Tick | In-process `setInterval` every 60 s, plus one immediate tick at startup |
| Durable state | `schedule_jobs.daily_recruitment` (`time`, `timezone`, `enabled`, `weekdays`, `next_run_at`) |
| Run identity | `run_key = <local-date>#<scope>-<HHMM>` (e.g. `2026-11-24#full-1000`, `2026-11-24#incremental-1200`) |
| Catch-up | One late occurrence inside `RECRUITMENT_CATCHUP_HOURS` (default 6 h); beyond it a single `failed` "missed" record |
| Restart | DB row decides; startup recovery resumes an unfinished `scheduled` run or marks it interrupted |
| Live evidence | `run_487451e7b924aae41df41d12` = `2026-11-24#full-1000` 09:00Z; `run_b344b98b1706f31bf45408df` = `2026-11-24#incremental-1200` 11:01Z |

So the deployed behaviour was up to six runs on a Saturday and none on Sunday.

---

## 2. Every mechanism capable of triggering an automated recruitment run

| # | Mechanism | Location | Effect before / after |
|---|---|---|---|
| 1 | Startup immediate tick | `lib/recruitment-ticker.ts` `startRecruitmentScheduler()` → `tick()` | Same code; due-check plus occurrence guard mean a restart after the daily run creates nothing. |
| 2 | In-process 60 s timer | `lib/recruitment-ticker.ts` `setInterval(tick, 60_000)` | Unchanged; now only one occurrence can ever be due per day. |
| 3 | Next.js startup registration | `instrumentation.ts:62-63` | Unchanged; guarded by `globalThis.__atwRecruitmentTimer` and `runtime_workers` primary key. |
| 4 | HTTP cron route | `app/api/cron/recruitment/route.ts:29` → same `tickRecruitmentSchedule()` | Kept for hosted deployments. It cannot add a run: unique `run_key`, `activeRun()` and `occurrenceAlreadyExecuted()`. |
| 5 | Startup run recovery | `instrumentation.ts:35-36`, `lib/recruitment-ticker.ts:105-112` → `recoverInterruptedRecruitmentRuns()` | Resumes the **same** run id if it is `scheduled` and inside the catch-up window; never creates a new row. |
| 6 | Catch-up / missed branch | `lib/recruitment-ticker.ts:133-190`, `lib/recruitment-schedule.ts` `catchUpWindowHours()` | One late execution of the single occurrence, or one `failed` missed record. `recordScheduleRun()` advances `next_run_at`, so it cannot repeat. |
| 7 | Run creation default occurrence | `lib/recruitment-run.ts:498-561` `createRecruitmentRun()` (scope, `#full-1000` key) | Now resolves to the single 12:00 slot; duplicate key returns the existing run with `created:false`. |
| 8 | Schedule row seeding / roll-forward | `lib/recruitment-schedule.ts` `ensureSchedule()`, `recordScheduleRun()`; `lib/db.ts` `migrateWeeklyScheduleDefaults()` | Defaults now 12:00 Monday–Sunday; roll-forward uses the single-slot calculator. |
| 9 | Document recovery queue | `lib/recruitment-recovery.ts` `startRecoveryQueue()` | Resumes documents only; creates **no** recruitment run. Verified by inspection. |
| 10 | Manual triggers | `lib/actions/recruitment.ts:26,36,48,116` → `startDailyRun()` / `executeRun()` | Out of scope and unchanged; still explicitly owner-initiated with `trigger:"manual"`. |

No other `INSERT INTO recruitment_runs` exists outside these paths and tests/fixtures.

---

## 3. Exact files changed

| File | Change |
|---|---|
| `lib/recruitment-schedule.ts` | `RECRUITMENT_TIME="12:00"`, `RECRUITMENT_WEEKDAYS=[1..7]`, deleted `INCREMENTAL_DISCOVERY_OFFSET_HOURS`; `recruitmentRunTimes()` returns exactly one `full` slot; added idempotent legacy-row correction `enforceSingleDailySchedule()` called from `ensureSchedule()`; snapshot comments. |
| `lib/recruitment-ticker.ts` | Header contract updated to one durable 12:00 run (`#full-1200`), no incremental follow-ups; note that the missed branch can only record the single occurrence. No behavioural change was needed — the existing occurrence/active-run/unique-key guards already prevent extras and are now proven by tests. |
| `lib/db.ts` | Database defaults: 12:00 `Europe/Zurich`, `[1,2,3,4,5,6,7]`, marker metadata `recruitmentTime:"12:00"`. Only applies to rows with no weekday list. |
| `app/(app)/settings/page.tsx` | Scheduling card copy: one run per day, 12:00, all seven days; no incremental wording. |
| `app/(app)/recruitment/page.tsx` | Schedule card label "Daily run"; hint describes the single daily occurrence. |
| `tests/daily-scheduler.test.ts` | **New** acceptance suite (9 tests). |
| `tests/weekly-schedule.test.ts` | Defaults, Sunday coverage, DST and rest-day expectations updated. |
| `tests/recruitment.test.ts` | Daily-clock/DST assertions and run-key test updated to one slot. |
| `tests/executive-brief.test.ts`, `scripts/render-executive-brief-preview.ts` | Fixture row 10:00 → 12:00 (report tests only). |
| `e2e/schedules.spec.ts` | Default assertion 12:00 and Sunday checked. Not executed (no browser in this environment). |
| `README.md` | Schedule documentation now one run/day at 12:00 Monday–Sunday. |

Unchanged, verified by `git status`: `lib/recruitment-run.ts` execution/qualification/submission logic, `lib/submission.ts`, `lib/scoring.ts`, `lib/eligibility.ts`, `lib/recruitment-discovery.ts`, providers, agents.

---

## 4. Exact database changes

**No SQL was executed by me against `data/at-ai-workforce.db`.** The one schedule-row correction was applied by the **already-running dev server** when it hot-reloaded the edited module at **2026-11-24T11:45:51.301Z** (the `ensureSchedule()` correction). This is visible in `updated_at` and was not a manual write.

| | Before (Phase 0 evidence) | Now (verified) |
|---|---|---|
| `time` | `10:00` | `12:00` |
| `timezone` | `Europe/Zurich` | `Europe/Zurich` |
| `weekdays` | `[1,2,3,4,5,6]` | `[1,2,3,4,5,6,7]` |
| `enabled` | 1 | 1 |
| `next_run_at` | `2026-11-24T11:00:00.000Z` | `2026-11-25T11:00:00.000Z` |
| `last_run_*`, `last_scheduled_for` | preserved | preserved (`run_b344…`, `2026-11-24T11:00:00Z`) |
| Rows for `daily_recruitment` | 1 | **1** |

Backup taken immediately after verification, because the correction preceded it:

- `artifacts/backups/at-ai-workforce-20261124T114730Z.db`
- `PRAGMA integrity_check` → `ok`; **post-correction** state, since no pre-change snapshot existed at that instant (the app wrote at 11:45:51Z).
- No other table was rewritten by this work; `recruitment_runs` remains 13 rows, `discovery_source_status` 21 rows.

**Important operational finding:** the host runs two listeners on port 3000 — a `next dev` process that applied the correction, and a `production-runtime.mjs` supervisor + `next-server` started ~1 day ago that still executes the **pre-change build**. That older process would reintroduce the +2 h slots after the next roll-forward. It must be restarted by the owner to load this build; I did not restart or deploy it.

---

## 5. Tests executed and actual results

```
npx tsc --noEmit                  → exit 0
npx tsx --test tests/daily-scheduler.test.ts \
               tests/weekly-schedule.test.ts \
               tests/recruitment.test.ts   → 29 pass, 0 fail (exit 0)
npx tsx --test tests/executive-brief.test.ts \
               tests/phase4-runtime.test.ts \
               tests/email-report.test.ts \
               tests/agent-topology.test.ts → 35 pass, 0 fail (exit 0)
```

New acceptance tests (`tests/daily-scheduler.test.ts`):

1. persisted schedule is one run/day at 12:00, Monday–Sunday; one slot; `incrementalTimes` empty.
2. legacy 10:00 Mon–Sat row corrected once, and an owner-edited clock is **not** overwritten afterwards.
3. every calendar day has exactly one 12:00 occurrence; none has a second.
4. 12:00 local preserved across spring-forward (29 Mar 2026 → 10:00Z) and autumn-back (25 Oct 2026 → 11:00Z).
5. three ticks after today's run → no extra run row.
6. three `startRecruitmentScheduler()` calls → one timer, one `runtime_workers` row.
7. missed occurrence: exactly one record; further ticks add none.
8. a running recruitment run with a live lease → `"A recruitment run is already in progress."`, no overlap.
9. scheduler tick rewrites no policy setting, creates no application; 85 % floor and `qualifiesForAutoApply` unchanged.

The overlap test initially failed with `"not due yet"` because `acquireRuntimeLock()` takes lock **metadata**, not a clock — the fixture lease had expired on the test clock. Fixed by seeding `runtime_locks` on the test clock; the failure was in the test, not the scheduler.

---

## 6. Evidence that only one daily run is scheduled

- `SELECT COUNT(*) FROM schedule_jobs WHERE key='daily_recruitment'` → **1**.
- `recruitmentRunTimes("12:00")` → `[{ time: "12:00", mode: "full" }]`; snapshot `slotTimes=["12:00"]`, `incrementalTimes=[]`.
- The `INCREMENTAL_DISCOVERY_OFFSET_HOURS` constant no longer exists (`tsc` clean; no references remain).
- Run key is `<date>#full-1200`; the unique `run_key` index makes a second scheduled run for the same day impossible — the creation call returns the existing row with `created:false`.
- `next_run_at` is `2026-11-25T11:00:00.000Z`, and today's occurrence is recorded as executed (`last_scheduled_for=2026-11-24T11:00:00Z`), so no further run is due today.

---

## 7. Evidence that the next run is 12:00 Europe/Zurich

- `next_run_at = 2026-11-25T11:00:00.000Z` → formatted in `Europe/Zurich` = **25 Nov 2026, 12:00** (CET, UTC+1).
- Tests assert 12:00 in winter (11:00Z) and summer (10:00Z) and at both 2026 DST transitions, including that the transition Sundays still run.

---

## 8. No extra startup or catch-up run can occur

- Startup tick and 60 s tick both go through `scheduleSnapshot().due` and `occurrenceAlreadyExecuted()`; after a completed or interrupted run, `recordScheduleRun()` has already moved `next_run_at` to the next day.
- Startup recovery resumes the **same** run id (`recoverInterruptedRecruitmentRuns`), never inserts a run.
- The missed branch inserts at most one `failed` record and then advances the schedule; repeated ticks return "not due yet" (test 7).
- Overlap is blocked three ways: `activeRun()`, the `recruitment:scheduler` lease, and the unique run key (test 8).
- Scheduler initialisation is idempotent per process (global timer guard) and per database (`runtime_workers` primary key) — test 6.

---

## 9. Other safeguards remain intact

Live policy read back unchanged: `recruitment_dry_run=false`, `autonomous_submission=true`, `min_match_score=85`, `max_applications_per_day=3`, `approval_mode=false`. 21 `discovery_source_status` rows untouched; per-source retry/rate-limit code (`lib/recruitment-discovery.ts`) not modified. Submission gate/duplicate/uncertain-outcome logic (`lib/submission.ts`), eligibility/85 % floor (`lib/scoring.ts`, `lib/eligibility.ts`), the eight agents, token accounting and provider policy are unmodified; test 9 verifies the scheduler neither rewrites settings nor creates applications.

`RECRUITMENT_CATCHUP_HOURS` still bounds lateness to the single occurrence; it can no longer produce a second run because only one slot exists.

---

## 10. Remaining limitations

1. **The live row was corrected by the running dev server at 11:45:51Z, before I could snapshot it.** The backup therefore captures the post-correction state. Pre-change values are documented from the Phase 0 audit; no history was rewritten.
2. **A stale production process is still running the old build** (`production-runtime.mjs --supervise`, PID 55982, `next-server` 55988, ~1 day old) alongside `next dev`. Until it is restarted by the owner, its timers can reintroduce incremental slots after the next roll-forward. Not restarted here (deploy action).
3. `e2e/schedules.spec.ts` was updated but **not executed** — no browser is available in this environment.
4. The scheduler lives inside the application process, so the host must be running at 12:00. A missed day is recorded, not replayed.
5. A late start within the 6 h catch-up window still executes that day's single run once (by design); beyond the window it is recorded as missed.
6. Today's history still contains the pre-change 09:00 full and 11:00 incremental runs (`run_487451…`, `run_b344…`). They were not deleted or relabelled.
7. The owner can still change time/weekdays in Settings → Scheduling. The one-time correction matches only the exact legacy 10:00 Mon–Sat row, so later owner edits are preserved.
