# Regression comparison — before vs after

| Area | Before | After | Verdict |
|---|---|---|---|
| Agents | 8, unchanged identities | 8, same keys/names/roles/order | preserved |
| Provider routes | Gemini primary + loopback Ollama fallback per definition | unchanged | preserved |
| Agent capabilities | no external research | `research_external` granted, least privilege | added |
| Agent Reach | absent | v1.6.1 pinned, shared service | added |
| Shell/database/credential capability | prohibited | still prohibited | preserved |
| Scheduler | 12:00 Zurich, Mon–Sun, one/day | identical, same next run | preserved |
| Recruitment sources | 7 enabled connectors | identical | preserved |
| Discovery behaviour | connectors only | connectors only; no new runs | preserved |
| 85% threshold | 85 | 85 (`QUALIFYING_MATCH_SCORE`) | preserved |
| Daily submission cap | persisted policy (≤3) | unchanged | preserved |
| German exclusion | hard exclusion | unchanged, tested | preserved |
| Submission gate | readiness + policy + evidence | unchanged | preserved |
| CAPTCHA handling | stop, no submit | stop, no submit, now `blocked` task | repaired |
| Noor task on CAPTCHA | `failed` | `blocked` (`blocked_external`) | repaired |
| Noor failure counters | incremented on CAPTCHA | not incremented | repaired |
| Outcome classes | partial (`outcomeClass` in evidence) | five canonical classes derived + surfaced | repaired |
| Blocked counted as submitted | no | no | preserved |
| Uncertain retry | blocked | blocked | preserved |
| Historical task rows | `failed` | still `failed` on disk, classified blocked at read time | preserved + correctly reported |
| Bank Julius Bär rows | intervention/blocked, no evidence | identical | preserved |
| Notifications | in-app independent of Gmail | unchanged | preserved |
| Gmail integration | `invalid_grant` taxonomy from earlier task | untouched by this task | preserved |
| Database rows | 8/126/79/8/52/8/29/35 | identical | preserved |
| Database integrity | ok | ok | preserved |
| Foreign keys | clean | clean | preserved |
| Typecheck | (baseline not captured) | exit 0 | pass |
| Tests | (baseline not captured) | 613 / 609 pass / 0 fail / 4 skipped | pass |
| Build | (baseline not captured) | exit 0 | pass |
| External spend | CHF 0.00 | CHF 0.00 | preserved |
| Commits/pushes/deploys | none | none | preserved |

## Behaviour changes that are intentional

1. A submission stopped by CAPTCHA, MFA, login or an unsupported portal now ends
   as a persisted `blocked` task, leaves the agent `waiting`, and does not raise
   an agent-failure notification.
2. Analytics exposes five mutually exclusive submission outcomes.
3. Diagnostics no longer count historical `failed` + `error_class='blocked'`
   tasks as technical failures.

## Differences that are not regressions

- `.gitignore` now ignores `.agent-reach/` so the 73 MB sandbox is never
  committed.
- A new analytics list renders under the existing pie; no existing chart or KPI
  was removed.
