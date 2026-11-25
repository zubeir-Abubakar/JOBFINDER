# Eligible Vacancy Discovery Readiness

Generated: 2026-11-24 (local workspace)  
Scope: Swiss QA/testing vacancies, employer route verification and zero-cost provider audit  
Latest completed discovery run: `run_b344b98b1706f31bf45408df`  
Run window: 2026-11-24T11:01:33Z – 2026-11-24T11:03:29Z (12:01–12:03 Europe/Zurich)  
Recruitment schedule: unchanged, one run daily at 12:00 Europe/Zurich, Monday–Sunday  
Additional recruitment runs triggered: **none**  
Applications submitted: **none**

## Executive result

No vacancy currently satisfies every condition for an autonomous submission.

- **66** vacancies are stored.
- **48** are English-compatible by language evidence (German not required).
- **18** require German and are hard-excluded.
- **5** pass eligibility.
- **2** reach the 85% qualification floor.
- **0** are fully ready for submission after live employer-route verification.

The two 85%+ vacancies are blocked for different reasons:

1. **Digt AG — Quality Assurance Engineer 80-100%** is open, reachable, identity-verified and has no prior application, but its application form is a **third-party ClickUp iframe** that the current Playwright executor does not enter.
2. **Telecom26 AG — Test Engineer** is a jobs.ch **quick-apply** listing with no employer-controlled application URL, and it already has a blocked application record.

No shortlist item is being represented as ready. No application was submitted.

## 1. Discovery source audit

The latest completed run checked **6 source groups**. All six returned HTTP success and no discovery-source rate limit was recorded.

| Source | Last successful discovery (UTC) | Postings / relevant | Unique stored vacancies | Duplicates in latest run | Missing descriptions | English-compatible | Requiring German | `url_confidence` verified | ATS vendor recorded | Latest source error / rate limit |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Arbeitnow | 2026-11-24T11:01:37Z | 600 / 1 | 3 | 1 | 0 | 0 | 3 | 0 | 0 | None |
| Ashby (`airapps`, `clickhouse`) | 2026-11-24T11:01:39–40Z | 708 / 0 | 44 | 0 | 0 | 44 | 0 | 0 | 0 | None |
| Greenhouse (`sumup`, `adyen`) | 2026-11-24T11:01:41–42Z | 561 / 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | None |
| Lever (`anybotics`) | 2026-11-24T11:01:47Z | 25 / 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | None |
| jobs.ch | 2026-11-24T11:01:47–49Z | 162 / 2 | 17 | 1 | 0 | 4 | 13 | 13 | 5 | None |
| Employer career pages (`careers.ifolor.com`, `join.com`) | 2026-11-24T11:01:49Z | 3 / 0 | 2 | 0 | 0 | 0 | 2 | 0 | 0 | None |
| **Total** | — | **2,059 / 3** | **66** | **2** | **0** | **48** | **18** | **13** | **5** | **None** |

Notes:

- “Postings” is the number of listings read from the source in the latest run; “relevant” is the source metric after title/description filters.
- “Unique stored vacancies” is the deduplicated registry count, not a count of every posting read.
- `url_confidence` is the discovery provenance classification (`direct` or `ats`), not the newer live route-verification result.
- The 44 Ashby rows all have an application URL, but they predate the current provenance writer and have no `url_confidence` value. They are therefore **not** counted as verified URLs in this audit.
- The two career-page rows are an ifolor QA role and a join.com QA role; both require German.
- No source returned a 429 or a source-level error in the latest run. The only 429 observed in this readiness work was from an employer route (Swiss Life/Workday), not from a discovery source.

## 2. Why the registry contains so few genuinely eligible vacancies

The limitation is caused primarily by **search coverage and source selection**, then by the German gate and final-route blockers. It is not caused by duplicate filtering or missing descriptions.

| Cause | Evidence | Verdict |
|---|---|---|
| Source coverage | Ashby, Greenhouse and Lever returned 1,294 postings with 0 relevant QA matches. | **Primary constraint** |
| Query breadth | jobs.ch read 162 postings from only five configured queries and produced 2 relevant matches. | **Primary constraint** |
| German requirement | 18 of 66 stored vacancies (27%) require German; 13 of 17 jobs.ch vacancies do. | **Major constraint** |
| Stale vacancies | Digt was published 2026-01-11 but live verification confirmed it is still open. Publication age alone did not reject a live vacancy. | Not the primary cause |
| Duplicate filtering | Only 2 duplicate listings were blocked in the latest run. | Not the primary cause |
| Missing descriptions | 0 stored vacancies have a missing/short description. | Not the cause |
| Employer URL resolution | 13 of 17 jobs.ch vacancies resolved; 4 remain jobs.ch quick-apply routes. | Blocker for otherwise-qualified roles |
| Qualification | 3 eligible vacancies scored below 85% (86, 81, 78). | Reduces the shortlist after eligibility |
| Application route support | 2 of the 13 resolved routes have a supported form; Digt’s form is a ClickUp iframe; 2 routes failed identity matching; 1 returned HTTP 429. | **Final blocker** |

Only five vacancies pass all eligibility gates. Two reach 85%:

- Telecom26 — 92%, German absent, no employer URL.
- Digt — 92%, German absent, open and identity-verified, unsupported form.

The other eligible roles are below the threshold or do not qualify for autonomous submission.

## 3. Source coverage improvements made

The configured jobs.ch queries were five terms:

`QA Engineer`, `QA Lead`, `SDET`, `Test Automation Engineer`, `Test Manager`.

The connector now merges those operator queries with the requested role-family set:

- Senior QA Engineer
- QA Automation Engineer
- Senior QA Automation Engineer
- SDET
- Senior Test Automation Engineer
- Mobile QA Engineer
- Software Test Engineer
- Test Lead
- QA Lead
- QA Engineer Fintech
- API Test Engineer
- Automation Test Engineer

After case-insensitive deduplication this produces **15 unique queries** from the existing five plus the twelve requested families. Expansion is enabled only when at least one operator query is configured; an unconfigured jobs.ch connector remains disabled. `RECRUITMENT_DISCOVERY_EXPANSION=false` preserves the exact operator list.

The QA title recogniser was also expanded to cover:

- Quality Assurance Engineer / Quality Assurance Analyst
- QA Analyst, QA Specialist, QA Tester, Software QA
- Test Architect
- API Test Engineer
- Mobile QA Engineer
- Automation Test Engineer
- Test Specialist and Test Consultant

The jobs.ch search is Swiss-wide and was not restricted by canton. Lausanne, Geneva, Bern, Zurich, Basel and other Swiss locations remain eligible, and remote roles remain handled by the existing Swiss/remote eligibility gate. No eligibility, German, description, scoring, duplicate or submission gate was weakened.

The next scheduled 12:00 Europe/Zurich run will exercise the expanded query set. No additional run was triggered for this report, so the audit above describes the last completed five-query run, not the expanded run.

## 4. Live employer route verification

The route model now records these distinct states, in order:

`URL_RESOLVED` → `URL_REACHABLE` → `EMPLOYER_IDENTITY_VERIFIED` → `VACANCY_OPEN_VERIFIED` → `APPLICATION_FORM_SUPPORTED`  
and separately `APPLICATION_ROUTE_UNRESOLVED`.

All 13 jobs.ch rows with a direct/ATS application URL were checked over bounded HTTP redirects. No form was submitted and no employer was contacted by email or phone.

| Employer | Role | Application host | HTTP | Route | Form supported | Evidence |
|---|---|---|---:|---|---|---|
| Akros AG | SDET — Biel | akros.ch | 200 | `VACANCY_OPEN_VERIFIED` | No | Open and identity-matched; application form is a third-party iframe |
| Akros AG | SDET — Zurich | akros.ch | 200 | `VACANCY_OPEN_VERIFIED` | No | Open and identity-matched; application form is a third-party iframe |
| Akros AG | SDET — Bern | akros.ch | 200 | `VACANCY_OPEN_VERIFIED` | No | Open and identity-matched; application form is a third-party iframe |
| Digitec Galaxus AG | Quality Engineer Outbound Logistik | galaxus.ch | 200 | `VACANCY_OPEN_VERIFIED` | No | Open and identity-matched; no supported form detected |
| Digt AG | Quality Assurance Engineer 80-100% | digt.ch | 200 | `VACANCY_OPEN_VERIFIED` | No | `/form/` is a ClickUp iframe; executor does not enter third-party iframes |
| Dätwyler IT Infra AG | Quality Engineer | careers.datwyler-itinfra.com | 200 | `VACANCY_OPEN_VERIFIED` | No | Open and identity-matched; no supported form detected |
| Inventx AG | Senior Test Manager 80-100% | inventx.onlyfy.jobs | 200 | `APPLICATION_FORM_SUPPORTED` | Yes | Open, identity-matched, native form controls detected |
| Securiton AG | Testingenieur Sonderbrandsysteme | jobs.securiton.ch | 200 | `APPLICATION_FORM_SUPPORTED` | Yes | Open, identity-matched, native form controls detected |
| Swiss Life AG | QA & Test Manager | swisslife.wd3.myworkdayjobs.com | 429 | `URL_RESOLVED` | No | Workday rate-limited the verification request |
| Transgourmet Schweiz AG | Test Engineer | career2.successfactors.eu | 200 | `URL_REACHABLE` | Yes | Reachable form page, but employer/role identity was not matched |
| machineMD AG | Software Test Engineer 80–100% | join.com | 200 | `VACANCY_OPEN_VERIFIED` | No | Open and identity-matched; application form is a third-party iframe |
| ti&m AG | Test und Quality Engineer | app.jobportal.abaservices.ch | 200 | `VACANCY_OPEN_VERIFIED` | No | Open and identity-matched; no supported form detected |
| ti&m AG | Professional / Senior Test Engineer | app.jobportal.abaservices.ch | 200 | `URL_REACHABLE` | No | Reachable, but employer/role identity was not matched |

Route totals:

- `APPLICATION_FORM_SUPPORTED`: **2**
- `VACANCY_OPEN_VERIFIED` (form unsupported): **8**
- `URL_REACHABLE` (identity not matched): **2**
- `URL_RESOLVED` (429): **1**
- `APPLICATION_ROUTE_UNRESOLVED`: **0 among resolved URLs; 4 additional jobs.ch quick-apply rows have no employer URL at all**

The 4 unresolved jobs.ch quick-apply rows are:

- Akros AG — Senior Agile Test Engineer
- Telecom26 AG — Test Engineer
- adesso Schweiz AG — Teamleader Testing
- univativ Schweiz AG — Senior Test Automation Engineer

They are not assigned invented employer URLs.

## 5. Shortlist and final decisions

### Digt AG — Quality Assurance Engineer 80-100%

- Location: Dällikon
- Score: **92%**
- German: **absent**; no German requirement in the stored evidence
- Freshness: published 2026-01-11; live check on 2026-11-24 recorded **open**
- Employer URL: `https://digt.ch/jobs/quality-assurance-engineer-80-100`
- Application route: `https://digt.ch/form/`
- ATS vendor: none
- Reachability: HTTP 200
- Identity: verified against Digt/role
- Form support: **No** — ClickUp form embedded in a third-party iframe
- Duplicate check: no existing application record
- Final decision: **ELIGIBLE, NOT SUBMISSION-READY**

### Telecom26 AG — Test Engineer

- Location: Zug
- Score: **92%**
- German: **absent**; no German requirement in the stored evidence
- Freshness: published 2026-10-27; the jobs.ch listing is open
- Employer URL: **none** — jobs.ch-hosted quick apply
- Application URL: none
- ATS vendor: none
- Route: `APPLICATION_ROUTE_UNRESOLVED`
- Form support: no employer form route
- Duplicate check: existing application `app_2d04351e3f0dd7ea74a14f75`, status `human_intervention_required`, submission blocked
- Final decision: **NOT SUBMISSION-READY** (unresolved route and duplicate/blocked record)

### Genuine submission-ready shortlist

**0 vacancies.**

There is one genuinely eligible vacancy (Digt) whose employer and open status are verified, but its application form is not supported by the current executor. There is no vacancy that passes every existing condition. This report does not manufacture one.

## 6. Zero-cost provider audit

The recorded totals match the prior report:

| Metric | Evidence |
|---|---:|
| Total inference calls | 152 |
| Local Ollama calls | 4 |
| External calls | 148 |
| Provider-verified cost records | **0** |
| `cost_status = 'verified'` | 0 |
| Recorded `cost_chf` | 0.00 |
| Gemini Live calls | 102 |
| FreeLLMAPI calls | 32 |
| Gemini text calls | 14 |
| Ollama calls | 4 |

Provider/model breakdown:

| Provider / model | Calls | Tokens | Verified cost rows | Unverified cost rows |
|---|---:|---:|---:|---:|
| gemini-live / gemini-3.8-live | 102 | 143,445 | 0 | 102 |
| freellmapi / openai/gpt-oss-20b | 20 | 37,306 | 0 | 20 |
| gemini / gemini-3.6-flash | 14 | 12,812 | 0 | 14 |
| freellmapi / gpt-oss-20b | 8 | 1,912 | 0 | 8 |
| freellmapi / @cf/openai/gpt-oss-20b | 4 | 12,363 | 0 | 4 |
| ollama / llama3.2:3b | 3 | 41 | 0 | 3 |
| ollama / qwen2.5-coder:1.5b | 1 | 30 | 0 | 1 |

Policy decisions:

- 38 `allowed` / `verified_free_external`, all transmitted.
- 5 `blocked`, none transmitted.
- 4 historical `owner_authorised_external` decisions, all transmitted; these predate the current free-tier gate.
- 2 local Ollama decisions, both transmitted.

Why there are zero provider-verified cost records:

1. Gemini, FreeLLMAPI and Ollama do not return an invoice or cost field with these inference responses.
2. `recordUsage()` writes `cost_chf = 0` for schema compatibility and `cost_status = 'unverified'` by design. It does not invent a verified cost.
3. `free_tier_verified_at` is set after a successful call, not by a provider billing or quota attestation. It proves successful inference, not a verified free charge.
4. The live free-tier gate is an explicit operator declaration (`GEMINI_FREE_TIER_VERIFIED` / `FREELLMAPI_FREE_TIER_VERIFIED`) plus model/endpoint checks, not a machine-readable provider quota attestation.

Enforcement status:

- With no free-tier declaration, `evaluateAiPolicy` blocks Gemini and FreeLLMAPI before transmission.
- The tests cover this blocking behavior.
- Only loopback Ollama is authorised when no external free tier is verified.
- No OpenRouter or paid fallback path exists in the text routing chain.
- The 5 blocked policy decisions had `network_transmitted = 0`.

Residual risk, stated honestly:

The system cannot prove provider-side zero cost from the current provider APIs. If an operator declaration is stale or wrong, a request could reach an external provider before that provider returns a quota or billing error. `CHF 0.00` is therefore a **policy limit and recorded placeholder**, not provider-verified spend. This remains an outstanding compliance blocker; no synthetic cost evidence was created.

## 7. Test evidence

| Check | Result |
|---|---|
| TypeScript (`npm run typecheck`) | exit 0 |
| Full `npm test` | **535/535 passed** |
| New discovery coverage tests | 3 passed |
| New zero-cost enforcement tests | 3 passed |
| Vacancy verification / route tests | 9 passed |
| Production build | exit 0 |
| Database integrity | `ok` |
| Recruitment schedule | unchanged: 12:00 Europe/Zurich, weekdays `[1,2,3,4,5,6,7]` |
| Additional recruitment runs | none |
| Employer form submissions | none |
| Commit / push / deploy | none |

The tests cover German hard exclusion, optional German handling, missing descriptions, duplicate detection, URL provenance, employer identity, freshness verification, ATS classification, zero-cost blocking, browser form fixtures and existing application safeguards.

## 8. Outstanding blockers

1. **No fully submission-ready vacancy.** Digt is open and valid but uses a ClickUp iframe unsupported by the executor. Telecom26 has no employer route and an existing blocked application.
2. **Third-party iframe forms.** Akros, Digt and machineMD use embedded forms that the current Playwright executor does not enter. Supporting them safely would require an explicit iframe adapter and the same CAPTCHA/MFA/login gates.
3. **jobs.ch quick apply.** Four QA vacancies publish no employer-controlled application URL. They remain unresolved rather than receiving invented links.
4. **Employer route failures.** Swiss Life’s Workday route returned HTTP 429; SuccessFactors and abaservices routes were reachable but did not match the stored employer/role identity.
5. **Source concentration.** Ashby, Greenhouse and Lever supplied 1,294 postings with zero relevant QA matches in the latest run. Adding QA-heavy Swiss employers or public ATS boards is the next coverage lever; no speculative board tokens were added.
6. **Expanded coverage has not run yet.** The 15-query set will be exercised by the next scheduled 12:00 Europe/Zurich run. No extra run was triggered.
7. **No provider-verified cost evidence.** The external free-tier gate blocks unverified routes, but the zero-cost claim is still based on operator declarations and provider errors, not provider billing attestations.

## 9. Boundary confirmation

- No deployment.
- No commit or push.
- No employer contact by email or phone.
- No application submitted.
- No additional recruitment run.
- No eligibility, German, description, scoring, duplicate, daily-cap or submission safeguard weakened.
- Eight-agent architecture unchanged.
