# Noor — submission lifecycle and reporting reliability

Date: 2026-11-26. Scope: task lifecycle, reporting, notifications and the Bank
Julius Bär regression case. No employer was contacted and no application was
submitted as part of this repair.

## 1. Root cause

The application record was already truthful. The **task** was not.

In `lib/recruitment-run.ts`, the submission branch for an externally blocked
outcome called:

```ts
finishSubmissionTask("failed", `Submission needs intervention: ${outcome.detail}`, "blocked");
```

`finishSubmissionTask` routed every non-completed result to `failTask`, which
writes:

- `tasks.status = 'failed'`
- `tasks.recovery_state = 'failed'`
- `agents.failure_count += 1`, `agents.status = 'failed'`
- an `agent_failure` notification
- a workflow `agent.failed` event

So a CAPTCHA — a correct, policy-mandated stop — was persisted and reported as a
technical failure. The persisted `applications` row was correct
(`human_intervention_required` / `blocked`, all submission evidence `NULL`).
Dashboard and failure counters read the task row, which is why Noor appeared
"failed" and the blocker looked like a fault or a missing authorisation.

## 2. Canonical taxonomy

`lib/application-status.ts` now exposes `canonicalSubmissionOutcome`, derived from
persisted evidence:

| Class | Meaning | Evidence rule |
|---|---|---|
| `submitted_verified` | employer received and confirmed | stored `submitted_at` **and** `confirmation` (or `submission_status='verified'`) |
| `prepared_not_submitted` | documents/fields prepared, nothing sent | no submission evidence and no declared blocker |
| `blocked_external` | CAPTCHA, MFA, login, unsupported portal | declared `outcomeClass` or `submission_status='blocked'` |
| `failed_technical` | browser crash, local fault, malformed execution | `submission_failed` / `submission_status='failed'` without ambiguity |
| `outcome_uncertain` | POST may have reached the employer | `submission_unverified` / `submission_status='unverified'` |

A CAPTCHA is `blocked_external`. It is never `failed_technical`. A prepared or
blocked record is never `submitted_verified`.

## 3. State transitions

### Before

```
prepared → submitted? → CAPTCHA
  applications: human_intervention_required / blocked   (correct)
  tasks:        failed                                   (wrong)
  agents:       failed, failure_count + 1                (wrong)
  dashboard:    "Failed task"                            (wrong)
  notification: agent_failure                            (wrong alarm)
```

### After

```
prepared → submitted? → CAPTCHA
  applications: human_intervention_required / blocked   (unchanged)
  tasks:        blocked, error_class=blocked,
                recovery_state=blocked_external,
                requires_input=1                          (truthful)
  agents:       waiting, run_count + 1,
                failure_count/success_count unchanged     (truthful)
  dashboard:    "Blocked — waiting for you"               (truthful)
  notification: application_intervention (owner action)   (no false failure)
```

Implemented by `blockTask()` in `lib/agents.ts` and the repaired branch in
`lib/recruitment-run.ts`. `blockTask` is terminal, owner-checked
(`assertTaskOwner`) and emits `agent.blocked`, never `agent.failed`.

### Historical rows

Production history is **not rewritten**. Existing rows with
`status='failed' AND error_class='blocked'` are excluded from failure counts at
read time in analytics, operations, runtime health and the assistant, and are
displayed as blocked. This corrects reporting without altering history.

## 4. Dashboard and notification consistency

- Analytics now publishes `submissionOutcomes` with all five canonical classes
  and renders them next to the existing pie (`app/(app)/analytics/page.tsx`).
- Task productivity counts a `failed`/`blocked` row as a non-failure outcome.
- Studio/diagnostics failure lists exclude `error_class='blocked'`.
- Noor's last-outcome view distinguishes `blocked` from `failed`.
- In-app notifications are independent of Gmail. Email delivery remains a
  separate, honestly-reported channel; an invalid Gmail grant does not change an
  employer application status.

## 5. Uncertain submissions

`lib/submission-reconciliation.ts` is unchanged and remains authoritative: a
timeout, transport error or missing reference is `ambiguous`, resolves to
`outcome_uncertain`, blocks blind retry and cannot be sent through another
transport. Tests assert the block.

## 6. Bank Julius Bär regression

IDs: `app_473408240ffbfbe2dd0f79fb`, `app_1a9451a555a294ab73f5771d`.
Requisitions: `r-20528-1`, `r-19996-1`.

Read-only verification after the change:

| Field | app_473408… | app_1a9451… |
|---|---|---|
| status | human_intervention_required | human_intervention_required |
| submission_status | blocked | blocked |
| submitted_at | NULL | NULL |
| approved_at | NULL | NULL |
| confirmation | NULL | NULL |
| applied_channel | NULL | NULL |
| canonical class | blocked_external | blocked_external |

- Neither became submitted.
- No confirmation or reference was invented.
- Neither is retried: the stored outcome is terminal and the submission gate is
  unchanged.
- The historical task rows remain `failed` on disk (history preserved) but carry
  `error_class='blocked'`, are excluded from failure counts and are classified as
  blocked by the new taxonomy.
- No contact with the bank occurred.

## 7. CAPTCHA policy preserved

Stop on detection, no further entry or upload, no submit, record
`blocked_external` with the exact evidence, preserve prepared documents, notify
the owner, continue with other eligible applications, never auto-retry. No
stealth browser, solver, proxy, fingerprint spoofing or session manipulation was
introduced.

## 8. Verification

- `tests/noor-submission-outcome.test.ts`: CAPTCHA → blocked; prepared → not
  submitted; verified → submitted; technical → failed; ambiguous → uncertain;
  uncertain cannot be retried; blocked is not counted as submitted; `blockTask`
  is truthful and does not increment failure counts; both Julius Bär fixtures
  remain unsubmitted and externally blocked; owner check enforced.
- Full suite: 613 tests, 609 pass, 0 fail, 4 skipped.
- Typecheck and production build: pass.
- Database integrity `ok`; counts unchanged; scheduler unchanged.

## 9. Remaining limitations

- No new recruitment run was executed, by instruction. The new `blocked` path is
  proven by tests, not by a live scheduled run.
- Historical task statuses are intentionally not migrated; only read-time
  classification changed.
- The dashboard change was not visually inspected in a browser.
