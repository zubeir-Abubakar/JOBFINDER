# Phase 4 production readiness checklist

This is the operational checklist for a single persistent Linux host. It does
not claim that continuous operation has been proven until the service is
installed under systemd and the recovery drills below have been run on that
host.

## Before deployment

- [ ] Node 24 LTS on the target architecture; `npm ci` (not a copied
      `node_modules` tree).
- [ ] `npm run typecheck`, `npm test`, `npm run build` and `npm run secret-scan`
      pass from a clean checkout.
- [ ] `.env` installed with mode `0600`, owned by `atworkforce`.
- [ ] `APP_SECRET_KEY` is stable and backed up separately from the database.
      Changing it invalidates encrypted Gmail tokens and enrolled MFA secrets.
- [ ] `CRON_SECRET`, Gmail OAuth credentials and any provider keys are set to
      production values. No development credential is reused.
- [ ] Gmail redirect URI is exactly the public HTTPS callback.
- [ ] `APP_BASE_URL` is set to the public HTTPS origin, so the daily executive
      brief can include a working `/dashboard` link; a missing public origin omits
      the CTA without blocking the email, and no localhost link is sent.
- [ ] The daily executive brief schedule is enabled at 17:00 Europe/Zurich and
      its reporting history/delivery state is visible on Admin → Email & reports.
- [ ] Routine successful applications are not generating separate owner emails;
      the consolidated brief is the owner-facing operational report.
- [ ] `RECRUITMENT_SCHEDULER` is not `false` on the host that should run the
      daily schedule.
- [ ] The database and uploads live on persistent storage, not a container's
      ephemeral layer. `DATA_DIR` points at that volume.
- [ ] A pre-deployment backup exists and has been verified in a disposable
      restore directory.

## Process supervision

- [ ] `at-ai-workforce.service` is installed, enabled and `Restart=always`.
- [ ] `KillSignal=SIGTERM` and `TimeoutStopSec=30` are intact so the worker
      shutdown hook can run.
- [ ] `UMask=0077`, `ProtectSystem=strict` and the `ReadWritePaths` entry for
      `data` are intact.
- [ ] Only **one** application process uses the SQLite database and schedule.
      Runtime leases prevent duplicate scheduler/queue claims, but SQLite is
      still a single-host datastore.
- [ ] A reverse proxy terminates HTTPS and forwards
      `X-Forwarded-Proto`, `X-Forwarded-For` and `Host`.
- [ ] The SSE route `/api/workflows/` has proxy buffering disabled.
- [ ] `curl -fsS -H "Authorization: Bearer $HEALTHCHECK_TOKEN"
      http://127.0.0.1:3000/api/health` returns HTTP 200 and `status` is
      `operational` after warm-up. Production requires the token even on
      loopback; `HEALTH_PUBLIC=true` is safe only with the nginx loopback allow.
- [ ] `TRUST_PROXY=true` is set only behind nginx, and HSTS is emitted in
      production but not on local HTTP development.
- [ ] TOTP MFA is enrolled for the owner and administrator, and recovery codes
      are stored offline. Test one recovery code and an administrator reset.
- [ ] `/login`, dashboard, agent chat, recruitment, tracking, Gmail state and
      voice settings work over the public HTTPS origin.
- [ ] Session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS.
- [ ] PWA manifest/service worker load over HTTPS and the mobile layout works.
- [ ] Logs go to journald (or a rotated file sink); retention and disk alerts
      are configured. The app does not log credentials, tokens or message
      bodies.

## Recovery drills

- [ ] Stop the service, start it again, and confirm `/api/health` shows the
      scheduler and workers running with a fresh heartbeat.
- [ ] Confirm a scheduled run is not duplicated after a restart.
- [ ] Mark a disposable queue row `processing` with an old `started_at`, restart,
      and confirm it is requeued or marked for intervention rather than staying
      `processing` forever.
- [ ] Run `npm run restore -- --backup <verified-backup> --target <empty-dir>`
      and confirm integrity plus row counts. Never restore over the live
      directory as a test.
- [ ] Encrypt a backup with `npm run backup:encrypt`, copy only the `.atwenc`
      and `.sha256` files off-host, then decrypt and restore that copy in a
      disposable directory.
- [ ] Confirm the backup timer is active and retention leaves the baseline
      snapshot intact.

## Infrastructure still required

- Off-host encrypted backup storage and a retention policy.
- TLS certificate renewal (certbot timer) and DNS.
- Host firewall exposing only 80/443; application port bound to localhost.
- A systemd service, log shipping/alerting and disk-space monitoring.
- A single-host constraint. Horizontal scaling requires replacing SQLite and
  moving the schedule/queue coordination to a shared database or external
  scheduler.
- MFA is implemented per account but is not forced by policy; enrol it for both
  the owner and administrator before exposure.

## Known limitations

- API throttling is durable in SQLite for processes sharing the same database,
  but it is not a distributed limiter. Do not scale horizontally without
  replacing both SQLite and the limiter.
- A hard machine power loss is recovered by systemd only after the host boots.
  The schedule catches up inside its configured window and records a missed run
  once the window has passed; it does not execute silently hours late.
- In-flight submissions are never blindly retried. Ambiguous delivery is
  reported as unverified and needs external confirmation.
