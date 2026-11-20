# OCI network and security plan

This is a concrete migration plan for AT AI Workforce on Oracle Cloud
Infrastructure (OCI). It describes the intended controls; it does **not** claim
that any OCI resource, NSG, firewall rule, WAF or Vault secret has been created.
Validate every command in a non-production compartment first.

## Target topology

```text
Internet
  |
  v
OCI WAF (optional) -> OCI Load Balancer, public subnet, 443 only
  |
  v
nginx on the application VM, private subnet or host loopback
  |
  +--> 127.0.0.1:3000   Next.js application (never publicly bound)
  +--> 127.0.0.1:31415  FreeLLMAPI gateway (loopback/sidecar only)
  +--> 127.0.0.1:11434  Ollama fallback (loopback/sidecar only)
  |
  +--> NAT gateway / Network Firewall -> approved public HTTPS destinations

OCI Vault / Object Storage / Logging are reached through a service gateway or
private endpoint, not through the public internet or the instance metadata
service from the application process.
```

The current single-VM deployment binds Next.js to `127.0.0.1` in
`deploy/at-ai-workforce.service` and puts nginx on 443. Keep that model until
SQLite and the process-local scheduler are replaced. A load balancer can be
placed in front of nginx, but it must not load-balance across multiple app
processes sharing one SQLite file.

## 1. Ingress restrictions

Create one NSG for the load balancer/nginx and a separate NSG for the
application host. Allow only these flows:

| Source | Destination | Protocol/port | Purpose |
| --- | --- | --- | --- |
| `0.0.0.0/0`, `::/0` | public LB/nginx NSG | TCP 443 | Public HTTPS |
| `0.0.0.0/0`, `::/0` | public LB/nginx NSG | TCP 80 | ACME HTTP-01 and HTTPS redirect only |
| OCI Bastion service or administrator CIDR | app host NSG | TCP 22 | Break-glass SSH only |
| LB/nginx NSG | app host NSG | TCP 3000 | Reverse proxy to loopback/private listener |

Deny everything else. In particular:

- Never create an ingress rule for `3000`, `31415` or `11434`.
- Do not expose the application directly on the VM's public IP. nginx should be
  the only internet-facing listener.
- If OCI Bastion is used, remove public SSH entirely. Otherwise restrict 22 to
  the administrator's current CIDR, not `0.0.0.0/0`; prefer a VPN or bastion.
- Keep the nginx health location limited to loopback (`allow 127.0.0.1; allow
  ::1; deny all;`). The app also requires `HEALTHCHECK_TOKEN` in production.
- Restrict `/setup` at the edge if the deployment model permits it. The app
  already requires `SETUP_TOKEN` in production and permanently closes setup;
  network restriction is defense in depth, not a replacement.
- Put the LB/WAF in front of nginx if the budget allows. Enable OCI WAF managed
  rules, bot protection as appropriate, and a request-body limit consistent
  with the app's 12 MB action/16 MB nginx limits.
- Keep TLS termination at the LB or nginx, not at the Node process. If the LB
  terminates TLS, re-encrypt or forward only over a private network and set
  `TRUST_PROXY=true` only when the proxy contract is real.

Do not enable `TRUST_PROXY` on a host that can be reached directly from the
internet; the app would then trust spoofable forwarding headers.

## 2. Egress restrictions

Default-deny egress is the goal. The app needs outbound HTTPS for public job
boards, career sites and application endpoints, plus Google APIs used by voice
and Gmail. FreeLLMAPI and Ollama should be loopback sidecars.

| Destination | Protocol/port | Decision |
| --- | --- | --- |
| VCN DNS resolver | UDP/TCP 53 | Allow |
| OCI NTP endpoints | UDP 123 | Allow |
| Approved public HTTPS destinations | TCP 443 | Allow through NAT/Network Firewall |
| OCI Object Storage/Vault private endpoint | TCP 443 via service gateway | Allow only if used |
| `169.254.169.254/32` | any | Deny from the app process |
| RFC1918, link-local, loopback, CGNAT, multicast | any | Deny except explicit sidecars |
| All other ports/destinations | any | Deny and log |

Public job-board hostnames do not have stable IP sets. Prefer OCI Network
Firewall with an FQDN allowlist, or an outbound forward proxy with a domain
allowlist, over an unrestricted `0.0.0.0/0:443` rule. If a temporary broad 443
egress rule is unavoidable during bring-up, log it, time-box it, and replace it
before production. The application's SSRF controls remain necessary but are not
a substitute for network egress policy.

Protect the instance metadata service (IMDS) from the application:

- Fetch Vault secrets in a root-owned oneshot unit **before** starting the app,
  using instance principals if required. Do not give the app a reason to call
  IMDS.
- Add a systemd egress restriction to the app unit after validating it on the
  target host:

  ```ini
  IPAddressAllow=any
  IPAddressDeny=169.254.169.254/32
  ```

  Confirm the installed systemd supports cgroup/eBPF address filtering and that
  DNS, OCI private endpoints and expected job boards still work. If the host
  cannot enforce per-unit filtering, enforce the block in the host nftables
  output chain and in the NSG. Do not block the metadata endpoint for the
  root/bootstrap unit that legitimately needs it.
- Set `OUTBOUND_ALLOW_PRIVATE=false` in production. This is an application
  control; it does not protect services that bypass the app's HTTP client.

## 3. Private service isolation

- Bind Next.js to `127.0.0.1` (`ExecStart ... --hostname 127.0.0.1`). Verify with
  `ss -lntp` that 3000 is not on `0.0.0.0`.
- Run FreeLLMAPI and Ollama on loopback or a dedicated private subnet. Their
  ports must not be reachable from the internet or from unrelated VCN subnets.
- Use separate NSGs for the LB, application host and any database/queue host.
  Do not rely on a single permissive VCN security list.
- Put persistent data on an OCI Block Volume mounted at `DATA_DIR`, with
  encryption at rest, restricted IAM and a backup policy. Keep the SQLite
  database and uploads on one host.
- Use a service gateway for Object Storage/Vault rather than routing private
  traffic through the NAT gateway.
- No database, Redis, Ollama or gateway port belongs in a public subnet.

## 4. SSH and host access

- Disable password authentication and direct root login:
  `PasswordAuthentication no`, `PermitRootLogin no`,
  `KbdInteractiveAuthentication no`.
- Use per-administrator SSH keys, an OCI Bastion managed session or a VPN.
  Restrict ingress 22 to the bastion/administrator source and remove the rule
  when not in use.
- Keep the host patched; enable unattended security upgrades and reboot during a
  change window.
- Do not install a public shell, database browser or model UI on the host.
- Run the app as the unprivileged `atworkforce` user with the existing
  `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp` and
  `UMask=0077` settings.

## 5. Host firewall

OCI NSGs are the primary control. Add a host nftables/iptables policy as defense
in depth. At minimum:

```text
input:  allow established/related, loopback; allow 443 and 80 from the LB or
        internet as designed; allow 22 from the admin/bastion source; drop all
        else (log drops).
output: allow established/related, loopback, DNS to the VCN resolver, NTP,
        approved 443 destinations/private endpoints; drop 169.254.169.254 from
        the app; drop all else (log drops).
```

If using nftables, log and rate-limit dropped packets rather than logging every
packet. Test that the rules survive reboot and do not lock out the console or
the OCI logging agent. Keep an out-of-band console recovery path.

## 6. Reverse proxy and TLS

- Use the supplied `deploy/nginx-at-ai-workforce.conf` as the baseline. It
  redirects HTTP to HTTPS, terminates TLS, limits the body size and disables
  buffering for the workflow SSE route.
- Keep `proxy_set_header X-Real-IP`, `X-Forwarded-For` and
  `X-Forwarded-Proto`; nginx must overwrite client-supplied values. Only set
  `TRUST_PROXY=true` behind this proxy.
- Use a publicly trusted certificate (OCI Certificate service or certbot).
  Keep the full chain installed, renew before expiry and monitor the expiry.
- Enable TLS 1.2/1.3 only, disable legacy ciphers and compression, and keep
  HSTS enabled at the edge and in the app (`ENABLE_HSTS=true`).
- Set sensible proxy connect/read/send timeouts. Keep the 300s read timeout for
  `/api/workflows/` so SSE is not cut off; do not disable buffering globally.
- Rate-limit at the WAF/LB in addition to the app's SQLite-backed limiter. The
  app limiter is not distributed and is not a DDoS control.
- Do not put the Node process behind a proxy that strips the `Host` header or
  rewrites `Origin`; the app's cross-site write check depends on them.

## 7. Secrets management

- Store `APP_SECRET_KEY`, provider keys, Gmail OAuth credentials, `CRON_SECRET`,
  `HEALTHCHECK_TOKEN`, `SETUP_TOKEN` and the backup encryption key in **OCI
  Vault**. Do not put them in the image, git, Terraform state, user data or
  browser bundles.
- Fetch them with a root-owned bootstrap unit using an instance principal or a
  tightly scoped dynamic group. Write an `EnvironmentFile` to a tmpfs path such
  as `/run/atw/env` with mode `0600`, owner `atworkforce`, then start the app.
  Remove the file on stop. Do not leave a copy in `/opt` or `/tmp`.
- Restrict the Vault secret and key policy to the instance/principal and a named
  administrator group. Enable audit logging for secret reads.
- `APP_SECRET_KEY` must remain stable across restores; changing it makes Gmail
  tokens, MFA secrets and recovery-code hashes undecryptable. Back it up
  separately from the database.
- Generate `SETUP_TOKEN` with at least 24 random characters
  (`openssl rand -base64 32`), keep it out of logs and delete/rotate it after
  first-run setup. Setup is permanently closed server-side after initialization.
- Keep the backup encryption key off the host and off the backup destination.
- `NEXT_PUBLIC_*` values are public; never put a secret there.

## 8. Logging and monitoring

- Ship nginx access/error logs, the app's journald output and OCI VCN flow logs
  to OCI Logging. Enable OCI Audit and Vault audit logs.
- Alert on: 5xx rate, login failures and lockouts, MFA failures, setup attempts,
  authorization/ownership denials, outbound SSRF/redirect blocks, firewall
  denies to metadata/private ranges, TLS certificate expiry, disk usage,
  backup failure and missed scheduler runs.
- Do not log request bodies, session cookies, bearer tokens, OAuth codes,
  passwords or model provider keys. Keep the existing redaction behavior and
  review new log fields before enabling them.
- Set retention and access controls appropriate to personal data. Restrict who
  can read logs and export them to a separate protected bucket if required.
- Monitor the health endpoint from a private monitor with
  `HEALTHCHECK_TOKEN`; do not make `/api/health` public just to satisfy an
  external uptime check.

## 9. Validation before cutover

Run these on the target host, not only in development:

```bash
ss -lntp | grep -E ':(3000|31415|11434)\b'   # must be 127.0.0.1/[::1], not 0.0.0.0
curl -fsS -H "Authorization: Bearer $HEALTHCHECK_TOKEN" \
  http://127.0.0.1:3000/api/health
curl -fsS https://YOUR_DOMAIN/login >/dev/null
curl -sS -D- https://YOUR_DOMAIN/login -o /dev/null | grep -i '^content-security-policy:'
openssl s_client -connect YOUR_DOMAIN:443 -servername YOUR_DOMAIN \
  -verify_return_error -CAfile /etc/ssl/certs/ca-certificates.crt </dev/null
```

Then verify from outside the VCN that 3000, 31415, 11434 and 22 (unless the
approved bastion rule exists) are closed, and verify that the app cannot reach
`169.254.169.254`, RFC1918 addresses or an internal-only service.

## 10. Residual gaps in this plan

This document is not evidence that OCI controls are active. Before go-live:

- Create and review the VCN, subnets, NSGs, route tables, NAT/service gateway,
  WAF/LB and Vault policies in the target compartment.
- Decide whether the app can use an FQDN-allowlisted egress firewall. Without
  one, broad 443 egress remains a residual risk even with SSRF validation.
- Prove IMDS blocking for the application UID without breaking the bootstrap
  secret fetch.
- Configure off-host encrypted backups and perform a restore drill on OCI.
- Test certificate renewal, host reboot, systemd restart and log/alert delivery.
- Re-run `npm run typecheck`, `npm test`, `npm run build`, `npm run secret-scan`
  and `npm audit --omit=dev --audit-level=high` on the deployed release.
