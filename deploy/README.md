# Oracle staging and production deployment

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
existing Gmail tokens undecryptable. `CRON_SECRET` must be a random value.

If FreeLLMAPI and Ollama are not sidecars on this host, replace both localhost
URLs with private reachable endpoints. Never expose the Ollama or gateway ports
to the public internet.

Register the exact HTTPS Gmail callback and add it to Google Cloud:

```text
https://YOUR_DOMAIN/api/gmail/oauth/callback
```

## 3. Data restore

Stop the service before restoring. A database-only copy is not sufficient:
the uploads directory contains the original CV and generated documents.

```bash
sudo systemctl stop at-ai-workforce
sudo -u atworkforce tar -xzf uploads.tar.gz -C /opt/at-ai-workforce/data
sudo -u atworkforce cp at-ai-workforce.db /opt/at-ai-workforce/data/
sudo chmod 700 /opt/at-ai-workforce/data
sudo chmod 600 /opt/at-ai-workforce/data/at-ai-workforce.db
sudo chown -R atworkforce:atworkforce /opt/at-ai-workforce/data
sudo rm -f /opt/at-ai-workforce/data/at-ai-workforce.db-wal \
           /opt/at-ai-workforce/data/at-ai-workforce.db-shm
sudo systemctl start at-ai-workforce
curl -fsS http://127.0.0.1:3000/api/health
```

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
sudo systemctl status at-ai-workforce --no-pager
sudo journalctl -u at-ai-workforce -n 100 --no-pager
curl -fsS http://127.0.0.1:3000/api/health
```

## 5. Reverse proxy and TLS

```bash
sudo install -m 644 deploy/nginx-at-ai-workforce.conf \
  /etc/nginx/sites-available/at-ai-workforce
sudo ln -sfn /etc/nginx/sites-available/at-ai-workforce \
  /etc/nginx/sites-enabled/at-ai-workforce
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR_DOMAIN
```

The workflow event stream is Server-Sent Events. The proxy configuration
disables buffering for `/api/workflows/`; do not remove that.

## 6. Backups

`npm run backup` creates a consistent SQLite snapshot, uploads archive,
permission-restricted environment copy and SHA-256 manifest in
`data/backups/atw-backup-*`. The systemd timer runs it daily at 02:30 host time.

The backup remains on the same VM disk. Copy it off-host, encrypted, for actual
disaster recovery:

```bash
sudo -u atworkforce rsync -a --delete /opt/at-ai-workforce/data/backups/ \
  user@backup-host:/srv/at-ai-workforce-backups/
```

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
