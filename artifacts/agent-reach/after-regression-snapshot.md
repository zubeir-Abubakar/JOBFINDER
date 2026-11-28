# After regression snapshot — Agent Reach + Noor repair

Captured 2026-11-26 after implementation and full verification.

## 1. Git state

Branch `main`, HEAD unchanged at `d43cb94`. Nothing staged, committed, pushed or
deployed.

New files from this task:

```
lib/agent-reach.ts
lib/recruitment-research.ts
tests/agent-reach.test.ts
tests/noor-submission-outcome.test.ts
tests/recruitment-research.test.ts
artifacts/agent-reach/*
artifacts/autonomous-submission/noor-submission-reliability-report.md
```

Modified: `.gitignore`, `app/(app)/analytics/page.tsx`, `lib/agent-capabilities.ts`,
`lib/agent-definitions.ts`, `lib/agent-presentation.ts`, `lib/agents.ts`,
`lib/analytics.ts`, `lib/application-status.ts`, `lib/assistant.ts`,
`lib/operations.ts`, `lib/recruitment-run.ts`, `lib/runtime-health.ts`.

The pre-existing Gmail modifications (`lib/db.ts`, `lib/gmail*.ts`, `lib/notify.ts`,
`tests/gmail-profile.test.ts`) remain in the working tree from the earlier task
and were not part of this change.

## 2. Database

- `PRAGMA integrity_check` → `ok`
- `PRAGMA foreign_key_check` → no rows

Row counts are **identical** to the before snapshot: agents 8, tasks 126, jobs 79,
applications 8, documents 52, submission_attempts 8, application_events 29,
notification_outbox 35.

No schema migration was required: task status is an open text column and already
used `blocked`. No production row was rewritten or deleted.

## 3. Agents

All eight agents exist with unchanged keys, names, roles, enabled flags and
provider routes. Agent Reach added one capability (`research_external`) and one
tool entry each; identities were not replaced.

Noor's `agents.status` remains historically `failed` from the earlier task rows.
That history was not rewritten; new blocked outcomes write `waiting`, and the
reporting layer classifies `failed` + `error_class='blocked'` as blocked.

## 4. Scheduler

Unchanged:

| Key | Time | Timezone | Enabled | Weekdays | Next run |
|---|---|---|---|---|---|
| daily_recruitment | 12:00 | Europe/Zurich | 1 | [1,2,3,4,5,6,7] | 2026-11-27T11:00:00.000Z |
| daily_executive_brief | 16:00 | Europe/Zurich | 1 | [1,2,3,4,5] | 2026-11-26T15:00:00.000Z |

No extra discovery, catch-up or startup run was created or triggered.

## 5. Bank Julius Bär

```
app_1a9451a555a294ab73f5771d | human_intervention_required | blocked | NULL | NULL | NULL | NULL
app_473408240ffbfbe2dd0f79fb | human_intervention_required | blocked | NULL | NULL | NULL | NULL
```

(`submitted_at`, `approved_at`, `confirmation`, `applied_channel` all NULL.)

## 6. Agent Reach

- Version `1.6.1`, commit `7a38047`, MIT, installed with `uv` in `.agent-reach/`.
- Private Python 3.12.15 in the sandbox; no system change.
- Footprint 73 MB; git-ignored.
- Live probes: `web read`, `web search`, `github read`, `v2ex hot`,
  `youtube read` all `ok: true`.
- `file:///etc/passwd` and `http://127.0.0.1:3000/` rejected by upstream.
- No `setup`, `add`, `login`, `browser`, `update`, proxy or paid key.

## 7. Verification

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` (full suite) | 613 tests, **609 pass**, **0 fail**, 4 skipped, exit 0 |
| `npm run build` | exit 0 |
| New focused suites | 22 pass, 0 fail |
| DB integrity / foreign keys | ok / clean |
| Migration compatibility | no migration needed; existing schema reused |
| Zero-cost policy tests | pass (within full suite) |
| Browser submission safety tests | pass (within full suite) |

The 4 skipped tests are pre-existing skips in the repository, not disables added
by this task.
