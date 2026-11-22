# AT AI Workforce — prepared reset manifest

> **EXECUTED 2026-11-22T10:13:21.438Z — RESET COMPLETED — PASS.** See [`completion.json`](completion.json) and [`execution-state.json`](execution-state.json). The status below records the approved pre-execution plan.

Prepared: 2026-11-22T09:52:56.957Z

**Status: PREPARED — NOT EXECUTED.** No historical row or file has been deleted. This document is the confirmation artifact for the single approval gate.

## Backup

- Path: `/Users/abubakartowfiq/Desktop/jobs/reset-backups/atw-backup-2026-11-22T09-52-19-493Z`
- Created: 2026-11-22T09:52:19.704Z
- Schema: 23; integrity: ok
- SHA-256 checksums: all files verified.
- A copy was opened read-only, queried for integrity/foreign keys/counts, then removed. The live database was not restored.
- Outside active data directory: yes
- Stored in `reset-backups/`, which is git-ignored.
- The backup contains the existing `.env` baseline with mode 0600; its values were not printed or copied into this manifest.
- Backup counts: users 1, agents 8, jobs 22, applications 4, documents 34, tasks 124.

## Proposed deletions

| Category | Exact tables | Rows to delete | Rows/files to preserve | Notes |
|---|---|---:|---|---|
| Historical job discovery | `jobs` | jobs: 22 | job_sources: 7 | All 22 stored vacancies are development/operational history; none are referenced after applications are removed. |
| Historical applications | `applications`, `submission_attempts`, `application_events`, `application_interventions` | applications: 4; submission_attempts: 0; application_events: 0; application_interventions: 0 | See notes | 4 application rows: 2 submitted, 1 acknowledged, 1 documents_preparing. No submission attempts, events or interventions exist. |
| Generated CVs and cover letters | `documents` | documents_generated: 32 | documents_original: 2 | Removes 30 live generated rows + 2 already-soft-deleted generated rows, and the 30 generated files. The 2 soft-deleted files are already absent. No uploaded file is orphaned (0 unreferenced). |
| Historical agent activity | `chat_messages`, `agent_sessions` | chat_messages: 722; agent_sessions: 8 | agents: 8 | No agent is deleted or recreated. |
| Execution and orchestration history | `tasks`, `workflows`, `workflow_events`, `recruitment_runs`, `recruitment_run_agents`, `provider_usage`, `ai_jobs`, `recruitment_recovery` | tasks: 124; workflows: 31; workflow_events: 307; recruitment_runs: 14; recruitment_run_agents: 110; provider_usage: 435; ai_jobs: 1; recruitment_recovery: 0 | See notes | The single ai_jobs row is completed; no queued work is discarded. All runs/workflows are completed, failed or paused history. |
| Historical audit events | `audit_logs` | audit_logs_operational: 228 | audit_logs_security: 52 | Retention exception: no statutory retention policy is configured, but security-relevant events are preserved. 228 operational development events are proposed for removal. |
| Notifications and local inbox copies | `notifications`, `notification_outbox`, `email_messages` | notifications: 56; notification_outbox: 17; email_messages: 70 | gmail_accounts: 1 | All 17 outbox rows are terminal (13 sent, 3 failed, 1 cancelled). 70 email rows are local copies only. |
| Other operational records | `discovery_source_status`, `temp_objects` | discovery_source_status: 26; temp_objects: 3 | See notes | 26 transient source-health rows and 3 already-deleted temporary-object rows. No temporary files remain in data/temp. |
| Temporary previews and logs | filesystem | 25 files | See notes | 20 regenerable document preview files (3,534,780 bytes) and 5 development logs. data/backups is preserved. data/atw.sqlite (0 bytes) and .DS_Store are left untouched. |

### Historical job discovery

Preserved: All 7 discovery sources, source URLs, enabled flags, search configuration, scoring/eligibility code and settings. New discovery repopulates normal records.

### Historical applications

Preserved: Application lifecycle/evidence validator, readiness gates, submission policy, duplicate prevention and verified-submission rules are code/configuration and remain untouched.

### Generated CVs and cover letters

Preserved: 2 original/source CV rows and files (active + replaced), user avatar, profile, skills, experiences and all reusable code/configuration templates. No document-template table exists.

Files to delete:
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_CV_v1_0.docx`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_CV_v1_0.pdf`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_CV_v2_0.docx`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_CV_v2_0.pdf`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_CV_v3_0.docx`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_CV_v3_0.pdf`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_Cover_Letter_v1_0.docx`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_Cover_Letter_v1_0.pdf`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_Cover_Letter_v2_0.docx`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_Cover_Letter_v2_0.pdf`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_Cover_Letter_v3_0.docx`
- `data/uploads/ABUBAKAR_Senior_Agile_Test_Engineer_Akros_AG_Cover_Letter_v3_0.pdf`
- `data/uploads/ABUBAKAR_Software_Test_Engineer_SwissPeak_Partners_GmbH_CV_v2_0.docx`
- `data/uploads/ABUBAKAR_Software_Test_Engineer_SwissPeak_Partners_GmbH_CV_v2_0.pdf`
- `data/uploads/ABUBAKAR_Software_Test_Engineer_SwissPeak_Partners_GmbH_Cover_Letter_v2_0.docx`
- `data/uploads/ABUBAKAR_Software_Test_Engineer_SwissPeak_Partners_GmbH_Cover_Letter_v2_0.pdf`
- `data/uploads/ABUBAKAR_Test_Engineer_Hyperscale_Power_CV_v1_0.docx`
- `data/uploads/ABUBAKAR_Test_Engineer_Hyperscale_Power_Cover_Letter_v1_0.docx`
- `data/uploads/Abubakar_Software_Test_Engineer_80100_machineMD_CV_v1_0.docx`
- `data/uploads/Abubakar_Software_Test_Engineer_80100_machineMD_CV_v1_0.pdf`
- `data/uploads/Abubakar_Software_Test_Engineer_80100_machineMD_CV_v2_0.docx`
- `data/uploads/Abubakar_Software_Test_Engineer_80100_machineMD_CV_v2_0.pdf`
- `data/uploads/Abubakar_Software_Test_Engineer_80100_machineMD_Cover_Letter_v1_0.docx`
- `data/uploads/Abubakar_Software_Test_Engineer_80100_machineMD_Cover_Letter_v1_0.pdf`
- `data/uploads/Abubakar_Software_Test_Engineer_80100_machineMD_Cover_Letter_v2_0.docx`
- `data/uploads/Abubakar_Software_Test_Engineer_80100_machineMD_Cover_Letter_v2_0.pdf`
- `data/uploads/Abubakar_Software_Test_Engineer_SwissPeak_Partners_GmbH_CV_v1_0.docx`
- `data/uploads/Abubakar_Software_Test_Engineer_SwissPeak_Partners_GmbH_CV_v1_0.pdf`
- `data/uploads/Abubakar_Software_Test_Engineer_SwissPeak_Partners_GmbH_Cover_Letter_v1_0.docx`
- `data/uploads/Abubakar_Software_Test_Engineer_SwissPeak_Partners_GmbH_Cover_Letter_v1_0.pdf`

Rows whose files are already absent:
- `data/uploads/ABUBAKAR_Test_Engineer_Hyperscale_Power_CV_v1_0.pdf`
- `data/uploads/ABUBAKAR_Test_Engineer_Hyperscale_Power_Cover_Letter_v1_0.pdf`

### Historical agent activity

Preserved: All 8 agent rows: keys, names, roles, descriptions, enabled state, full config JSON, sort order, instructions, personalities, tools and permissions. Agent activity counters are reset in place, not deleted.

### Execution and orchestration history

Preserved: Worker/scheduler configuration, queue code, retry/recovery policy, provider routing, model assignments and runtime health rows.

### Historical audit events

Preserved: Audit table/schema, audit writer, explorer, security controls and 52 authentication, password, admin-configuration, agent-config and integration-connection events.

Retained audit events:
- admin.backup: 1
- admin.email_config: 1
- admin.retention_policy: 1
- agent.config_updated: 1
- gmail.connected: 1
- login.failed: 6
- login.success: 26
- logout: 12
- password.changed: 2
- password.restored: 1

Proposed audit deletions (operational only):
- recruitment.analysing: 27
- workflow.started: 16
- recruitment.verifying_submissions: 14
- recruitment.starting: 14
- recruitment.searching: 14
- recruitment.run_completed: 14
- recruitment.quality_checking: 14
- agents.resumed: 11
- recruitment.completed_with_warnings: 8
- email.test_requested: 8
- documents.generated: 8
- workflow.completed: 7
- settings.recruitment_schedule: 7
- recruitment.completed: 5
- experience.updated: 5
- email.test_accepted: 5
- agents.paused: 5
- profile.languages_updated: 4
- account.name_updated: 4
- profile.updated: 3
- application.approved: 3
- recruitment.standing_authorisation_activated: 2
- recruitment.run_interrupted: 2
- profile.cv_extraction_applied: 2
- document.uploaded: 2
- document.deleted: 2
- coordinator.executive_brief_send_now_queued: 2
- application.submitted: 2
- workflow.pause_requested: 1
- temp.cleanup: 1
- skills.levels_updated: 1
- skill.deleted: 1
- settings.automation: 1
- recruitment.standing_authorisation_paused: 1
- recruitment.policy_updated: 1
- recruitment.failed: 1
- recruitment.discovery_run: 1
- recruitment.autonomous_run_started: 1
- gmail.synced: 1
- coordinator.executive_brief_send_now_sent_folder_observed: 1
- coordinator.executive_brief_blocked: 1
- application.transition_rejected: 1
- application.rejected: 1
- application.created: 1
- application.acknowledged: 1
- account.avatar_updated: 1

### Notifications and local inbox copies

Preserved: Gmail OAuth account/tokens, notification preferences, email templates and delivery infrastructure. Actual Gmail messages and calendar events are untouched.

### Other operational records

Preserved: Discovery source configuration and all provider/integration credentials.

### Temporary previews and logs

Preserved: Source CVs, uploads, existing recovery backups in data/backups, application assets and configuration.

Files to delete:
- `data/preview/current/Abubakar_Software_Test_Engineer_80100_machineMD_CV_v2_0-page-1.png`
- `data/preview/current/Abubakar_Software_Test_Engineer_80100_machineMD_Cover_Letter_v2_0-page-1.png`
- `data/preview/fixed/SwissPeak_CV-page-1.png`
- `data/preview/fixed/SwissPeak_CV-page-2.png`
- `data/preview/fixed/SwissPeak_Cover-page-1.png`
- `data/preview/fixed/SwissPeak_Partners_GmbH_Software_Test_Engineer_CV.docx`
- `data/preview/fixed/SwissPeak_Partners_GmbH_Software_Test_Engineer_CV.pdf`
- `data/preview/fixed/SwissPeak_Partners_GmbH_Software_Test_Engineer_Cover_Letter.docx`
- `data/preview/fixed/SwissPeak_Partners_GmbH_Software_Test_Engineer_Cover_Letter.pdf`
- `data/preview/fixed/machineMD_CV-page-1.png`
- `data/preview/fixed/machineMD_CV-page-2.png`
- `data/preview/fixed/machineMD_Cover-page-1.png`
- `data/preview/fixed/machineMD_Software_Test_Engineer_80_100_CV.docx`
- `data/preview/fixed/machineMD_Software_Test_Engineer_80_100_CV.pdf`
- `data/preview/fixed/machineMD_Software_Test_Engineer_80_100_Cover_Letter.docx`
- `data/preview/fixed/machineMD_Software_Test_Engineer_80_100_Cover_Letter.pdf`
- `data/preview/fixed/verification.json`
- `data/preview/original/doc_fa9880ba68825ef993cb314f.pdf.png`
- `data/preview/original/page-1.png`
- `data/preview/original/page-2.png`
- `data/phase1-runtime-dev.log`
- `data/phase1-runtime-discovery.log`
- `data/phase1-runtime-restart.log`
- `data/phase1-runtime-restart2.log`
- `data/server.log`

## In-place activity resets (no row deletion)

- `agents` (8 rows): set `status='idle', current_task=NULL, last_run_at=NULL, run_count=0, success_count=0, failure_count=0, ai_success_count=0, ai_failure_count=0`. Preserve `key, name, role, description, enabled, config, sort`. Clean operational activity without deleting or reconfiguring any agent.
- `schedule_jobs` (2 rows): set `last_run_at=NULL, last_run_id=NULL, last_status=NULL, last_error=NULL, last_scheduled_for=NULL, last_checked_at=NULL`. Preserve `key, label, time, timezone, enabled, weekdays, next_run_at; scheduler cadence and worker configuration`. Remove old failed/blocked run labels while preserving the exact stored schedule: daily recruitment at 10:00 Europe/Zurich (Mon–Sat) with a 60-second durable scheduler tick, plus the daily executive brief at 16:00 (Mon–Fri). No 10-minute polling interval exists in this build; none is introduced or changed.

## Preserved state

```json
{
  "users": 1,
  "sessions": 10,
  "profiles": 1,
  "skills": 70,
  "experiences": 4,
  "profile_items": 0,
  "settings": 48,
  "job_sources": 7,
  "gmail_accounts": 1,
  "provider_health": 2,
  "runtime_workers": 5,
  "api_rate_limits": 4,
  "schedule_jobs": 2
}
```

Preservation fingerprints (SHA-256; recorded so the post-purge check can prove configuration and personal data are unchanged):

- agentsConfigSha256: `2c6db1dd741b20ed03948e4666a67ac01c32ca0ff33ce9f5b6cd1e3c64fa58dd`
- profileSha256: `e2775de2c10a1ac342d843a64bd7f0d509829bb790a2cbaf32e44e1b848c25d3`
- settingsSha256: `b2a99f5148e1737ae63993df467fdb405002333c89ca63973ed7df2f5d13a736`
- jobSourcesSha256: `67fdfcbeec954edbd0f3d7fabfd18f4ffabcfc4689b6a37a004a4d0cdf0537cc`
- scheduleConfigSha256: `0b5546a51e1b041d6caf33d7870398c3d15a48ffa92fc122a10c97eb7f24e2ea`
- gmailCredentialsSha256: `baf28a18b61cc8994b0a18c750f50695190e4ac69680f42019dfcd153fef6ba2`
- originalCvFilesSha256:
  - `data/uploads/doc_eda4c46e7dcd46aa0091b21f.pdf` — 0e4b4d702509548b6d7e7ba585e9447bb15ab9d78679b083a8bee9330d9905fd (186463 bytes)
  - `data/uploads/doc_fa9880ba68825ef993cb314f.pdf` — 4d1564fc5fea5ec2a6c4cd3d4732322ba3eff4cafd82a61287dae1a129c87d01 (194107 bytes)
- avatarFiles:
  - `data/uploads/avatars/avatar_9ac846b3634ee0c471cd13bd.png` — 379b4b6e03e10804053dfc642a34be6ad4e2e8e2a31986fabf26df5798f92de0 (2213952 bytes)

## Original sources and assets preserved

- `data/uploads/doc_eda4c46e7dcd46aa0091b21f.pdf`
- `data/uploads/doc_fa9880ba68825ef993cb314f.pdf`
- `data/uploads/avatars/avatar_9ac846b3634ee0c471cd13bd.png`
- `data/backups/**` (existing recovery backups)
- `profiles`, `skills`, `experiences`, `profile_items`, `.env`, `gmail_accounts`, `sessions`, `users`, `job_sources`, `settings`, `provider_health`, `runtime_workers`, `api_rate_limits`.

## Ambiguous or mixed-purpose records

- `documents`: mixed. Only `tailored_cv` and `cover_letter` are deleted; both `original_cv` rows (active and replaced) are preserved with their files.
- `agents`: mixed. All 8 rows and configuration are preserved; only activity/status counters are reset in place.
- `schedule_jobs`: mixed. Rows, time, timezone, weekdays, enabled state and `next_run_at` are preserved; only last-run/last-error bookkeeping is cleared.
- `audit_logs`: mixed. 228 operational events are proposed for deletion; 52 authentication, password, admin/agent configuration and integration-connection events are retained as a security-history exception. No statutory retention policy is configured.
- `settings`: all 48 rows are preserved because they mix configuration with last-run metadata. Some historical timestamps therefore remain, but no dashboard activity record does.
- `notification_outbox`: all 17 rows are terminal (13 sent, 3 failed, 1 cancelled); none is pending. Deleting them does not touch Gmail.
- `ai_jobs`: the single row is completed; no queued work is lost.
- `temp_objects`: 3 rows are already marked deleted; no files remain in `data/temp`.
- `data/preview`: regenerable document preview cache only; source CVs are never taken from it.
- `sessions`, `api_rate_limits`, `runtime_workers`, `provider_health`: current security/runtime state, preserved rather than treated as history.
- `data/atw.sqlite` (0 bytes) and `.DS_Store` are left untouched as unrelated files.
- `data/e2e-runtime`, `artifacts/` and `.next/` are development/test areas, not production operational data, and are excluded from the purge.

## Schedule finding

The requested 10-minute polling interval was not found in this build. Recruitment is daily at 10:00 Europe/Zurich with a 60-second scheduler tick (settings.search_frequency = daily). The existing schedule is preserved unchanged; this discrepancy is reported rather than altered.

## Confirmation gate

No deletion will occur until you reply with **Approve reset**. On approval I will: stop/pause the dev server and workers, re-check the backup and counts, run the deletion set above in one controlled transaction, delete only the listed files, restart the unchanged workers/schedule, and verify fingerprints, integrity, foreign keys, the original CV, skills/profile and all eight agents.

If any count, fingerprint or dependency differs at execution time, I will stop before deleting and report it.
