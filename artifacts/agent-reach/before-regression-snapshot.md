# Before regression snapshot — Agent Reach + Noor repair

Captured read-only on 2026-11-26, before any code change in this task.

## 1. Git state

Branch: `main`. HEAD: `d43cb94 updating providers`.

```
 M lib/db.ts
 M lib/gmail-profile.ts
 M lib/gmail.ts
 M lib/notify.ts
 M tests/gmail-profile.test.ts
?? artifacts/investigations/
?? tests/gmail-error-taxonomy.test.ts
```

Those modifications are the separate, earlier Gmail taxonomy work. They were
already in the working tree and are **not** part of this task. Nothing was
staged, committed, pushed or deployed.

## 2. Database

File: `data/at-ai-workforce.db` (read-only connections only).

- `PRAGMA integrity_check` → `ok`
- `PRAGMA foreign_key_check` → no rows
- `PRAGMA user_version` → `26`

Row counts:

| Table | Count |
|---|---|
| agents | 8 |
| tasks | 126 |
| jobs | 79 |
| applications | 8 |
| documents | 52 |
| submission_attempts | 8 |
| application_events | 29 |
| notification_outbox | 35 |

Task status distribution: `completed` 107, `failed` 17, `blocked` 2.

## 3. Eight agent identities

| Key | Name | Role | Status | Enabled |
|---|---|---|---|---|
| coordinator | Chief | Orchestrator | completed | 1 |
| research | Saffa | Discovery | completed | 1 |
| analysis | Ali | Matching | completed | 1 |
| cv | Kora | Documents | completed | 1 |
| ats | Kali | Assurance | completed | 1 |
| cover | Amira | Documents | completed | 1 |
| application | Noor | Submission | **failed** | 1 |
| email | Rayna | Tracking | completed | 1 |

Noor's `failed` status is historical, caused by the CAPTCHA-labelled task
described in the Noor report. It is not an availability problem.

## 4. Scheduler

| Key | Time | Timezone | Enabled | Weekdays | Next run |
|---|---|---|---|---|---|
| daily_recruitment | 12:00 | Europe/Zurich | 1 | [1,2,3,4,5,6,7] | 2026-11-27T11:00:00.000Z |
| daily_executive_brief | 16:00 | Europe/Zurich | 1 | [1,2,3,4,5] | 2026-11-26T15:00:00.000Z |

Exactly one recruitment run per calendar day at 12:00 Zurich, Monday–Sunday.

## 5. Recruitment sources

All enabled: Arbeitnow, Ashby, employer career pages, Greenhouse, jobs.ch,
Lever, manual entry. No source configuration was changed.

## 6. Application / task outcomes

| Application status | Submission status | Count |
|---|---|---|
| human_intervention_required | blocked | 3 |
| rejected | blocked | 3 |
| rejected_by_employer | blocked | 1 |
| submitted | verified | 1 |

Bank Julius Bär rows before the change:

```
app_1a9451a555a294ab73f5771d | human_intervention_required | blocked | submitted_at NULL | approved_at NULL | confirmation NULL | channel NULL
app_473408240ffbfbe2dd0f79fb | human_intervention_required | blocked | submitted_at NULL | approved_at NULL | confirmation NULL | channel NULL
```

Their Noor tasks were `failed` with `error_class = blocked` and the text
"Submission needs intervention: The application form contains a CAPTCHA, which
is never bypassed." — the defect this task repairs.

## 7. Tests, typecheck and build

Not executed before the first edit. This is a real limitation of the baseline:
no pre-change suite result exists, so the report does not claim one. After the
implementation the full suite, typecheck and production build all pass; see
`after-regression-snapshot.md`. No existing test failed after the change, so
there is no pre-existing failure being concealed.

## 8. Agent Reach upstream baseline

Not installed at this point. No proxy, paid API, trial, or credential existed.
