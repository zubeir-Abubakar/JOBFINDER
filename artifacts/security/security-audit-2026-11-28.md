# Security audit and remediation — JOBFINDER / AT AI Workforce

Date: 2026-11-28
Repository: `zubeir-Abubakar/JOBFINDER` (branch `main`)
Trigger: GitHub reported an exposed Google API key in `.tmp/phase5/digt_kontakt.html`
line 491, commit `2b847142`.

**No credential value appears in this document.** Findings are identified by
pattern, path, length and a truncated SHA-256 so they can be correlated without
re-exposing the secret.

## Verdict

Every critical and high-severity issue that can be closed inside this clone is
now closed and verified. The published history has **not** been rewritten (no
push was made) and the exposed key has **not** been rotated, so the repository is
**not production-ready yet**. Those two steps are owner actions (sections C and D).

## 1. Google API key ownership

**Finding: the key is overwhelmingly likely to belong to the third-party employer
site, not to this application.**

Evidence, all from the saved page itself:

- The key is only ever loaded by
  `<script id="maps-api-js" src="//maps.googleapis.com/maps/api/js?key=…&ver=7.1.5">`.
- That tag is injected by the `map-me` WordPress plugin, whose own assets load
  from `https://digt.ch/wp-content/plugins/map-me/…?ver=7.1.5` — the same version
  string as the Maps API query.
- The document is digt.ch markup throughout: canonical
  `https://digt.ch/kontakt/?lang=de`, `wp-content`, `wp-json`, WPML, Ninja Forms,
  WordPress generator `7.1.5`.
- The application never references `maps.googleapis.com`, `GOOGLE_MAPS`, or any
  Maps API key in `app/`, `lib/`, `components/`, `scripts/` or `.env.example`. Its
  only Google credential is `GEMINI_API_KEY` (a different key type and product).
- No other saved page in `.tmp/` carries a Maps key.

The page was captured during employer research, so the key was copied into this
repository as part of a third party's HTML. Ownership cannot be confirmed from
the repository alone (that requires the Google Cloud project list), so:

- **Do not revoke it as if it were ours.** If it belongs to Digt, revoking it could
  break their public contact map.
- Ask the owner to check the Google Cloud console for a project containing this
  key (fingerprint: prefix `AIza`, 39 characters, SHA-256 `c93cc8e3b6`). If no
  project of ours contains it, treat it as Digt's: notify them, do not rotate it.
- Irrespective of ownership, it must not remain in our Git history. That is now
  true locally (section A7) and still pending on the remote (section D).

## A. FIXED AND VERIFIED

### A1 — Live Google API key committed in a tracked artifact (CRITICAL)

- **Affected:** `.tmp/phase5/digt_kontakt.html:491`, commit `2b847142`.
- **Root cause:** saved employer HTML was written into `.tmp/`, which was not
  ignored, so `git add -A` committed 91 scratch files including that page.
- **Fix:** redacted the value locally (`REDACTED_GOOGLE_API_KEY`); untracked
  `.tmp/` and `.checkpoints/` keeping the files on disk; added explicit ignore
  rules; removed both directories from every commit (A7).
- **Verified:** `node scripts/secret-scan.mjs` passes; `--history` passes;
  `git log --all --name-only` contains no `.tmp/` path.

### A2 — 91 tracked temporary/debug artifacts (HIGH)

- **Affected:** `.tmp/**` (91 files), `.checkpoints/**` (3 files).
- **Fix:** rewrote `.gitignore` (all `.env.*` except `.env.example`, key/cert
  material, temp/debug, build output, test artifacts, runtime DB/uploads/backups,
  logs, editor/OS noise); untracked both trees.
- **Verified:** `.tmp/`, `.checkpoints/`, `.env`, `artifacts/backups/` resolve to
  ignore rules; `.env.example` remains tracked; 612 files tracked.
- The two diagnostic token dumps were checked read-only against the local
  `sessions` table: neither matched a live `token_hash`.

### A3 — Secret scanning was a false green (HIGH)

- Rewrote `scripts/secret-scan.mjs`: scans every tracked file, staged content, and
  with `--history` every blob in every commit. Provider formats are enforced in
  tests too; generic assignment matching is limited to non-test trees with an
  entropy check; placeholder detection applies to the matched value, not the line;
  output is redacted (path, line, pattern, length, 4-char prefix, SHA-256).
- Patterns now live in `scripts/secret-patterns.mjs`, shared with the purge, so
  there is one definition of "credential-shaped".
- **Verified:** exit 1 on findings (the pre-commit hook blocked a synthetic probe
  and my own comment that contained a `re_…`-shaped token); exit 0 on the current
  tree and history.

### A4 — Credential-shaped test fixtures (MEDIUM)

- `tests/resend-delivery.test.ts` and `tests/executive-brief-resend.test.ts` now
  assemble fixtures at runtime, so no `re_…` literal exists while
  `/^re_[A-Za-z0-9_-]{8,}$/` validation still runs. Both pass.

### A5 — No pre-commit or CI gate (MEDIUM)

- Added `scripts/install-hooks.mjs` (fail-safe, never overwrites a foreign hook),
  `prepare`, and `.github/workflows/security.yml` with three zero-cost jobs:
  tree+history secret scan, `npm audit --audit-level=high`, and typecheck + unit
  tests + build. First-party actions only, no artifacts, no secrets.
- **Verified:** hook installed and empirically blocked a staged credential-shaped
  value without printing it.

### A6 — Committed SQLite backups under `artifacts/` (HIGH, found this phase)

- **Affected:** `artifacts/backups/at-ai-workforce-*.db` (+ `.db-shm`, `.db-wal`),
  introduced by commit `d43cb94`.
- **Exposure:** real application data — 1 user, 10 sessions (token hashes),
  1 `gmail_accounts` row (AES-GCM encrypted tokens), 40 documents, 5 applications,
  175 audit rows. This is authentication material and personal data, not a
  generated report.
- **No plaintext provider key** was found in either file (strong-format scan).
- **Fix:** untracked the directory (files kept locally), added
  `artifacts/backups/` to `.gitignore`, and added the path to the history purge.
- **Verified:** no `artifacts/backups/` path exists in any commit; history scan
  passes; the local files are ignored.

### A7 — Local Git history purge executed (CRITICAL, local only)

- **Authorised scope:** local rewrite only. **No push, no force-push, no remote
  change, no deployment.**
- **Pre-flight:** branch `main`; remote `https://github.com/zubeir-Aubakar/JOBFINDER.git`;
  clean tree; purge script reviewed; dry run exit 0; verified 67 MB bundle backup
  (`backups/pre-purge-20261128T132506Z.bundle`, gitignored, `git bundle verify`
  reports a complete history).
- **Result:** 12 commits rewritten (plus the later remediation commits). `.tmp/`,
  `.checkpoints/` and `artifacts/backups/` are absent from every commit. The
  three candidate values (the Google key and the two Resend-shaped historical
  fixtures) were replaced with `***REMOVED***`; no other file content changed.
- **Source integrity:** the rewritten `HEAD` tree is byte-identical to the
  pre-purge tree outside the purged paths (`git diff` empty), and the tracked file
  count/source paths are unchanged. No identifier or unrelated line was rewritten
  (see A9).
- **Cleanup:** reflogs expired and unreachable objects pruned, so the old commit
  objects are no longer reachable; the verified bundle remains the recovery path.

### A8 — Gmail OAuth callback had no session check and no replay defence (MEDIUM)

- **Before:** the callback exchanged any valid Google code as long as a signed
  `state` matched a cookie scoped to `/api/gmail/oauth`. It did not require a
  live session, was not bound to a user, and the only single-use property was the
  browser deleting the cookie.
- **Fix:**
  - the callback now calls `currentUser()` and redirects to `/login` without one;
  - state is `{nonce, user id, issued-at}` under an HMAC, valid for 10 minutes;
  - `consumeOAuthState()` requires the exact cookie, the same user id, and inserts
    the nonce into a durable `oauth_states` table (`PRIMARY KEY`, `ON CONFLICT DO
    NOTHING`), so a replay fails even when URL and cookie are both captured;
  - rejections are audited (`gmail.oauth_state_rejected`) with the user id and IP,
    and never include the state value.
- **Verified:** `tests/oauth-state.test.ts` (signature, expiry, skew, user
  binding, cookie binding, one-time use, stale-nonce pruning) and
  `tests/session-security.test.ts` (token→account binding, hashed storage,
  expiry, disabled account, per-session isolation) pass; E2E proves the start
  route issues an httpOnly state cookie, the forged callback returns 307 with the
  error and connects nothing, and an unauthenticated callback redirects to login.

### A9 — Defects in the purge tooling found and corrected (process)

Two bugs were found by actually executing the procedure, not by reading it:

1. The apply path ran `node scripts/purge-index.mjs` relative to `.git-rewrite/t`,
   so the second filter pass failed. Fixed to use the absolute repository path.
2. The first successful run replaced unanchored matches, corrupting identifiers
   such as `score_at_or_above_threshold` → `sco***REMOVED***` in 9 files. The
   replacement list is now built by `scripts/purge-values.mjs` from the scanner's
   word-boundary patterns; the candidate set is exactly the 3 real values. The
   aborted rewrite was rolled back from the bundle before re-running.

This is why the final verification compares the whole rewritten tree, not just
the presence of the files.

### Controls audited and found sound (no change)

- **Authentication:** scrypt + per-password salt, constant-time compare, dummy
  hash for unknown accounts, durable login/MFA throttling from audit rows,
  TOTP with step replay tracking, one-time recovery codes, hashed session tokens,
  `httpOnly`/`SameSite=Lax`/`Secure` cookies, session rows deleted on
  logout/expiry/disable.
- **Authorization:** all 24 route handlers gated. Document and avatar routes
  enforce ownership (`path.basename`, `Cache-Control: private, no-store`, only
  PDFs inline). `/admin` requires `role === "admin"` server-side.
- **Explicit non-session gates:** `/api/health` (loopback or constant-time bearer,
  404 otherwise), `/api/webhooks/resend` (Svix signature), `/api/cron/recruitment`
  (constant-time `CRON_SECRET`/loopback).
- **CSRF/Host:** `proxy.ts` rejects cross-site writes; a spoofed `Host` header did
  **not** change the redirect origin in a live probe (Next pinned it to
  `localhost`), so the redirect helper is not host-header injectable.
- **Headers/CSP:** per-request nonce CSP with `strict-dynamic`, `object-src 'none'`,
  `frame-ancestors 'none'`, `script-src-attr 'none'`; HSTS in production;
  nosniff, DENY, Referrer-Policy, Permissions-Policy, COOP/CORP.
- **SSRF/uploads/SQL:** connect-time validation with revalidation per redirect;
  magic-byte upload typing; prepared statements throughout (only two hard-coded
  identifiers interpolated).
- **Agents:** no shell, `shell:false`, closed allowlist, argv rebuild, minimal
  env, timeouts, output caps, per-agent least privilege, retrieved content tagged
  untrusted and injection-scanned.
- **Admin audit logging:** already comprehensive — user create/disable/reset,
  MFA reset, AI/email/security config, provider tests, backup, session purge,
  retention, agent toggles/voice/config, workflow pause/stop, document and
  application actions, Gmail connect/disconnect/sync/draft/send.
- **Rate limiting:** `lib/api-rate-limit.ts` is a durable SQLite limiter
  (`BEGIN IMMEDIATE`, bounded key count) and `lib/login-throttle.ts` derives
  attempts from audit rows, so restarts and multiple processes sharing the
  database cannot reset the window.
- **Zero cost:** unchanged. No dependency or paid service added; `npm audit`
  reports 0 vulnerabilities.
- **Recruitment policy:** unchanged — daily 12:00 Europe/Zurich, automatic
  submission when eligible, existing thresholds, approval and notification rules.

## B. UNRESOLVED / RESIDUAL RISK

| # | Item | Severity | Why it is open |
|---|------|----------|----------------|
| B1 | Exposed key still valid | **Critical** | Only the owner can confirm the project and rotate/restrict it. If it is Digt's, rotation is theirs; revocation is unverifiable from here. |
| B2 | Remote `main` still contains the key and the DB backups | **Critical** | Local history is purged; publishing the rewrite is a force-push (section D), which was explicitly not authorised. |
| B3 | GitHub protections not enabled | Medium | Secret scanning, push protection, Dependabot and branch protection are repository settings, not files. |
| B4 | Screenshots and investigation notes contain owner PII | **Resolved** | 78 PNGs of the owner dashboard/profile/CVs, two live-call recordings and a note containing the owner's address were tracked. No credential found. All 81 files are now untracked, kept on disk, and ignored (`.gitignore`). The files remain in published history until D1 rewrites it. |
| B5 | Rate limiting is single-host | Low | Durable across processes that share the SQLite file, but not a distributed limiter for horizontally scaled replicas. The deployment is a single host; a shared store would be required to scale out. |
| B6 | Pre-purge backup bundle holds the old history | Medium (local) | `backups/pre-purge-20261128T132506Z.bundle` contains the exposed key by design, so the purge is reversible. It is gitignored and must be deleted once the rewrite is accepted. |
| B7 | Desktop-chromium Playwright project not re-run | Low | Auth, admin, schedules, mobile, visual, voice and integration projects pass (17 passed, 3 skipped by design, 0 failed, 0 flaky with retries disabled). The `desktop-chromium` project was not part of this run; `npm run test:e2e` covers everything but `integration`. |
| B8 | Other remote branches | Info | `checkpoint/*`, `feature/oracle-mobile-migration` and tag `phase2-baseline-2026-11-19` were checked: no `.tmp`/backups path at their tips and no key-shaped value in their histories. No action needed. |
| B9 | A `git fetch` restores the old objects until D1 | Medium (local) | A background fetch during this audit reset `origin/main` to the published `2b847142` and brought the old blobs back into `.git`. The scanner correctly flagged it. `origin/main` was re-pointed and the objects re-pruned, but **do not fetch between the purge and the force-push**; if you do, re-point `refs/remotes/origin/main` and re-run `git gc --prune=now`. |

## C. MANUAL ACCOUNT-OWNER ACTIONS

**C1 — Establish ownership of the key and rotate only if it is ours.**
Fingerprint: prefix `AIza`, 39 characters, SHA-256 `c93cc8e3b6`. Check the Google
Cloud project list. If it is ours: delete it and, if still needed, recreate it
restricted by API and HTTP referrer. If it is Digt's: notify them; do not revoke a
third party's key. Record the outcome in this file only after independent
verification.

**C2 — Check for other copies.** Any fork, CI log, chat paste or screenshot of
commit `2b847142` still contains the key (and `d43cb94` contains the database
dump). Rotation is the only control that makes copies harmless; the history
rewrite only removes our copy.

**C3 — Tracked artifacts (done).** The screenshots, voice recordings and
investigation notes are untracked and ignored (B4). They stay in published
history until D1; only then are they gone from the remote. Anything still under
`artifacts/` that names the owner (`artifacts/reset/` manifests the CV filenames
and host details) can be untracked the same way if the repository becomes
public.

**C4 — Delete the backup bundle** after accepting the rewrite:
`rm backups/pre-purge-20261128T132506Z.bundle`. Until then it is the rollback.

## D. REMOTE GITHUB ACTIONS REQUIRING AUTHORISATION

Nothing here has been executed. These change shared state.

**D1 — Publish the rewritten `main` (rewrites published history).**

```bash
# Confirm what the remote currently points at (read-only).
git ls-remote origin refs/heads/main
# Expected at audit time: 2b8471422c71a6eb9dc51b230fb580a4ff6bfd4f

# The local remote-tracking ref was rewritten by the purge, so a bare
# --force-with-lease would report stale info. Name the expected remote value.
git push --force-with-lease=main:2b8471422c71a6eb9dc51b230fb580a4ff6bfd4f origin main
```

Do not run `git fetch` between the purge and this push: the remote still holds
the old history, so a fetch re-points `origin/main` at it and re-imports the
blobs (B9). Collaborators must re-clone; an existing clone can push the old
objects back.

**D2 — Enable repository protections** (Settings → Code security): secret
scanning, push protection, Dependabot alerts, and branch protection requiring the
`security` workflow. Consider making the `security` workflow a required check.

**D3 — Notify collaborators / forks** that history was rewritten, and treat the
old key as compromised in any external copy until C1 is resolved.

## Verification performed (final state)

| Check | Command | Result |
|-------|---------|--------|
| Tracked-file secret scan | `node scripts/secret-scan.mjs` | **Pass**, exit 0 |
| Staged-file secret scan | pre-commit hook / `--staged` | **Pass**; hook blocked a synthetic probe |
| History secret scan | `node scripts/secret-scan.mjs --history` | **Pass**, exit 0 (re-run after re-pointing the fetched `origin/main`; see B9) |
| Purge path removal | `git log --all --name-only` | No `.tmp/`, `.checkpoints/`, `artifacts/backups/` |
| Rewrite scope | `git diff <pre-purge> HEAD` (excluding purged paths) | **Empty** — no unrelated content changed |
| Identifier integrity | `git grep '\*\*\*REMOVED\*\*\*' -- lib tests app components` | None at HEAD |
| `.env.example` | `git ls-files .env.example` | Tracked, not ignored |
| Ignore rules | `git check-ignore -v …` | `.tmp/`, `artifacts/backups/`, `artifacts/**/*.png`, `artifacts/**/*.wav`, `artifacts/investigations/`, `.env` ignored; `.env.example` not |
| Personal artifacts | `git ls-files artifacts/` | 0 PNG, 0 WAV, 0 investigation notes tracked; `artifacts/security/security-audit-2026-11-28.md` still tracked |
| E2E mobile/visual/voice/integration | `npx playwright test --project=setup --project=mobile-chromium --project=visual-chromium --project=voice-chromium --project=integration --retries=0` | 17 passed, 3 skipped (opt-in `GEMINI_REAL_E2E`), 0 failed, 0 flaky |
| Voice pipeline stability | `--project=voice-chromium e2e/voice.spec.ts --repeat-each=3 --retries=0` | 3/3 passed before the full run |
| Dependencies | `npm audit --audit-level=high` | 0 vulnerabilities |
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm run test:unit` | 753 tests, 749 pass, 4 skipped, **0 fail** |
| Production build | `npm run build` | exit 0 |
| E2E — auth/security | `playwright test --project=auth-chromium` | **14/14 pass** (login, logout, expiry, CSRF, doc isolation, OAuth start/callback) |
| E2E — admin & schedules | same run, `admin-chromium` + `schedules-chromium` | **7/7 pass** (admin authz, audit explorer, 12:00 schedule cards); **21/21 total** for the three projects |
| Host-header probe | `curl -H 'Host: attacker.example'` | Redirect origin unchanged (`localhost`) |

Playwright projects for mobile, visual, voice and integration were not run (B7).

## Files changed in this phase

| File | Change |
|------|--------|
| `.gitignore` | `artifacts/backups/` ignored (database dumps) |
| `app/api/gmail/oauth/callback/route.ts` | Session required, user-bound single-use state, rejection audit |
| `app/api/gmail/oauth/start/route.ts` | State bound to the signed-in user |
| `lib/gmail.ts` | Signed expiring state, `consumeOAuthState`, durable nonce store |
| `lib/db.ts` | `oauth_states` table + expiry index |
| `scripts/secret-patterns.mjs` | Shared word-boundary credential patterns |
| `scripts/purge-values.mjs` | Purge values from the shared patterns |
| `scripts/secret-scan.mjs` | Uses the shared patterns |
| `scripts/purge-history-secrets.sh` | Absolute filter path, shared value selector, new purged path |
| `tests/oauth-state.test.ts`, `tests/session-security.test.ts` | New unit coverage |
| `e2e/auth.spec.ts` | Session expiry, CSRF, document isolation, OAuth start/callback |
| `e2e/voice.spec.ts` | Playback assertion removed from the fixed-order stage loop; first spoken turn gets a 60s budget |
| `artifacts/backups/**` | Untracked (files kept locally) |
| `artifacts/**/*.png`, `artifacts/**/*.wav`, `artifacts/investigations/**` | Untracked and ignored (files kept locally) |
| `.gitignore` | Ignore the personal captures; keep the security report tracked |

## Recovery

The verified bundle `backups/pre-purge-20261128T132506Z.bundle` restores the
pre-purge repository:

```bash
git clone backups/pre-purge-20261128T132506Z.bundle recovered-repo
```

It contains the exposed key, so delete it after accepting the rewrite (C4).

## Remaining risk statement

The local clone no longer contains a credential-shaped value in any commit, and
the newly found database dumps are gone from history. The exposure is not closed
until the key is rotated or confirmed as a third party's (C1) and the rewritten
`main` replaces the published history (D1). Until then, treat the key as
compromised and the repository as **not production-ready**.
