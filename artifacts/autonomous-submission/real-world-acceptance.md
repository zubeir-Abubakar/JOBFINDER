# AT AI Workforce — German hard exclusion and real-world acceptance report

Date: 2026-11-24 (Europe/Zurich)
Scope: Part A (permanent German exclusion) and Part B (first controlled real-employer submission attempt).
Status: **Part A implemented, tested and applied to the live registry. Part B stopped safely: no genuine registry vacancy satisfies every required condition, so no new employer application was submitted.**

No deployment, commit, push, employer email or test application to a real portal was performed.

---

## 1. German exclusion implementation

German is now a hard, profile-independent eligibility rule. There is no acceptable German level, including A1 and A2. The candidate's language profile is not consulted: a German requirement disqualifies even if a language row existed.

The rule is implemented once in `lib/language-requirements.ts` and consumed by every stage:

| Stage | Enforcement |
|---|---|
| Discovery / insertion | `reconcileDiscovered` computes and stores `german_requirement` and `language_evidence` for every newly inserted vacancy. Re-listed descriptions are re-read and immediately downgraded when German becomes mandatory. |
| Classification | `classifyVacancy` adds German as a mandatory requirement with `MANDATORY_GERMAN_REQUIREMENT` only when the analyzer resolves the wording as mandatory. |
| Scoring | `analyseJob` uses the same analyzer. Mandatory German blocks auto-apply; ambiguous wording adds a blocking concern and reduces language compatibility. |
| Eligibility | `assessEligibility` returns `ineligible` with reason code `MANDATORY_GERMAN_REQUIREMENT`. Ambiguous or missing descriptions return `needs_review`, never `eligible`. |
| Readiness | `evaluateReadiness` re-reads the posting; mandatory German fails `mandatory_blockers`; unresolved German also fails. |
| Run requalification | `enforceStoredGermanExclusion` sweeps every stored vacancy at run start, including old rows and already-applied rows. Linked applications that are not already submitted/acknowledged are rejected and blocked. |
| Submission | `submitApplication` re-checks the posting before the atomic claim, before any HTTP/browser channel and before any network call. It updates the job and application, records evidence and returns blocked. |
| Browser execution | Never reached for a German-required vacancy because the pre-send gate runs before channel selection/launch. |

Classification outcomes:

- `required` → vacancy `ineligible`, reason `MANDATORY_GERMAN_REQUIREMENT`.
- `optional` (for example “German is an advantage”, “German optional”, “English required; German beneficial”) → not disqualifying.
- `ambiguous` (for example “German-speaking team; English required”, a bare “German language skills”) → `needs_review`, automatic submission blocked.
- `unknown` (no usable description) → `needs_review`, because absence of text cannot prove German absent.
- `absent` → no German blocker.

The analyzer recognises CEFR levels A1–C2, basic/elementary/conversational/intermediate/professional/business/fluent/native wording, mother tongue, German-language certification, German-speaking environments with an explicit requirement, German as a mandatory written/spoken working language, German-or-French requirements and German-language negation (“German is not required”).

## 2. Files changed

- `lib/language-requirements.ts` — new central analyzer and reason codes (`MANDATORY_GERMAN_REQUIREMENT`, `GERMAN_REQUIREMENT_UNRESOLVED`).
- `lib/eligibility.ts` — hard exclusion, persisted `germanStatus`/`germanEvidence`/`germanLevel`/`germanReasonCode`, ambiguous/missing text → `needs_review`.
- `lib/vacancy-classification.ts` — German mandatory requirement from the shared analyzer.
- `lib/scoring.ts` — shared analyzer; ambiguous German blocks auto-apply.
- `lib/application-readiness.ts` — re-reads the posting and fails mandatory or unresolved German.
- `lib/recruitment-discovery.ts` — persists German status/evidence; reclassifies re-listed descriptions; rejects linked applications.
- `lib/recruitment-run.ts` — job row fields, stored-vacancy sweep, generation preflight, application-state alignment.
- `lib/submission.ts` — pre-claim/pre-network German gate and application/job evidence update.
- `lib/db.ts` — additive job columns `german_requirement` and `language_evidence`.
- `tests/german-exclusion.test.ts` — 9 regression tests.

No changes were made to the eight-agent architecture, the 12:00 schedule or the 3/day cap.

## 3. Database migrations

Idempotent additive migration at database initialisation:

```sql
ALTER TABLE jobs ADD COLUMN german_requirement TEXT;
ALTER TABLE jobs ADD COLUMN language_evidence TEXT;
```

Applied through `ensureColumn` under schema version 26. No destructive migration and no schema-version bump were required. The live database was backed up to `/tmp/atw-backup/at-ai-workforce-before-german.db` before the requalification sweep.

## 4. German-language test cases and results

Command: `npx tsx --test tests/german-exclusion.test.ts`
Result: **9/9 passed, 0 failed.**

Coverage:

- A1, A2, B1, B2, C1, C2 — each independently `ineligible` with `MANDATORY_GERMAN_REQUIREMENT`.
- Basic, elementary, conversational, intermediate, professional, business, fluent, native, mother tongue, certification, German-speaking environment with explicit requirement, mandatory written/spoken working language, German-or-French, `Deutschkenntnisse A2 erforderlich`, `Sehr gute Deutschkenntnisse`, `Du sprichst fließend Deutsch`.
- Optional: “German is an advantage”, “German optional”, “English required; German beneficial”, “German would be a plus”, “German is not required” — each remains `eligible`.
- Ambiguous: “German-speaking team; English required”, “We are a German-speaking company”, “German language skills”, “German is the company language” — each `needs_review`, never eligible.
- Missing description → `needs_review` / `unknown`.
- Insertion persists `german_requirement=required` and quoted evidence.
- A re-listed vacancy whose newer description adds “Fluent German is required” is reclassified `ineligible` and unqualified.
- The stored-vacancy sweep reclassifies an older eligible German row and rejects its linked ready application.
- A direct `submitApplication` call for a German vacancy returns blocked, sets the application to `rejected`/`blocked`, records no submission attempt and makes **zero network calls**.
- Classification exposes German as a mandatory requirement.

Existing recruitment, intelligence, discovery, browser-fixture and autonomous-submission tests also pass.

## 5. Browser runtime verification

Verified on this host before any employer contact:

| Check | Result |
|---|---|
| Playwright package | 1.65.1 |
| Local Chromium | 159.0.8154.6 |
| Executable | `/Users/abubakartowfiq/Library/Caches/ms-playwright/chromium-1255/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` |
| Headless launch | Succeeded; rendered a local page titled `local-browser-ok` |
| `RECRUITMENT_BROWSER_FORMS` | Not set in the launch shell; effective default is `true` |
| Next.js externalisation | `playwright` is externalised in `next.config.ts` |

No new browser binary was needed. A successful Next.js build is not treated as browser proof; the explicit Chromium launch above is the proof.

## 6. Selected genuine vacancy and why it qualified

**No suitable real-world test vacancy exists in the verified registry.**

The registry was audited after applying the German rule: 66 stored vacancies, 18 now German-required, 2 remaining eligible/qualified. Neither remaining vacancy satisfies all Part B conditions.

| Vacancy | Score | German | Open | Employer application URL | Result |
|---|---:|---|---|---|---|
| Akros AG — Senior Agile Test Engineer | 95% | **Required**: “You are proficient in German and English and/or French” | open | jobs.ch listing only | Excluded: German + already has a verified prior submission |
| Swiss Life AG — QA & Test Manager | 95% | **Required**: “you communicate confidently in German and English” | open | jobs.ch listing only | Excluded: German |
| ti&m AG — Professional / Senior Test Engineer | 94% | **Required**: “Good German level (min. C1)” | open | jobs.ch listing only | Excluded: German |
| Telecom26 AG — Test Engineer | 92% | Absent; live page states “English (Fluent)” | open | jobs.ch listing only; page routes applications by email | Excluded: no verified employer application form URL; aggregator/email-only |
| Digt AG — QA Engineer 80–100% | 92% | Absent | **unverified**; published 2026-01-11 | jobs.ch listing only | Excluded: vacancy not confirmed open; aggregator-only URL |
| ifolor Group — QA Engineer | 92% | **Required**: “Sehr gute Deutsch- und Englischkenntnisse” | unverified | employer careers page | Excluded: German |
| Akros AG — SDET (Zürich) | 88% | **Required** | unverified | jobs.ch listing only | Excluded: German |
| Akros AG — SDET (Bern) | 88% | **Required** | unverified | jobs.ch listing only | Excluded: German |
| univativ Schweiz AG — Senior Test Automation Engineer | 85% | **Required**: “Verhandlungssichere Deutschkenntnisse in Wort und Schrift” | open | jobs.ch listing only; live page routes to email/online form on univativ.ch | Excluded: German |

The only open, non-German vacancy (Telecom26) is English-fluent but publishes an email application route and a jobs.ch listing, not a verified employer-hosted application form. Applying by email would breach “do not contact employers separately” and is outside the supported executor. Digt is not confirmed open and is months old. The remaining open roles require German. No condition was weakened to manufacture a test.

## 7. Employer and application URL provenance

- Akros, Swiss Life, ti&m, Telecom26, Digt, univativ: stored `application_url` is the jobs.ch detail page (`https://www.jobs.ch/en/vacancies/detail/...`). The existing provenance gate classifies jobs.ch as an aggregator, so these URLs cannot be used as employer application endpoints.
- ifolor: stored URL is the employer careers page (`https://careers.ifolor.com/...`) but the role requires German.
- No row in the qualified registry has a non-aggregator, verified employer application URL.
- No employer URL was guessed or invented.
- Live pages were read over HTTPS for verification only; no form was opened or submitted.

## 8. Qualification score

No vacancy was selected. The closest non-German candidates scored 92% (Telecom26, Digt), above the 85% floor, but failed the open-status/provenance conditions. The 85% threshold was not changed.

## 9. Mandatory language analysis

- Telecom26 live page: “English (Fluent)”; no German mention; analyzer status `absent`.
- Digt live page: no German requirement; analyzer status `absent`; but the vacancy is not confirmed open.
- univativ live page: “Verhandlungssichere Deutschkenntnisse in Wort und Schrift” → `required`.
- ifolor live page: “Sprachen: Sehr gute Deutsch- und Englischkenntnisse in Wort und Schrift” → `required`.
- Akros, Swiss Life and ti&m stored descriptions contain mandatory German formulations → `required`.

## 10. Browser execution steps

No real employer form was opened or executed. The local executor was verified independently (section 5). No CAPTCHA, MFA, login, payment or legal declaration was encountered because no eligible employer form was reached.

## 11. Actual submission outcome

**No new application was submitted. Outcome for this acceptance test: blocked before employer contact.**

Reason: no genuine registry vacancy satisfies all mandatory conditions (open, employer-verified application endpoint, no German, ≥85%, no prior verified submission, no uncertain prior attempt, supported channel).

## 12. Employer-generated confirmation evidence

None for this acceptance test, because no new submission occurred. No confirmation is claimed.

There is one pre-existing record in the live database:

- Akros AG — Senior Agile Test Engineer, application `app_212809afdc2186d0b4509e94`, submitted 2026-11-23T09:01:14.809Z, recorded channel `employer_portal`, reference “Application sent successfully, Abubakar! You will receive a confirmation at zubeir.abubakar525@gmail.com.”
- This was a manually recorded submission (`submission_evidence.source = manual_record`), not an autonomous Noor execution and not this acceptance test.
- It is now a **compliance finding**: the same vacancy contains a mandatory German requirement (“proficient in German and English and/or French”). The job has been reclassified `ineligible`; the historical submitted record was preserved, not rewritten.

## 13. Database status after execution

- Jobs: 66 total; 18 with `german_requirement=required`; 0 ambiguous; 2 still eligible and qualified (Telecom26, Digt).
- Zero rows with `german_requirement=required` remain eligible or qualified.
- Akros applied row: `status=applied`, `eligibility=ineligible`, `qualified=0`, `german_requirement=required`; application remains `submitted`/`verified`.
- Applications: 1 verified (Akros, historical), 3 rejected/blocked (Swiss Life, ti&m, univativ — German), 1 `human_intervention_required`/blocked (Telecom26, no server-rendered form).
- Requalification sweep changed 18 job records and aligned dependent applications.
- Database integrity: `pragma integrity_check` → `ok`; `pragma foreign_key_check` → no rows.
- Latest completed run already in the database: `run_b344b98b1706f31bf45408df`, 1 prepared, 0 submitted, 1 intervention; this run predates the new rule and the sweep has since reclassified its German vacancy/application.

## 14. Test results

| Check | Result |
|---|---|
| German regression suite | 9/9 passed |
| Full test suite (`npm test`) | **515/515 passed, 0 failed** |
| TypeScript (`npm run typecheck`) | exit 0 |
| Production build (`npm run build`) | exit 0, Next.js 16.4.6 |
| Database integrity | `ok` |
| Scheduler | `daily_recruitment`, enabled, 12:00, `Europe/Zurich`, weekdays `[1,2,3,4,5,6,7]` |
| Threshold | 85% (unchanged) |
| Daily cap | 3 (unchanged) |
| Browser fixtures | Existing local dynamic-form, CAPTCHA, unknown-question, upload, HTTP-500 and ambiguity tests pass |
| Uncertain submission protection | Existing tests pass; no blind retry introduced |
| Duplicate protection | Existing tests pass |

## 15. Remaining limitations

- No genuine employer application was executed in this phase, because no registry vacancy met every condition. This is a deliberate safe stop, not a successful acceptance test.
- The browser executor is proven locally (launch plus controlled fixtures) but has not been exercised against a real employer form in this phase.
- The registry currently stores aggregator URLs for jobs.ch vacancies; employer application URL resolution remains a prerequisite for real autonomous submissions.
- The pre-existing Akros submission demonstrates that the previous rules allowed a German-required application. It cannot be undone and is preserved as historical evidence.
- `provider_usage.cost_status='verified'` count is 0, so zero cost is recorded but not independently verified by provider metadata.

## 16. Explicit CHF 0.00 expenditure evidence

```text
SELECT COUNT(*) calls, COALESCE(SUM(cost_chf), 0) cost_chf,
       COALESCE(SUM(CASE WHEN cost_status='verified' THEN 1 ELSE 0 END), 0) verified_calls
FROM provider_usage;

calls  cost_chf  verified_calls
152    0.0       0
```

Recorded expenditure is **CHF 0.00** across 152 provider-usage rows. `AI_BUDGET_LIMIT_CHF=0`, paid models and billing fallbacks remain disabled. Because `cost_status='verified'` is zero, the report does not claim provider-verified zero pricing; it claims no charge was recorded.

---

## Final classification

| Item | State |
|---|---|
| German hard exclusion implemented | **Yes** |
| German exclusion tested with local fixtures/strings | **Yes, 9/9** |
| German exclusion applied to the live registry | **Yes, 18 reclassified** |
| Browser runtime verified locally | **Yes (Chromium 159.0.8154.6)** |
| Genuine real-employer vacancy selected | **No suitable vacancy** |
| Real employer contacted in this phase | **No** |
| New application actually submitted and verified | **No** |
| Blocked / not proven | **Real-world submission and employer confirmation** |
