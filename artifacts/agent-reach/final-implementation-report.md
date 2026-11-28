# Final implementation report — Agent Reach + Noor repair

Date: 2026-11-26. No commit, push, deploy, employer contact, email or extra
recruitment run was performed. External spend: **CHF 0.00**.

## 1. What was implemented

**Agent Reach (shared, read-only research)**
- Pinned upstream **v1.6.1**, commit `7a38047acf26a729cbb27851e3cb81639da86b29`
  (MIT), installed with `uv` into the project sandbox `.agent-reach/` using a
  private Python 3.12 and an isolated `HOME`. No sudo, no system package, no
  shell-profile change, no browser profile change.
- `lib/agent-reach.ts`: one shared service with a closed channel/action
  allowlist, no shell, fixed argv construction, environment allowlist, isolated
  HOME, timeouts/kill, output and item caps, bounded concurrency, URL validation,
  deduplication, provenance, typed errors and prompt-injection screening.
- `lib/recruitment-research.ts`: read-only recruitment evidence adapter that
  keeps source and employer URLs separate and cannot write to the pipeline.
- Capability `research_external` granted to all eight agents with least
  privilege; one tool entry added per agent. Identities, roles and provider
  routes were not changed.
- Chief can delegate through `delegateResearch`, which only accepts
  `from: "coordinator"` and re-checks the target's own grants.

**Noor lifecycle repair**
- New terminal `blockTask()` state (`blocked`, `error_class='blocked'`,
  `recovery_state=<outcomeClass>`), owner-checked, no failure counter, no
  agent-failure alert.
- The CAPTCHA/needs-intervention branch now writes `blocked`, not `failed`.
- Canonical five-class outcome derivation in `lib/application-status.ts`.
- Analytics exposes all five classes; diagnostics, runtime health and the
  assistant exclude historical `failed`+`blocked` rows from failure counts.

## 2. Which of the eight agents can use Agent Reach

All eight, with least privilege:

| Agent | Channels |
|---|---|
| Chief (Coordinator) | all nine enabled; may delegate |
| Saffa (Research) | web search/read, GitHub, YouTube metadata, V2EX |
| Ali (Analysis) | web read, GitHub |
| Kora (CV) | web read |
| Kali (ATS) | web read |
| Amira (Cover) | web read |
| Noor (Application) | web read only |
| Rayna (Email) | web read only |

No agent has shell, SQL or credential export; those remain prohibited.

## 3. Which channels actually work

Enabled and verified by live call on 2026-11-26:

1. `web_read` — Jina Reader (`backend: jina`)
2. `web_search` — Exa hosted MCP (`backend: exa`)
3. `github_read` — anonymous GitHub REST (`backend: github-api`)
4. `github_search` — anonymous GitHub REST
5. `youtube_read` — local yt-dlp
6. `youtube_search` — local yt-dlp
7. `youtube_subtitle` — local yt-dlp
8. `v2ex_hot` — public V2EX API
9. `v2ex_read` — public V2EX API

All are read-only. No write verb exists in the integration.

## 4. Which channels remain disabled and why

- **Awaiting user configuration (login/cookie):** Reddit, X/Twitter, Facebook,
  Instagram, Xiaohongshu, LinkedIn in-site search, Boss, Bilibili, Xueqiu.
  Cookies are never imported; the user must log in personally, and none of these
  is enabled yet.
- **Blocked by cost/security:** YouTube and Xiaoyuzhou transcription (paid
  Groq/OpenAI key); the **proxy** feature (never configured, purchased or
  trialled); all write actions.
- **Unavailable in this environment:** none for the enabled set. The system
  Python (3.9) was below the upstream floor, which is why a private 3.12 was
  installed inside the sandbox.

## 5. Exact upstream version

`agent-reach` **1.6.1**, git commit
`7a38047acf26a729cbb27851e3cb81639da86b29`, MIT. Installed version confirmed by
`agent-reach version` → `{"version":"1.6.1","install_method":"uv"}`.

## 6. User configuration still required

- Nothing for the nine enabled channels.
- To use a login-walled channel later, the owner must explicitly enable it and
  log in personally. This task did not do that.
- The recruitment evidence adapter is implemented but not yet called by the
  daily discovery loop (see §12).

## 7. Verified cost status and unverified risk

- Verified enabled cost: **CHF 0.00**. No paid API, subscription, proxy,
  CAPTCHA solver, paid search or convertible trial exists. No billing details
  were entered.
- Residual risk: the Exa hosted endpoint is free and accountless, but its quota
  is not contractual. If it rate-limits, the service reports `rate_limited` and
  does not substitute a paid route.
- `CHF 0.00` external AI spend policy untouched; its tests pass.

## 8. Is Noor's task-reporting defect fixed?

**Yes.** CAPTCHA and other external requirements now persist as `blocked`, not
`failed`; the agent is left `waiting`; failure counters and agent-failure alerts
are not raised. Historical `failed`+`blocked` rows are classified as blocked at
read time without rewriting history. Verified by tests.

## 9. The two Julius Bär applications after regression testing

Both unchanged and truthful:

```
app_473408240ffbfbe2dd0f79fb
app_1a9451a555a294ab73f5771d
status=human_intervention_required, submission_status=blocked,
submitted_at NULL, approved_at NULL, confirmation NULL, applied_channel NULL
canonical class = blocked_external
```

Neither is submitted, neither has an invented reference, neither is retried, and
the bank was not contacted.

## 10. Full verification results

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` (complete suite) | **613 tests, 609 pass, 0 fail, 4 skipped**, exit 0 |
| `npm run build` | exit 0 |
| New focused suites | 22 pass, 0 fail |
| DB `integrity_check` | `ok` |
| DB `foreign_key_check` | no violations |
| DB row counts | identical to baseline |
| Scheduler next run | unchanged (2026-11-27T11:00Z = 12:00 Zurich) |
| Zero-cost policy tests | pass |
| Browser submission safety tests | pass |
| Gmail taxonomy tests | pass |

The 4 skipped tests are pre-existing repository skips; no test was disabled or
weakened by this task.

## 11. Preservation confirmation

- Eight agents, identities, roles, assignments and provider routes: unchanged.
- Chief Coordinator authority and task ownership checks: unchanged.
- Database history, rows and schema: unchanged; no reseed, reset or truncation.
- UI, dashboards, workflows, notifications: preserved; one additive analytics
  list.
- Recruitment sources, dedupe, eligibility, scoring, 85% threshold: unchanged.
- Automatic submission, readiness gate, daily cap, duplicate checks, evidence
  rules: unchanged.
- Daily schedule 12:00 Europe/Zurich, Monday–Sunday, once per day: unchanged.
- CHF 0.00 policy: unchanged.
- No commit, push, deploy or production restart.

## 12. Unresolved issues requiring user action

1. **Daily discovery does not call the research adapter yet.** Wiring it would
   add new external reads inside the production run, which this task was not
   allowed to trigger or verify live. The safe next step is a bounded enrichment
   call (≤3 new vacancies per run, evidence only, no eligibility change) during an
   owner-approved scheduled run.
2. **No live scheduled run was executed**, by instruction. The Noor fix is proven
   by tests; the next normal 12:00 run will produce the first real `blocked` task.
3. **The analytics addition was not visually inspected in a browser.** It
   typechecks, builds and renders through the existing `<ul>`/`<PieChart>` layout,
   but appearance was not checked.
4. **No true pre-change test baseline exists.** The first full-suite run happened
   after implementation; it is green with zero failures, so no existing failure is
   being hidden.
5. **Historical task rows were not migrated.** They stay `failed` on disk and are
   excluded from failure reporting at read time, by design.
6. The earlier Gmail taxonomy changes remain uncommitted in the working tree;
   they are unrelated to this task and were left untouched.
