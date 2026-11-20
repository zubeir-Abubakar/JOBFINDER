# Oracle staging and production deployment

See [PHASE4-READINESS.md](PHASE4-READINESS.md) for the Phase 4 checklist,
recovery drills and remaining infrastructure requirements.

The application is a single Node process backed by SQLite. Run it on **one**
Oracle Ampere A1 VM. Do not scale it across multiple instances while the
database and schedulers remain process-local.

## 1. Host prerequisites

Use Ubuntu 24.04 ARM64, Node 24 LTS, `npm`, `sqlite3`, `tar`, `nginx` and
`certbot`. Do not copy `node_modules` from another architecture.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin atworkforce
sudo mkdir -p /opt/at-ai-workforce /var/www/certbot
sudo chown -R atworkforce:atworkforce /opt/at-ai-workforce
```

Install the release into `/opt/at-ai-workforce`, then:

```bash
cd /opt/at-ai-workforce
sudo -u atworkforce npm ci
sudo -u atworkforce npm run typecheck
sudo -u atworkforce npm test
sudo -u atworkforce npm run build
```

## 2. Environment

```bash
sudo install -m 600 -o atworkforce -g atworkforce \
  deploy/env.production.example /opt/at-ai-workforce/.env
```

Replace every placeholder. Keep `APP_SECRET_KEY` stable: changing it makes
existing Gmail tokens, enrolled MFA secrets and recovery-code hashes
undecryptable. `CRON_SECRET`
must be a random value. In production `/api/health` requires `HEALTHCHECK_TOKEN`,
including direct host checks; set `HEALTH_PUBLIC=true` only because the supplied
nginx location restricts access to loopback. `CRON_SECRET` is required for any
HTTP cron trigger; a direct local trigger is accepted only outside production.

Enrol TOTP MFA for the owner and administrator under **Settings → Security**.
Save the one-time recovery codes offline. An administrator can reset a lost
factor from **Admin → Users**, which ends that user's sessions.

Before the first start, set `SETUP_TOKEN` to at least 24 random characters. On a
fresh database `/setup` requires that token; without a token the page is only
available from a direct local connection in development. Setup permanently
closes after the first committed initialization. The app sits behind nginx, so
keep `TRUST_PROXY=true`; nginx overwrites `X-Real-IP` and `X-Forwarded-Proto`. `ENABLE_HSTS=true` is required in
production and is deliberately absent from local HTTP development. Keep
`OUTBOUND_ALLOW_PRIVATE=false`: job and application fetches must not reach
loopback, private RFC1918 space or cloud metadata endpoints.

## 2.1 Secrets and OCI

See [OCI-NETWORK-SECURITY.md](OCI-NETWORK-SECURITY.md) for the concrete OCI
VCN/NSG, ingress/egress, metadata-protection, SSH, firewall, TLS, Vault and
logging plan. It is a plan, not evidence that those controls are active.

Do not bake `.env`, provider keys, `APP_SECRET_KEY`, `CRON_SECRET`,
`HEALTHCHECK_TOKEN` or the backup key into the image, repository or browser
bundle. On OCI, store them in **OCI Vault** and inject them at boot through an
instance-principal-authorized fetch or a systemd `EnvironmentFile` with mode
`0600`, owner `atworkforce`. Restrict the vault secret to the instance and
rotate it through a documented change window. `NEXT_PUBLIC_*` values are public
and must never contain a secret. Google OAuth uses the exact HTTPS callback; the
OAuth state key is `APP_SECRET_KEY` and the app fails closed if it is missing.

If FreeLLMAPI and Ollama are not sidecars on this host, replace both localhost
URLs with private reachable endpoints. Never expose the Ollama or gateway ports
to the public internet.

### 2.2 Public origin (required for working email links)

Do not invent or commit a hostname. Choose the real hostname in DNS first, point
its A/AAAA record at this VM, and confirm it resolves to the VM before issuing a
certificate. The same exact origin must be used in all four places:

1. `APP_BASE_URL` in `.env` (origin only, no path or trailing slash).
2. `server_name` and certificate paths in the nginx site file.
3. `GOOGLE_REDIRECT_URI` and the Google Cloud OAuth client.
4. The `certbot -d` argument below.

```bash
# Replace PUBLIC_HOST with the real DNS name chosen for this deployment.
export PUBLIC_HOST="$(read -r -p 'Public hostname: ' value; printf '%s' "$value")"
test -n "$PUBLIC_HOST" || { echo 'No hostname supplied.'; exit 1; }

sudo sed -i "s/YOUR_DOMAIN/${PUBLIC_HOST}/g" /opt/at-ai-workforce/.env
sudo sed -i "s/YOUR_DOMAIN/${PUBLIC_HOST}/g" deploy/nginx-at-ai-workforce.conf
sudo sed -i "s|APP_BASE_URL=.*|APP_BASE_URL=https://${PUBLIC_HOST}|" /opt/at-ai-workforce/.env
sudo sed -i "s|GOOGLE_REDIRECT_URI=.*|GOOGLE_REDIRECT_URI=https://${PUBLIC_HOST}/api/gmail/oauth/callback|" /opt/at-ai-workforce/.env
sudo chmod 600 /opt/at-ai-workforce/.env
```

The app deliberately omits dashboard links when `APP_BASE_URL` is empty,
malformed, loopback, `.local`, or a private address. `https://localhost:3000`
remains the development default and is never used in an outgoing email.
Restart the service after changing `.env`; then confirm a generated report
contains `https://<real-host>/` and no `localhost` link.

The Coordinator's daily executive brief is a second durable schedule row
(`daily_executive_brief`) at **17:00 Europe/Zurich**, ticked by the same running
process. It is the single consolidated owner-facing report; routine successful
applications are not sent as separate emails. A missing public origin no longer
blocks the email: the dashboard CTA is omitted instead, and no localhost or
private link is emitted. Gmail OAuth, a durable refresh token and the send scope
are still mandatory. Verify the admin **Email & reports** page after startup:
schedule enabled, next run present, Send Now producing a real state, Gmail
message/thread IDs, and Sent-folder observation recorded separately from API
acceptance.

Register the exact HTTPS Gmail callback and add it to Google Cloud:

```text
https://YOUR_DOMAIN/api/gmail/oauth/callback
```

## 3. Data restore

Stop the service before restoring. A database-only copy is not sufficient:
the uploads directory contains the original CV and generated documents.

First verify a backup in a disposable directory. The script refuses to write
inside the live `DATA_DIR`:

```bash
sudo -u atworkforce node scripts/restore.mjs \
  --backup /opt/at-ai-workforce/data/backups/atw-backup-YYYY-MM-DDTHH-MM-SS-sssZ \
  --target /tmp/atw-restore-check
```

For a real recovery, stop the service and restore into a sibling directory
(the script deliberately refuses to write inside the live `DATA_DIR`). Only
then swap the verified directory into place. Keep the same `APP_SECRET_KEY`:

```bash
sudo systemctl stop at-ai-workforce
sudo -u atworkforce node /opt/at-ai-workforce/scripts/restore.mjs \
  --backup /path/to/verified/atw-backup-* \
  --target /opt/at-ai-workforce/data.restored
sudo -u atworkforce mv /opt/at-ai-workforce/data /opt/at-ai-workforce/data.pre-restore
sudo -u atworkforce mv /opt/at-ai-workforce/data.restored /opt/at-ai-workforce/data
sudo chown -R atworkforce:atworkforce /opt/at-ai-workforce/data
sudo chmod 700 /opt/at-ai-workforce/data
sudo chmod 600 /opt/at-ai-workforce/data/at-ai-workforce.db
sudo systemctl start at-ai-workforce
curl -fsS -H "Authorization: Bearer $HEALTHCHECK_TOKEN" \
  http://127.0.0.1:3000/api/health
```

Do not delete `data.pre-restore` until the health endpoint, login, scheduler
state and a restore test pass.

## 4. Services

```bash
sudo install -m 644 deploy/at-ai-workforce.service /etc/systemd/system/
sudo install -m 644 deploy/at-ai-workforce-backup.service /etc/systemd/system/
sudo install -m 644 deploy/at-ai-workforce-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now at-ai-workforce
sudo systemctl enable --now at-ai-workforce-backup.timer
```

Check:

```bash
# Use the token from .env, or HEALTH_PUBLIC=true with the nginx loopback allow.
curl -fsS -H "Authorization: Bearer $HEALTHCHECK_TOKEN" \
  http://127.0.0.1:3000/api/health
sudo journalctl -u at-ai-workforce -n 100 --no-pager
```

## 5. Reverse proxy and TLS

```bash
# PUBLIC_HOST is the real hostname chosen in section 2.2.
sudo install -m 644 deploy/nginx-at-ai-workforce.conf \
  /etc/nginx/sites-available/at-ai-workforce
sudo ln -sfn /etc/nginx/sites-available/at-ai-workforce \
  /etc/nginx/sites-enabled/at-ai-workforce
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d "$PUBLIC_HOST"
```

The workflow event stream is Server-Sent Events. The proxy configuration
disables buffering for `/api/workflows/`; do not remove that.

## 6. Backups

`npm run backup` creates a consistent SQLite snapshot, uploads archive,
permission-restricted environment copy and SHA-256 manifest in
`data/backups/atw-backup-*`. The systemd timer runs it daily at 02:30 host time.

The backup remains on the same VM disk. For actual disaster recovery, do not
copy the raw directory: it contains `env.baseline`. Create an
authenticated encrypted archive first, then copy only the `.atwenc` file and its
checksum. Generate the key once and store it separately from both the host and
the backup destination.

```bash
sudo install -d -m 700 -o atworkforce -g atworkforce /opt/at-ai-workforce/backup-keys
sudo -u atworkforce sh -c 'openssl rand -base64 32 > /opt/at-ai-workforce/backup-keys/backup.key'
sudo chmod 600 /opt/at-ai-workforce/backup-keys/backup.key

sudo -u atworkforce env \
  BACKUP_ENCRYPTION_KEY_FILE=/opt/at-ai-workforce/backup-keys/backup.key \
  npm run backup:encrypt -- --backup /opt/at-ai-workforce/data/backups/atw-backup-YYYY-MM-DDTHH-MM-SS-sssZ

# Copy the .atwenc and .sha256 files to the off-host destination with scp/rsync.
# Verify the checksum on the destination before treating the copy as complete.
sha256sum -c atw-backup-*.tar.gz.atwenc.sha256
```

Restore drill from the encrypted copy:

```bash
sudo -u atworkforce env \
  BACKUP_ENCRYPTION_KEY_FILE=/opt/at-ai-workforce/backup-keys/backup.key \
  npm run backup:decrypt -- --in /secure/offhost/atw-backup-YYYY-MM-DDTHH-MM-SS-sssZ.tar.gz.atwenc --target /tmp/atw-decrypted

sudo -u atworkforce node scripts/restore.mjs \
  --backup /tmp/atw-decrypted/atw-backup-YYYY-MM-DDTHH-MM-SS-sssZ \
  --target /tmp/atw-restore-check
```

The repository does not contain an off-host destination or credentials. Until a
destination is configured and a restore from that copy succeeds, off-host
backup is **not operational**. Losing the encryption key makes the backup
unrecoverable.

Test a restore into a disposable directory before changing production. Keep at
least one pre-deployment backup. The baseline snapshot from Phase 2 must not be
deleted by retention automation.

## 7. Rollback

1. Stop the service.
2. Restore the previous release directory or `git checkout` the pinned tag.
3. Restore the pre-deployment database and uploads.
4. Keep the same `APP_SECRET_KEY`.
5. Run `npm ci && npm run build` for the previous release.
6. Start and verify `/api/health`, `/login`, Gmail and scheduler state.

Outgoing email and employer submissions cannot be undone. Leave the submission
endpoint empty until the autonomous-submission policy is explicitly accepted.
