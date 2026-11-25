# Iframe and execution readiness

Date: 24 November 2026, 18:45 Europe/Zurich
Scope: scheduled jobs.ch query coverage, Digt AG iframe revalidation, and regression verification of the pending readiness work.

## Outcome

- **jobs.ch query coverage: CONFIRMED.** The next scheduled run resolves all **15** queries from the current configuration.
- **Digt AG: BLOCKED.** The ClickUp application frame contains a visible CAPTCHA. No field was entered, no document was uploaded, and nothing was sent.
- **Verification: PASS.** 550/550 tests, typecheck exit 0, production build exit 0, database `quick_check` = `ok`.
- **No application was submitted, no employer was contacted, no discovery run was triggered, and nothing was committed, pushed or deployed externally.**

## 1. jobs.ch scheduled query coverage

The `daily_recruitment` schedule row is unchanged:

- enabled: yes
- time: 12:00
- timezone: Europe/Zurich
- next run: `2026-11-25T11:00:00.000Z`
- last run: `2026-11-24T11:01:33.112Z`
- last status: `completed`

The scheduled path calls `discoverJobSources({ runId, pages, scope })` without a `jobsChQueries` override. Discovery therefore resolves `configuredJobsChQueries()` at run time:

1. No `jobs_ch_queries` row exists in the database `settings` table.
2. `JOBS_CH_QUERIES` supplies five operator queries.
3. `DEFAULT_JOBS_CH_QA_QUERIES` adds the role-family set.
4. Case-insensitive de-duplication removes the two overlapping entries, producing 15.

Confirmed query list:

1. QA Engineer
2. Test Automation Engineer
3. SDET
4. QA Lead
5. Test Manager
6. Senior QA Engineer
7. QA Automation Engineer
8. Senior QA Automation Engineer
9. Senior Test Automation Engineer
10. Mobile QA Engineer
11. Software Test Engineer
12. Test Lead
13. QA Engineer Fintech
14. API Test Engineer
15. Automation Test Engineer

The previous stored run reported five queries because it executed before this expansion was loaded by the live process. The current production build contains the expansion (`QUERY_MARKER` found in `.next/server/chunks/lib_1mpfcbp7hp_-m._.js`, build ID `Xw1wyTu4egHNV5_o-qHNm`). The production supervisor and Next server were reloaded onto that build at 18:45 local time:

- supervisor PID 89590
- `next-server` PID 89594
- `/login` returned HTTP 200
- `recruitment_scheduler` worker running
- `runtime_workers` all reported running
- no recruitment lock was active
- the latest run remained `run_b344b98b1706f31bf45408df`; no new run was created

With the current database setting, environment and loaded build, the next 12:00 Europe/Zurich run will use all 15 queries.

## 2. Digt AG read-only revalidation

Stored vacancy:

- job id: `job_31f502795729cb88`
- title: Quality Assurance Engineer 80-100%
- employer: Digt AG
- location: Dällikon
- score: 92%
- status: shortlisted
- application URL: `https://digt.ch/jobs/quality-assurance-engineer-80-100`

The local Playwright executor was run with synthetic candidate data against the stored URL. It selected the employer's embedded provider frame and stopped at the security gate:

- result: `blocked`
- detail: `The application form contains a CAPTCHA, which is never bypassed.`
- evidence sent: `false`
- external requirement: `security_challenge`
- frame kind: `approved-provider`
- frame URL: `https://forms.clickup.com/4798916/f/4jee4-18204/Z45TKUKHNINVREYGX6`
- frame origin: `https://forms.clickup.com`
- frame `ancestorOrigins`: `["https://digt.ch"]`
- association: ClickUp form directly embedded by `https://digt.ch` with application-specific fields
- HTTP status: null
- employer reference: null

No CAPTCHA, MFA, login or payment control was interacted with. No employer submission request was made. The job must not be classified as application-ready while this CAPTCHA is present.

## 3. Verification results

| Check | Result |
| --- | --- |
| Full unit/regression suite (`npm test`) | **550 passed, 0 failed** |
| Iframe fixture suite | **14 passed, 0 failed** |
| TypeScript (`npm run typecheck`) | **exit 0** |
| Production build (`npm run build`) | **exit 0** |
| Database integrity (`PRAGMA quick_check`) | **ok** |
| Live server after reload | **HTTP 200 on `/login`** |
| Recruitment workers | **all running** |
| Active recruitment locks | **0** |
| New recruitment run created | **no** |

The old process logged SQLite `database is locked` errors while it was being stopped. The replacement process logged no errors after startup, all workers registered as running, and the integrity check passed.

## 4. Capability status

| Capability | Status |
| --- | --- |
| Same-origin iframe discovery, selection and filling | Implemented; fixture-tested |
| Approved cross-origin provider frames | Implemented; fixture-tested with direct-child and ancestor-origin checks |
| Dynamic and delayed frames | Implemented; fixture-tested, bounded wait |
| Ambiguous-frame rejection | Implemented; fixture-tested |
| Frame-scoped uploads, dropdowns, radios, validation and multi-step forms | Implemented; fixture-tested |
| CAPTCHA detection before data entry | Implemented; fixture-tested and confirmed on the real Digt frame |
| Explicit employer Apply-link following | Implemented; fixture-tested |
| Real Digt ClickUp iframe execution | Revalidated up to the CAPTCHA gate; **blocked by design** |
| Digt application readiness | **Not ready** |

## 5. Remaining limitations

- Digt AG cannot proceed automatically because its ClickUp form presents a CAPTCHA. It requires a human-controlled application outside the automation path.
- External AI inference remains unavailable without genuine provider-verified free-tier evidence; this revalidation made no external AI call.
- No production submission, discovery or employer communication was performed as part of this verification.
