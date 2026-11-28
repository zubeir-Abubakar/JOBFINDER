# Second-pass security audit — AT AI Workforce (JOBFINDER)

Date: 2026-11-28
Repository: `zubeir-Aubakar/JOBFINDER`, branch `main` @ `a1116ea`
Scope: independent re-verification of `security-audit-2026-11-28.md` plus new
remediation. No credential value appears in this document.

## A. Executive verdict

**CONDITIONALLY READY** — no open critical or high-severity issue remains in the
application, its tracked tree or its published history. Deployment still depends
on owner-only actions listed in section G (credential ownership/rotation and the
GitHub repository settings, which cannot be read or changed from this machine).

This is not a "99% secure" claim. It is a statement about what was measured:

| Severity | Found this pass | Status |
| --- | --- | --- |
| Critical | 0 | — |
| High | 0 | — |
| Medium | 2 | Both fixed and covered by tests |
| Low | 2 | Both fixed |

Medium 1 — a password change destroyed the caller's own session while the UI
reported "Other sessions were signed out". Security-relevant (silent logout,
misleading control messaging) and a functional regression. Fixed.
Medium 2 — the secret scanner silently skipped `package-lock.json` and could not
detect a credential embedded in an arbitrary URL or a bare signed JWT. Fixed.
Low 1 — `lib/security.ts` exported an unused in-process rate limiter that would
reset on restart if a future caller used it. Removed.
Low 2 — no synthetic regression tests existed for the scanner's detection
categories. Added (14 cases).

Residual risk: the previously exposed Google Maps key is a third party's and may
still be valid (owner question), and branch protection / secret scanning / push
protection are repository settings that require GitHub access.

## B. Secrets and credentials — independently re-verified

| Check | Command | Result |
| --- | --- | --- |
| Tracked tree | `node scripts/secret-scan.mjs` | PASS, exit 0 |
| All reachable history | `node scripts/secret-scan.mjs --history` | PASS, exit 0 |
| Published `main` | `npm run verify:remote` | PASS — remote tip `a1116ea4` equals local HEAD, 22 commits, no credential-shaped value, no `.tmp/`, `.checkpoints/`, `artifacts/backups/`, database dump or `.env` reachable |
| Dependency advisories | `npm audit --audit-level=high` | 0 vulnerabilities |
| Sensitive paths ignored | `.gitignore` + `git status` | `.env*` (except `.env.example`), `data/`, `backups/`, `artifacts/backups/`, `artifacts/reset/`, screenshots/recordings, `certs/`, `*.db` all ignored |

Remote branch tips were also inspected: each Dependabot branch differs from
`main` by exactly one commit that touches only `package.json`,
`package-lock.json` or `.github/workflows/security.yml`. No branch carries a
superseded secret or a database dump.

No history rewrite was performed. The published history was already clean and
re-verified, so rewriting again would have been unnecessary risk.

## C. Application security — controls re-tested, not re-read

Verified by executing the checks, not by reading the earlier report:

- **Authentication** — scrypt + per-password salt, `timingSafeEqual`, dummy-hash
  verification for unknown accounts (no enumeration), throttling derived from
  durable audit rows (`lib/login-throttle.ts`, 15-minute window), TOTP step
  replay tracking, single-use recovery codes, hashed session tokens, sessions
  deleted on expiry/disable/logout. `tests/session-security.test.ts` 7/7 pass.
- **Authorization / IDOR** — owner and admin surfaces are gated server-side;
  E2E proves an owner cannot enter `/admin` and cannot read another account's
  document (`auth.spec.ts` 14/14).
- **Gmail OAuth** — HMAC state bound to user + nonce + expiry, durable
  single-use nonce table, session required on callback. E2E proves a forged
  state is rejected, nothing connects, and an unauthenticated callback is
  redirected.
- **CSRF** — cross-site state-changing API calls refused (E2E).
- **SSRF** — scheme/host/port validation, private and link-local ranges blocked,
  redirects re-validated, `undici` used with a pinned lookup.
- **Agent isolation** — `spawn` with `shell: false`, argv rebuilt from a closed
  allowlist, minimal environment (no application secrets reach the third-party
  CLI), timeouts, output caps, per-agent channel grants, retrieved content
  tagged `trusted: false` and injection-scanned. The coordinator is the only
  agent permitted to delegate, and the target's own grants are re-checked.
- **Zero-cost AI policy** — providers fail closed without free-tier evidence;
  paid models and billing fallbacks are refused; tests pass.
- **Recruitment policy** — unchanged: one run daily at 12:00 Europe/Zurich,
  85% floor, duplicate blocking, dry-run gate inside the submission function.

## D. GitHub and repository

Branches: `main` plus four Dependabot branches (PRs #1–#4 open) and three local
branches that are fully contained in `main`. Cleanup table and recommendations
are in the accompanying summary; **nothing was deleted**, because deleting
branches and merging PRs require the owner's authorisation and GitHub access.

`gh` is not installed and no token is available, so branch protection, secret
scanning, push protection and Dependabot settings could neither be read nor
changed. `.github/workflows/security.yml` is not evidence of branch protection.

## E. Regression results

| Check | Result |
| --- | --- |
| Typecheck | PASS |
| Unit/integration suite | 765 pass, 0 fail, 4 skipped |
| New scanner tests | 14/14 pass |
| Production build | PASS |
| Playwright `auth-chromium` | 14/14 pass (retries disabled) |
| Secret scan (tree + history) | PASS, exit 0 |
| `npm audit` | 0 vulnerabilities |
| Dependabot grouped npm PR | typecheck + 751 unit tests + build PASS |
| Dependabot undici 8 PR | typecheck + 86 networking/submission tests + build PASS |

The 4 skipped tests are placeholder `test.skip` entries in
`tests/gemini-live-evidence-audit.test.ts` that require a real Gemini account.
They are skipped by design, not silently failing. Other Playwright projects were
not re-run in this pass; they are unchanged by these edits.

## F. Files changed

| File | Why | Security problem | Functional impact | Validated by |
| --- | --- | --- | --- | --- |
| `lib/auth.ts` | `changePassword` gained an optional kept-token hash and `currentSessionTokenHash()` was added | A password change silently revoked the caller's own session while reporting otherwise; the old `token_hash != ""` predicate was always true | Now keeps the current session and revokes only the others; a forced change still revokes all | `tests/session-security.test.ts` (2 new cases) |
| `lib/actions/session.ts` | Passes the current session hash | Same | Settings password change no longer logs the user out | same |
| `lib/security.ts` | Removed the unused in-process `rateLimit` | A restart-resettable limiter was exported and could be mistaken for a control | None (no caller) | typecheck, full suite |
| `scripts/secret-patterns.mjs` | Added `credential in URL` and `JSON Web Token` patterns | Credentials in arbitrary URLs and bare JWTs were undetectable | None | `tests/secret-scanner.test.ts` |
| `scripts/secret-scan.mjs` | Scans `package-lock.json` with strong patterns (generic heuristic still skipped there) | A lockfile registry URL with an embedded credential was silently excluded | None | new lockfile tests |
| `tests/session-security.test.ts` | Covers both password-change paths | Regression protection | None | suite |
| `tests/secret-scanner.test.ts` | New: 14 end-to-end cases over a throwaway Git repo | Proves detection, exit code, redaction and placeholder handling | None | suite |

## G. Manual actions (owner only)

1. **Credential ownership.** Confirm whether the previously exposed key (prefix
   `AIza`, 39 chars) belongs to this project's Google Cloud organisation. If it
   is ours, delete it; if it is the third-party employer's, notify them and do
   not revoke it. This cannot be decided from the repository.
2. **GitHub settings.** Enable secret scanning and push protection (subject to
   plan), Dependabot alerts and security updates, and protect `main` with a
   required pull request and the actual `security` workflow check names:
   `Secret scan (tracked files + history)`, `Dependency vulnerability audit`,
   `Typecheck, unit tests, production build`.
3. **Branch cleanup.** Authorise the deletions in the summary table.
4. **Dependabot.** Merge PR #3 (verified) and review #1/#2/#4 before merging.
5. **Pre-purge bundle.** `backups/pre-purge-20261128T132506Z.bundle` still holds
   the old history by design; delete it once the rewrite is accepted.

## H. Verdict

CONDITIONALLY READY. No critical or high finding is open in the application.
Deployment should proceed only after the owner completes G1 and G2, and after a
full Playwright run on the deployment host.
