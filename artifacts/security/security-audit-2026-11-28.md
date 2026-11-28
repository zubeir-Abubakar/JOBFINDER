# Security audit and remediation — JOBFINDER / AT AI Workforce

Date: 2026-11-28
Repository: `zubeir-Abubakar/JOBFINDER` (branch `main`, 10 commits)
Trigger: GitHub reported an exposed Google API key in `.tmp/phase5/digt_kontakt.html` line 491, commit `2b847142`.

**No credential value appears in this document.** Findings are identified by
pattern, path, length and a truncated SHA-256 so they can be correlated without
re-exposing the secret.

## Verdict

The working tree is now clean of credential-shaped values and the leak vectors are
closed, but **the repository is not production-ready yet**: the key is still
present in the **published Git history** until the prepared purge is applied to the
real clone and the credential is rotated. Both steps need the owner (see
section C).

## Method

1. Enumerated every tracked path (`git ls-files`, 545 files at the start).
2. Pattern-scanned each file for Google/Gemini, OpenAI/Anthropic/Groq, Resend,
   GitHub, Slack, AWS, Supabase, database-URL, JWT, bearer-token and private-key
   formats. Values were hashed and truncated, never printed.
3. Scanned every blob in every commit reachable from `--all`.
4. Read the authentication, session, CSP, SSRF, rate-limit, upload, webhook and
   agent-tool implementations in full rather than inferring from file names.
5. Enumerated all 24 API route handlers and checked the gate on each.
6. Remediated, then re-scanned, re-tested and rebuilt.

## A. FIXED AND VERIFIED

### A1 — Live Google API key committed in a tracked artifact (CRITICAL)

- **Affected:** `.tmp/phase5/digt_kontakt.html:491` (Google Maps script `src`), commit `2b847142`.
- **Root cause:** saved employer career-page HTML was written into `.tmp/` and
  `.tmp/` was never in `.gitignore`, so `git add -A` committed 91 scratch files
  including a page that carried a real key in a `<script src>` query string.
- **Fix:** redacted the key in the local file (`REDACTED_GOOGLE_API_KEY`); removed
  `.tmp/` and `.checkpoints/` from tracking (`git rm -r --cached`, files kept on
  disk); added explicit `.tmp/` and `.checkpoints/` rules to `.gitignore`.
- **Verification:** `node scripts/secret-scan.mjs` → passes on tracked files.
  `git check-ignore -v .tmp/phase5/digt_kontakt.html` → matched by the `.tmp/` rule.
- **Residual:** still in history until C2 is executed; the credential itself must be
  rotated (C1).

### A2 — 91 tracked temporary/debug artifacts, including token dumps (HIGH)

- **Affected:** `.tmp/**` (91 files), `.checkpoints/**` (3 files).
- **Root cause:** see A1; `.gitignore` covered `node_modules/`, `.next/`, `data/`
  and a few report directories but not scratch/debug output, `.env.*`, `.vercel/`,
  `dist/`, `coverage/` or key material.
- **Fix:** rewrote `.gitignore` (dependencies, all env variants with
  `!.env.example`, key/cert material, temp+debug, build output, test artifacts,
  runtime DB/uploads/backups, logs, editor/OS noise). Untracked both directories.
- **Verification:** 94 staged deletions; `.env.example` still tracked and not
  ignored; `.env`, `.env.local`, `.env.production`, `.vercel/x`, `.agent-reach/`,
  `.tmp/…` all resolve to a `.gitignore` rule.
- **Note:** `.tmp/diag-token.txt` (32 chars) and `.tmp/phase6/diag-token.txt`
  (64 chars) were tested against the local `sessions` table (read-only):
  neither matches a live `token_hash`, so no active session was exposed. They were
  still removed from tracking because a diagnostic dump of an auth token must never
  be committable.

### A3 — Secret scanning was a false green (HIGH)

- **Affected:** `scripts/secret-scan.mjs`.
- **Root cause:** it only walked `app lib components scripts deploy` plus three
  root files, and skipped any line matching `/test|fixture|example|…/`. It
  therefore reported "passed" while the key sat in a tracked file, and it could
  never have scanned the directory that leaked.
- **Fix:** rewrote it to scan **every tracked file** plus staged content and, with
  `--history`, every blob in every commit. High-signal provider formats are
  enforced everywhere (tests included); generic `secret = "…"` matching is limited
  to non-test trees with an entropy check. Placeholder detection now applies to the
  **matched value**, not the line, so a line mentioning "example" is still scanned.
  Matches print only path, line, pattern, length, first 4 chars and SHA-256.
- **Verification:** baseline run in a scratch clone reports the three real history
  findings it used to miss; current tracked scan is clean; exit code 1 on findings.

### A4 — Credential-shaped fixtures would trip push protection (MEDIUM)

- **Affected:** `tests/resend-delivery.test.ts:30`, `tests/executive-brief-resend.test.ts:13`.
- **Root cause:** fixtures used literal `re_…` values. `lib/resend.ts` validates
  `/^re_[A-Za-z0-9_-]{8,}$/`, so the fixture cannot simply be mangled without
  weakening a real check.
- **Fix:** assembled at runtime from fragments (`["re","fixture","not","live","0000"].join("_")`),
  so no credential-shaped literal exists in source while the real format
  validation still runs.
- **Verification:** both files pass (`exit=0`, zero `not ok`); the tracked scan is clean.

### A5 — No pre-commit or CI security gate (MEDIUM)

- **Affected:** repository root — no `.github/`, no hooks, no `prepare` script.
- **Fix:** added `scripts/install-hooks.mjs` (fail-safe; never overwrites a foreign
  hook), a `prepare` npm script that installs it, and
  `.github/workflows/security.yml` with three zero-cost jobs: secret scan (tree +
  history, full checkout), `npm audit --audit-level=high`, and
  typecheck + unit tests + production build. No third-party scanning service, no
  artifact upload, no secrets in the workflow (synthetic env only).
- **Verification:** installed hook and tested it — staging a synthetic
  `AIza…`-shaped file made `.git/hooks/pre-commit` exit 1 and the file was removed
  from the index afterwards; the probe value was never printed.

### A6 — Dependency vulnerabilities (INFO)

- `npm audit`: 0 low / 0 moderate / 0 high / 0 critical, total 0. No upgrade needed,
  so nothing was changed in `package.json` dependency ranges.

## B. NOT FIXED / RESIDUAL RISK

| # | Item | Severity | Reason it is open |
|---|------|----------|-------------------|
| B1 | Key remains in published history (`2b847142`) | **Critical** | Rewriting `main` and force-pushing is destructive and requires explicit owner authorisation. The procedure is written and **verified on a scratch clone**, not applied to the real branch. |
| B2 | Credential still valid | **Critical** | Only the key owner can revoke/rotate it. Revocation cannot be verified from this repository. |
| B3 | No `.github` protection configured server-side | Medium | Branch protection, secret scanning and push protection are GitHub account/repo settings, not files. Workflow exists; protection must be enabled in the UI. |
| B4 | 44 MB of committed screenshots/reports under `artifacts/` | Low | No credential found in them, but they are generated evidence and may contain personal data from the owner's own dashboard/CVs. Left tracked deliberately (they are referenced documentation); recommend review before making the repo public. |
| B5 | Gmail OAuth callback does not re-assert the session | Low | It relies on a signed `state` bound to an httpOnly cookie scoped to `/api/gmail/oauth`; the cookie is only issued to an authenticated user. Acceptable for a single-owner deployment, but a `currentUser()` check in the callback would be stricter. |
| B6 | In-process rate limiting | Low | `lib/api-rate-limit.ts` and `lib/security.ts` keep counters in memory, so limits reset on restart and do not span instances. Documented behaviour; a single-process local deployment is the intended shape. |
| B7 | Playwright suite not re-run in this audit | Low | No UI, route, scheduler or agent code changed; unit + typecheck + build were run. E2E should still be run before the next release. |

### Controls audited and found already sound (no change needed)

- **Authentication:** scrypt password hashing with per-password salt, constant-time
  compare, dummy-hash verification for unknown accounts (timing), per-account+IP
  login throttling, MFA/TOTP with replay step tracking and one-time recovery codes,
  hashed session tokens, `httpOnly` + `SameSite=Lax` + `Secure` cookies, session
  rows deleted on logout/expiry/disable.
- **Authorization:** all 24 route handlers enumerated. Every data route calls
  `currentUser()`; `/admin` requires `role === "admin"` server-side; document and
  avatar routes check ownership (and `path.basename` on stored paths); workflow
  control re-checks the workflow belongs to the user.
- **Explicit gates rather than sessions:** `/api/health` (loopback or constant-time
  bearer `HEALTHCHECK_TOKEN`, 404 otherwise), `/api/webhooks/resend` (Svix
  signature, 503 when unconfigured), `/api/cron/recruitment` (constant-time
  `CRON_SECRET`, or direct loopback only outside production).
- **CSRF:** `proxy.ts` rejects cross-site state-changing API calls
  (`Sec-Fetch-Site`/`Origin` vs `Host`) and enforces SameSite cookies.
- **Headers/CSP:** per-request nonce CSP with `strict-dynamic`, `object-src 'none'`,
  `frame-ancestors 'none'`, `script-src-attr 'none'`; HSTS in production;
  `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy`, COOP/CORP, `X-Permitted-Cross-Domain-Policies`.
  No wildcard CORS anywhere.
- **SSRF:** `safe-http.ts` validates at connect time via a custom `lookup` (immune to
  DNS rebinding), revalidates every redirect, blocks metadata/loopback/private/
  CGNAT/ULA ranges, rejects credentials in URLs and non-http(s) schemes, and caps
  response size. Covered by `tests/security-hardening.test.ts`.
- **Uploads:** magic-byte detection overrides a lying MIME type
  (`detectDocumentType`), HTML/unknown types are forced to `application/octet-stream`,
  only PDFs may render inline, filenames are `basename`d, size caps enforced.
- **SQL:** SQLite with prepared statements and `?` placeholders throughout;
  the only interpolated SQL identifiers are two hard-coded literals in
  `lib/dashboard-live.ts` (`agent_key`, `provider`), not user input.
- **Agent security:** no shell from chat; the single `spawn` in
  `lib/agent-reach.ts` uses `shell: false`, a project-pinned binary, a closed
  channel/action allowlist, argv rebuilt from validated fields (leading `-`
  rejected), a minimal env allowlist (no app secrets), 25 s timeout, 1.5 MB stdout
  cap and concurrency 2. Retrieved content is tagged `trusted: false`, wrapped as
  evidence, and injection-scanned. Per-agent grants are least-privilege and a
  specialist cannot be impersonated (`delegateResearch` only from `coordinator`).
  Shell/SQL/credential capabilities are declared prohibited, not merely ungranted.
- **Zero cost:** unchanged. `npm audit` clean, no new dependency, no paid service
  added. `tests/zero-cost.test.ts`, `ai-spending-policy.test.ts`,
  `free-tier-policy.test.ts` all pass.
- **Recruitment policy:** untouched — daily 12:00 Europe/Zurich schedule, the
  missed-occurrence policy, eligibility checks and approval rules are unchanged and
  their tests pass.

## C. MANUAL ACTION REQUIRED (owner)

**C1 — Rotate the exposed key (do this first).**
In Google Cloud console, identify the project that owns the flagged key, then
delete/rotate it and, if it is still needed, recreate it restricted to the required
APIs and HTTP referrers. A purge is not a substitute for rotation: assume the value
has been public since the commit was pushed. If the key turns out to belong to the
employer whose page was saved (`digt_kontakt.html` is a third-party site), notify
them rather than assuming it is ours.

**C2 — Apply the verified history purge, then force-push with lease.**
The purge is verified on a scratch clone (paths removed from all 10 commits, 20
literal values replaced, post-rewrite history scan clean). Applying it changes every
commit id from the first touched commit and requires a force-push, so it was not
done here.

```bash
# 1. Review what will change, without touching the real clone (already run: exit 0)
SCRATCH_DIR=.tmp/audit/purge bash scripts/purge-history-secrets.sh

# 2. After rotating the key, rewrite THIS clone (creates a safety bundle first)
APPLY=1 scripts/purge-history-secrets.sh

# 3. Review the rewritten history
git log --oneline --stat -5
node scripts/secret-scan.mjs --history

# 4. Push only with explicit authorisation — this rewrites published history
git push --force-with-lease origin main
# Collaborators must re-clone; existing clones will otherwise resurrect the blobs.
```

**C3 — Enable repository-side protections** (Settings → Code security): secret
scanning, push protection, Dependabot alerts, and branch protection requiring the
`security` workflow.

**C4 — Confirm no other copies.** Any CI log, chat paste, screenshot or fork that
captured commit `2b847142` still contains the key. Rotation (C1) is the only control
that makes those copies harmless.

## Files changed in this audit

| File | Change |
|------|--------|
| `.gitignore` | Full rewrite: env variants, key/cert material, temp/debug, build, test, runtime data, logs |
| `scripts/secret-scan.mjs` | Rewritten: whole-tree + staged + history scopes, provider formats, value-level placeholder rule, redacted output |
| `scripts/install-hooks.mjs` | New: fail-safe pre-commit hook installer |
| `scripts/purge-history-secrets.sh` | New: verified-on-scratch history purge, safety bundle, no push |
| `scripts/purge-index.mjs` | New: fast index-filter replacer used by the purge |
| `.github/workflows/security.yml` | New: secret scan (tree + history), npm audit, typecheck + unit + build |
| `package.json` | Added `prepare`, `secret-scan:history` |
| `tests/resend-delivery.test.ts` | Runtime-assembled fixture; probe value de-shaped |
| `tests/executive-brief-resend.test.ts` | Runtime-assembled fixture |
| `.tmp/**`, `.checkpoints/**` | Untracked (94 paths); files retained locally |
| `artifacts/security/security-audit-2026-11-28.md` | This report |

## Verification performed

| Check | Command | Result |
|-------|---------|--------|
| Tracked-file secret scan | `node scripts/secret-scan.mjs` | **Pass**, exit 0 |
| History secret scan (pre-purge) | `node scripts/secret-scan.mjs --history` | **3 findings**, all from `2b847142` — expected until C2 |
| History purge dry run | `SCRATCH_DIR=… bash scripts/purge-history-secrets.sh` | **Pass**, exit 0 — scratch history clean |
| Pre-commit hook blocks a key | `.git/hooks/pre-commit` on a staged probe | **Blocked**, exit 1, value not printed |
| Ignore rules | `git check-ignore -v …` | `.tmp/`, `.agent-reach/`, `.env.*` ignored; `.env.example` not ignored |
| Dependencies | `npm audit` | 0 vulnerabilities (all severities) |
| Typecheck | `npm run typecheck` | exit 0 |
| Unit/integration tests | `npm run test:unit` | 744 tests, 740 pass, 4 skipped, **0 fail** |
| Production build | `npm run build` | exit 0 |
| Playwright E2E | not run | No UI/runtime code changed (see B7) |

## Remaining risk statement

Until C1 and C2 are complete, a **critical** exposure remains: a valid, unredeemed
credential in a public-facing history and no evidence of revocation. The repository
must not be treated as production-ready, and the next push must not proceed on the
assumption that removing the file from `HEAD` was sufficient.
