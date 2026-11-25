# AT AI Workforce — Phase 0 Forensic Audit

**Scope:** read-only audit of the working tree and the live database `data/at-ai-workforce.db`.
**Method:** source inspection + read-only SQLite queries (`readOnly: true`) + regression-test inventory.
**Snapshot:** 24 Nov 2026, database last written 09:07:40Z; latest recruitment run 09:00:35Z.
**Changes made:** none. No source edit, no DB write, no env/config change, no commit, no test application, no migration.

> Every claim below is tied to a record, a column value or a code path. Where the evidence only supports a
> hypothesis it is labelled **SUSPECTED**. Nothing here is called "fixed" because a unit test exists.

---

## 0. Direct question: is Ollama the problem?

**No.** Ollama is not causing the reported incidents. It is the only inference route in this deployment that has
never been rate-limited, and the health snapshot at 08:58:40Z reports it `local`, `available`, 97 ms, two installed
models (`llama3.2:3b`, `qwen2.5-coder:1.5b`).

| Route | Calls | Tokens | Errors | State |
|---|---|---|---|---|
| gemini-live (voice) | 102 | 143,445 | 0 | ok |
| freellmapi | 30 | 46,845 | 6 | **cooling**, 3 consecutive failures, cooldown until 09:02:40Z |
| gemini | 12 | 9,327 | 5 | healthy, last error HTTP 503 "high demand" 09:01:33Z |
| ollama | 4 | **71** | 2 | healthy, last success 22 Nov 23:05Z |

Ollama has served **four calls in total**, two of which returned `fetch failed` on 22 Nov 12:29Z when the local
daemon was not reachable. Since then it is healthy and is wired as the zero-cost fallback. It holds 71 tokens out of
199,688 (0.04 %). It cannot explain 57 rejections, 16 aggregator-only links, 3 blocked submissions or a zero-token
ATS agent.

The real inference pressure is **FreeLLMAPI rate limits** ("4 routes checked (4 rate-limited or on cooldown)") and
**Gemini 503 demand spikes** — both free-tier conditions, not faults in the accounting.

**SUSPECTED (new, needs Phase 1 confirmation):** the fallback notifier wrote
`provider_fallback — "freellmapi failed; local Ollama fallback handled inference"` at 09:00:56Z and 09:03:45Z today,
but `provider_usage` contains **no ollama row after 22 Nov 23:05Z**. Either the fallback call is not persisted, or
the notification is emitted before the call resolves. Both are attribution defects. Do not fix from the notification
text alone.

---

## 1. Verdict per incident

| Incident | Verdict | One-line cause |
|---|---|---|
| A. Agent accounting | **Explained, not fraud**; 1 suspected gap | Noor's 35 calls are all `gemini-live` voice turns (`task_id NULL`); the submission task is deterministic and makes no model call. Voice tokens are 74 % of all tokens. |
| B. False rejections | **CONFIRMED defect** | `jobs.status='rejected'` is written by the internal qualification stage, not by any employer. 57 jobs carry it, 49 of them "strong". |
| C. Original links | **CONFIRMED defect** | `application_url` is a copy of the aggregator `url` (16/16 jobs.ch), or `NULL` (3/3 arbeitnow). No employer-direct URL is ever resolved. |
| D. Repeated recommendations | **CONFIRMED defect** (+2 suspected) | 3 arbeitnow rows have `dedupe_key = NULL`, including one created today, so hash dedupe is blind for that source; rejected rows are never archived and are re-listed. |
| E. Discovery | **CONFIRMED defect** | The 10-minute task execution window kills the research task mid-run; the unguarded `completeTask` then throws and aborts the whole run (2 runs, 0 sources counted). |
| F. Execution | **CONFIRMED capability gap + provenance risk** | No submission endpoint/browser exists; the form adapter gives up on the jobs.ch page. The single "submitted" application is a manual record. |
| G. Scheduling | **CONFIRMED defect + requirement gap** | In-process 60 s ticker is correct, but the schedule is 10:00 + 2 h increments, not the required 10-minute polling; long runs exceed the 10-minute task lease. |

---

## 2. Actual root causes

### Confirmed defects

**C1 — Internal qualification is stored as a terminal "rejected" job status.**
`lib/recruitment-run.ts:1075` computes
`autoApply = eligibility === 'eligible' && score >= threshold && qualifiesForAutoApply(analysis)` and line 1083 writes
`status = CASE WHEN status IN ('applied','rejected') THEN status WHEN ?=1 THEN 'shortlisted' ELSE 'rejected' END`.
So every job that is merely below 85 %, `needs_review`, or ineligible becomes `rejected`, permanently. No employer
was contacted. `jobs.status` is also the field the UI labels as a decision, so an internal triage outcome reads as an
employer rejection.

**C2 — Rejected rows are never archived, expired or requalified.**
57 of 65 jobs are `rejected`; 49 have `match_flag='strong'`. `jobCounts()` in `lib/jobs.ts` still counts them as
"suitable"/"strong" (it filters only on `match_flag`), so the dashboard reports 49 strong matches while the list marks
them rejected. `listJobs()` defaults to `status='all'`, so every run re-surfaces the same 57 rows.

**C3 — Arbeitnow inserts bypass dedupe.**
`lib/jobs.ts` (arbeitnow insert, ~line 248) writes `INSERT INTO jobs (...)` **without `dedupe_key`**. The column was
added nullable (`lib/db.ts:905`), so SQLite accepts `NULL` and the unique index `idx_jobs_dedupe_key` cannot stop
repeats. Confirmed live: 3 arbeitnow rows have `dedupe_key IS NULL`, and one of them (`Wavestone Germany AG`) was
created **today at 09:00:35Z** — this is still happening, not legacy data.

**C4 — `application_url` is never resolved to the employer.**
`lib/recruitment-discovery.ts` (jobs.ch adapter, ~1158–1391) sets `applicationUrl: url` where `url` is the jobs.ch
detail page. All 16 `jobs_ch` rows have `url == application_url` and both are `https://www.jobs.ch/en/vacancies/detail/…`.
Arbeitnow rows leave `application_url` NULL. Only Ashby rows carry a usable employer ATS path (`/application`).
There is no canonicalisation, no redirect following to the employer domain, and no requisition-ID extraction.

**C5 — The submission adapter is pointed at the aggregator, where no form exists.**
`lib/submission.ts` → `channelFor()` chooses `candidate_form`; `lib/candidate-forms.ts` (~482) fetches that URL and
returns `"No server-rendered application form was found."` The three blocked attempts record
`finalUrl` on `jobs.ch/en/vacancies/detail/…`, i.e. the adapter never reached Swiss Life, ti&m or Telecom26.

**C6 — The research task lease (10 min) is shorter than a real discovery run (33–59 min).**
`lib/task-contract.ts:39-44` sets a 10-minute window for retrieval tasks. The stall sweeper fails the task
(`"Stalled retrieval task: no heartbeat within its 10-minute execution window and no active worker lease."`).
When discovery finally returns, `safeComplete()` (`lib/recruitment-run.ts:352`) calls `completeTask()` **without a
try/catch**, and the task-state guard throws
`"Task <id> is failed; Saffa cannot complete a task that is not active."` — which becomes the **run** error.
Two runs died this way (`run_1215e67fda7b613174dfca63`, `run_9e186a279c05bd51305a5c11`), each reporting 0 sources.
The guard itself is correct; the missing isolation is not.

**C7 — No automated submission transport exists.**
`recruitment_submission_enabled=true`, `autonomous_submission=true`, `recruitment_dry_run=false`, yet there is no
configured submission endpoint and no browser. `submitApplication()` therefore always ends in `blocked`
(no form) or `verified` via a manual record. Zero applications in this database were submitted by the system.

**C8 — The only verified submission is manual, but it is counted in the automated pipeline.**
`app_212809afdc2186d0b4509e94` has `submission_status='verified'` with
`evidence.source="manual_record"`, `recordedBy="u_static_admin"`, `channel="manual"`. `jobPipeline()` counts
`applications.status IN ('submitted','acknowledged')` without looking at provenance, so the dashboard cannot separate
"system submitted" from "owner recorded it afterwards".

**C9 — Scheduling does not meet the 10-minute polling requirement.**
`lib/recruitment-schedule.ts` schedules `daily_recruitment` at 10:00 Europe/Zurich, Mon–Sat, with incremental offsets
`[2,4,6,8,10]` hours. `lib/recruitment-ticker.ts` ticks every 60 s, but that only checks whether a scheduled run is due.
Between 10:00 and 12:00 there is no discovery. Additionally the ticker lives inside the Next.js process
(`instrumentation.ts` → `temp-scheduler.ts`), so a restart drops the timer until startup re-registers it.

### Suspected defects (not established by evidence)

- **S1 — Cross-source duplicates.** Dedupe is source-scoped `external_id` plus SHA-1 of company|title|location.
  The same vacancy on jobs.ch and on the employer's own career page would not match. No such pair exists in the
  current 65 rows, so this is unproven.
- **S2 — Same title in different cities is perceived as repetition.** Airapps has 43 rows of 4 titles across 11 cities,
  each a distinct `dedupe_key`. Technically correct; experientially repetitive.
- **S3 — `needs_review` is collapsed into rejection.** SwissPeak is `needs_review` (remote country unclear) and was
  rejected in the same run as its discovery. It may have been intended for a human review queue.
- **S4 — Silent quality degradation on fallback.** `llama3.2:3b` produced 41 tokens for a coordinator call. If document
  generation falls back to it, output quality drops without a visible marker on the application.
- **S5 — Agent status is derived from the last task.** Noor's agent row is `failed` because his only three tasks are
  deterministic failures. That is truthful, but it is task-derived, not a health signal.

---

## 3. Database tables and relevant columns

| Table | Columns that matter here | Why |
|---|---|---|
| `jobs` | `id, source, external_id, url, application_url, dedupe_key, status, match_score, match_flag, qualified, eligibility_status, last_seen_at, last_seen_source, discovered_at, first_seen_at, vacancy_status` | Rejection semantics, link integrity, dedupe, rediscovery |
| `applications` | `id, job_id, status, submission_status, method, confirmation, submitted_at, last_update` | Prepared vs submitted vs verified |
| `submission_attempts` | `id, application_id, job_id, channel, status, http_status, reference, evidence, error, attempted_at` | Outcome truth and retry safety |
| `tasks` | `id, workflow_id, agent_key, status, task_type, execution_mode, attempts, provider, model, ai_outcome, retry_count, error_class, recovery_state, heartbeat_at, run_id` | Task lifecycle, stall sweeper, agent accounting |
| `provider_usage` | `agent_key, provider, model, source, usage_class, task_id, session_id, prompt_tokens, completion_tokens, total_tokens, status, error, fallback_from` | Token attribution |
| `recruitment_runs` | `id, run_key, trigger, status, error, counts, warnings, report, started_at, finished_at` | Run truth and abort evidence |
| `recruitment_run_agents` | `run_id, agent_key, assignment, status, output, error` | Per-agent participation |
| `recruitment_stage_checkpoints` | `run_id, job_id, stage, status, detail` | Where execution stalled (`employer_submission=failed`, `confirmation_verification=pending`) |
| `schedule_jobs` | `kind, time_of_day, timezone, weekdays, next_run_at, last_run_at, last_status` | Real schedule |
| `discovery_source_status` | `source, ok, last_checked_at, last_error, counts` | Source health |
| `provider_health` | `provider, model, status, failure_kind, consecutive_failures, cooldown_until, last_error` | Free-tier pressure |
| `application_events` | `application_id, type, message, meta` | Submission evidence trail |

Indexes/constraints verified: `idx_jobs_dedupe_key` is `UNIQUE` on `jobs(dedupe_key)`, but the column is nullable, so
`NULL` rows evade it (C3). `jobs.source + external_id` has no unique constraint.

---

## 4. Exact records

**Incident B — rejected without an application**

| Job ID | Company | Title | Score | Eligibility | Note |
|---|---|---|---|---|---|
| `job_0f7b708759acfbb4eab1aeec` | SwissPeak Partners GmbH | Software Test Engineer | 92 | `needs_review` | `dedupe_key NULL`; discovered 22 Nov 13:36Z, status now `rejected` (no status-timestamp column exists) |
| `job_18d65a54a2495e8f` | machineMD AG | Software Test Engineer 80–100 % | 81 | `eligible` | Below 85 % threshold; re-seen 24 Nov |
| `job_faef6e1db7681aff8bf38d9d` | encontec GmbH | Software Test Development Ingenieur | 77 | `ineligible` | Germany + mandatory German; `dedupe_key NULL` |
| `job_adfe22db16106c6286167d0e` | Wavestone Germany AG | Professional Quality Engineer | — | — | Created 24 Nov 09:00Z with `dedupe_key NULL` |

`aContakt GmbH` is **not present** in the database under any spelling. None of the four has an `applications` row;
none has a `submission_attempt`; no employer rejection exists anywhere in the schema.

**Incident F — applications**

| Application | Job | Company | Status | Attempt | Evidence |
|---|---|---|---|---|---|
| `app_212809afdc2186d0b4509e94` | `job_82da90322daefcc0` | Akros AG | `submitted` | `sub_c5d05a27f70ba992e9482a2d` `manual`/`verified` | `source:"manual_record"`, `recordedBy:"u_static_admin"` |
| `app_65fbd9e6c3a899444c051997` | `job_fab32cbb6d178e9d` | Swiss Life AG | `human_intervention_required` | `sub_2b3cde8c2cb59deca7b93987` `candidate_form`/`blocked` | `"No server-rendered application form was found."` |
| `app_8473a9849dff1aa8b11452a4` | `job_76a0e54f24d93517` | ti&m AG | `human_intervention_required` | `sub_d376fba71099ef7c2f34818c` `blocked` | same blocker, `finalUrl` on jobs.ch |
| `app_2d04351e3f0dd7ea74a14f75` | `job_20686837e535dbaa` | Telecom26 AG | `human_intervention_required` | `sub_123fded14e9d17cdfa02ab82` `blocked` | same blocker, `finalUrl` on jobs.ch |

**Incident A — Noor**

`task_f18c6577c6153586931fefa1` (`document_validation`), `task_65e0d61f1a4dd21ee8d732c0` and
`task_f00475c7734c93b8064c6d61` (`submission`) — all in `wf_136a3ce7724a3a068f94872d`, all `failed`, all
`execution_mode='deterministic'`, `attempts=0`, all 24 Nov 09:03:45Z, same error. Token rows: 35, all
`provider='gemini-live'`, `model='gemini-3.8-live'`, `source='assistant'`, `task_id=NULL`, mostly under
`session_id='voice_90a09160a505445bbac34987ebb8bc27'` (20 of them). No task-linked call exists for Noor.

**Incident E — aborted runs**

`run_1215e67fda7b613174dfca63` (`task_053fdbed5a56d6413d90719d`) and
`run_9e186a279c05bd51305a5c11` (`task_633bd914fb04faa5d9ca4063`) — both research tasks failed as stalled, then the run
failed with `"Task <id> is failed; Saffa cannot complete a task that is not active."` Run 9e18 logged research `failed`
followed by research `completed`, then still failed — the abort happens on the retry path.

**Scheduler**

`daily_recruitment` 10:00 `Europe/Zurich`, weekdays 1–6, `next_run_at 2026-11-24T11:00:00Z`,
`last_run_at 09:00:35Z`, `last_status=completed_with_warnings`; `daily_executive_brief` 16:00, weekdays 1–5, `queued`.
Latest run `run_487451e7b924aae41df41d12` (`catch_up`): 6/6 sources, 61 discovered, 8 duplicates, 1,987 filtered,
12 eligible, 7 qualified, 3 packages, **0 submitted**, 3 intervention, 1 warning.

---

## 5. Safeguards that must not change

1. **Policy gate before any send** — `submission.ts` refuses when the standing authorisation is inactive, when dry-run
   is on, or when the gate fails. Keep the order: policy → dry-run → duplicate → gate → retry-safety.
2. **Duplicate-submission guard** — `existingVerifiedSubmission()` blocks a second verified attempt for the same job
   (including by `dedupe_key`).
3. **Never retry an uncertain outcome** — the prior-attempt check and `recoverStaleSubmissionClaims()` keep
   `submission_unverified` terminal until an employer reference exists.
4. **Task ownership/state guard** — `completeTask()` refusing a failed or foreign task is correct. Fix the caller, not the guard.
5. **Unique dedupe index and `findDuplicateJob()`** — do not drop the index; make the writers populate it.
6. **Eligibility and hard blockers** — 85 % threshold, `autoApplyBlockers()` (mandatory German, citizenship/sponsorship),
   `vacancyValidationError()`, placeholder-employer rejection, QA title classification.
7. **Live vacancy verification before submission** — an unverifiable vacancy becomes `human_intervention_required`
   with a reason, never a silent send.
8. **Checkpoints and run reports** — `recruitment_stage_checkpoints`, run counts/warnings; they are the only honest
   evidence of where a run stopped.
9. **Zero-spend policy** — `evaluateAiPolicy()`, OpenRouter blocked, no paid fallback, `CHF 0.00`.
10. **Deterministic-first agents** — Saffa/Kali/Rayna must not gain synthetic inference calls to look busy.
11. **Token provenance** — `source ∈ {task, assistant, manual}`, `usage_class ∈ {task, background, unresolved}`, `task_id`.
12. **No fabricated confirmations** — `submitted` requires a reference or an explicit manual record with `recordedBy`.

---

## 6. Confirmed fixes already present (present ≠ proven)

- Token classification: `dashboard-live.ts` aggregates `usage_class` and computes `execution_mode` with an `EXISTS`
  check on `provider_usage.task_id`, so a task is "AI" only with a real linked call.
- `provider_usage` carries `source`, `session_id`, `usage_class`, `fallback_from`.
- `agent-accounting-phase1.test.ts` asserts deterministic completion, task-linked calls, and that a conversation with
  Noor creates no task.
- Stall detection writes an explicit failure instead of leaving tasks `running`.
- Retry-safe submission, stale-claim recovery, duplicate guard, vacancy verification.
- Scheduler handles DST, catch-up windows, missed runs and a lock.
- Discovery validates employers/URLs and records per-source diagnostics with bounded retries (3 attempts, exponential
  backoff 500 ms → 8 s, jitter, `Retry-After` ≤ 30 s).

These are code facts. **None of them has been verified against production behaviour in this phase**, and several are
bypassed in practice (C3, C6).

---

## 7. Missing functionality

1. Employer-direct application URL resolution (redirect chase, ATS detection, requisition ID) — blocks C and F.
2. A browser/form transport for JavaScript and account-gated ATS pages — or an explicit "manual only" channel that is
   never counted as automated.
3. A separate internal qualification field (e.g. `qualification_status`) distinct from the employer-facing outcome, plus
   a non-terminal state for `needs_review`.
4. Requalification/archival policy for stale and rejected vacancies (`vacancy_status`, expiry, re-check).
5. Cross-source vacancy identity (employer + requisition + canonical URL), not just a hash of three strings.
6. Dedupe writes in every insert path (arbeitnow, career pages) — C3.
7. Ten-minute discovery polling as required, with source-aware rate limiting.
8. Run isolation: a task-state exception must fail one stage, never the whole run.
9. Submission provenance surfaced in the dashboard and reports (`system` vs `manual`).
10. Fallback-call accounting — persist the provider that actually served the request (see the Ollama discrepancy).

---

## 8. Risks of changing each component

| Component | Risk | Mitigation |
|---|---|---|
| `jobs.status` semantics | UI, reports, filters and tests read `rejected`; renaming breaks queries | Add a field, backfill, keep `rejected` readable; migrate UI last |
| Dedupe key / unique index | New key can merge genuinely distinct vacancies (e.g. Akros Biel vs Zurich) | Key on employer+title+location+source ID; dry-run the backfill and list merges |
| `application_url` resolution | Wrong employer page → wrong submission | Store `canonical_url`, `employer_url`, `ats_vendor`, `resolution_confidence`; never auto-submit on low confidence |
| Submission transport | Real employer contact is irreversible | Keep dry-run default, per-domain allowlist, one-at-a-time, human review for ambiguous results |
| Task lease / scheduler | Longer lease hides real stalls; shorter kills runs | Heartbeat during fetch loops + stage-level isolation instead of a blanket increase |
| Token attribution | Re-labelling history would rewrite the past | Add classification, never mutate existing rows |
| Agent status derivation | Cosmetic change can hide failures | Keep task-derived status, add a separate health field |
| Migrations | Live DB has a 4 MB WAL; `data/atw.sqlite` is a 0-byte decoy | Checkpoint + file backup before Phase 1; verify `PRAGMA integrity_check` |

---

## 9. Recommended implementation order

1. **Phase 1 — Accounting and task lifecycle.** No schema semantics change: confirm the Ollama fallback row gap,
   make `completeTask` failures stage-local (try/catch + `failTask`), separate agent health from last-task status,
   surface task/background/manual tokens explicitly. Lowest risk, unblocks honest reporting.
2. **Phase 2 — Job Registry and canonical identity.** Add `qualification_status`, canonical employer identity, dedupe
   writes in all insert paths, backfill 57 + 3 rows, archive policy. Do this before touching links so C and D share one
   identity model.
3. **Phase 3 — Links, liveness, freshness, five/day.** Employer URL resolution, vacancy re-verification, ten-minute
   polling with per-source limits, and the five-eligible/day target measured on verified-open vacancies.
4. **Phase 4 — Execution.** Real submission channel, evidence capture, provenance, exception notifications, safe retry.
5. **Phase 5 — Local Browser Use compatibility** (local only, CHF 0.00, no CAPTCHA/proxy services).
6. **Phase 6 — Integrated regression, security, spend and readiness acceptance** against the live DB.

Each phase: explain, change only the approved scope, test, inspect the DB, report honestly, stop.

---

## 10. Tests required to prove each correction

| Correction | Test | Assertion that actually proves it |
|---|---|---|
| C6 run isolation | new `tests/run-stage-isolation.test.ts` | A `completeTask` throw on a failed research task leaves the run `completed_with_warnings`, sources > 0, and the failure recorded on that stage only |
| C1/C2 status semantics | extend `tests/recruitment.test.ts` | A 92 % `needs_review` job gets `qualification_status='needs_review'`, is **not** `rejected`, and produces no `applications` row |
| C3 dedupe writes | extend `tests/dedupe-lastseen.test.ts` | After two discovery passes, arbeitnow rows all have non-null `dedupe_key` and count is unchanged |
| C4/C5 links | new `tests/job-link-resolution.test.ts` | For a jobs.ch fixture, `application_url` resolves to the employer host; unresolved rows are marked `low_confidence` and cannot auto-submit |
| C7/C8 execution | extend `tests/autonomous-submission.test.ts` | Manual record yields `provenance='manual'`; report counts it separately from system submissions; no `verified` without reference |
| C9 scheduling | new `tests/discovery-interval.test.ts` | Ten-minute poll is scheduled and respects `Retry-After`; a restart re-registers without duplicate runs |
| Incident A | extend `tests/token-attribution.test.ts`, `tests/agent-accounting-phase1.test.ts` | Noor voice turns stay `background`; every `ai` task has a `provider_usage` row with the same `task_id`; fallback calls record the serving provider |
| Zero spend | extend `tests/providers.test.ts` | OpenRouter/paid routes blocked; failure never upgrades to a paid request |
| No blind retry | `tests/execution-truth.test.ts` | `submission_unverified` is never resent; a second attempt is refused while the first is unknown |

Tests are necessary but not sufficient: each acceptance criterion also needs a DB inspection and, for submission, an
employer-side artifact.

---

## Appendix A — First command: database census (the read-only baseline)

The first command opened `data/at-ai-workforce.db` with `{ readOnly: true }` and counted every table. Result:

- 40 tables; the substantive ones: `agents` (8), `jobs` (65), `applications` (4), `submission_attempts` (4),
  `tasks` (78), `provider_usage` (148), `recruitment_runs` (5), `schedule_jobs` (2),
  `discovery_source_status` (21, all `ok=1`), `recruitment_stage_checkpoints` (6), `provider_health` (4).
- Jobs by source: ashby 44, jobs_ch 16, arbeitnow 3, career 2.
- Job statuses: rejected 57 (49 strong, 8 possible), shortlisted 4, documents 3, applied 1.
- Agents: all 8 present; Noor `status='failed'`, run 3 / success 0 / failure 3.
- No table contains an employer rejection, an employer message, or a system-submitted application.

This census is the baseline every later phase must diff against.

## Appendix B — Evidence queries used (all read-only)

`agents`, `provider_usage` (by agent, by provider, by session, by `source`), `tasks` (by agent/execution/outcome),
`jobs` (by source/status/`dedupe_key IS NULL`), `applications`, `submission_attempts`, `application_events`,
`recruitment_runs`, `recruitment_run_agents`, `recruitment_stage_checkpoints`, `schedule_jobs`,
`discovery_source_status`, `provider_health`, `notifications` (provider/agent kinds), `settings` (recruitment policy).

---

## Sign-off

Phase 0 is complete. The repository and database are unchanged. The four incidents with real defects are B, C, D and
E; A is an attribution/reporting explanation with one suspected gap; F and G are capability and requirement gaps
rather than data corruption. Nothing will be modified until the owner accepts this audit and authorises Phase 1.
