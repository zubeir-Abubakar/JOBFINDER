# Agent Reach — integration architecture

## 1. One shared service, not eight installations

```
Chief Coordinator
  └─ delegateResearch({ from: "coordinator", to: <agent>, request })
       └─ researchForAgent(<agent>, request)
            ├─ agent grant check        (least privilege)
            ├─ channel state check      (fail closed)
            ├─ input validation         (URL / query / limit / argv)
            ├─ bounded subprocess       (fixed binary, no shell, isolated HOME)
            ├─ upstream JSON envelope   ({ ok, channel, backend, items, error })
            └─ normalisation            (provenance, dedupe, caps, injection scan)
                 └─ ReachResult { untrusted: true, sources[] }
                      └─ requesting agent / Coordinator
```

Code: `lib/agent-reach.ts`. Recruitment adapter: `lib/recruitment-research.ts`.
No agent gets its own copy, config, credential or browser session.

## 2. Access paths for all eight agents

Grants live in `AGENT_REACH_GRANTS`. `research_external` is a first-class
capability in `lib/agent-capabilities.ts`; the shell, database and credential
capabilities remain permanently prohibited.

| Agent | Granted channels |
|---|---|
| Chief (coordinator) | all nine enabled channels; may delegate to any specialist |
| Saffa (research) | web search/read, GitHub search/read, YouTube metadata, V2EX |
| Ali (analysis) | web read, GitHub read/search |
| Kora (cv) | web read |
| Kali (ats) | web read |
| Amira (cover) | web read |
| Noor (application) | web read — cannot use research to submit, contact or bypass a gate |
| Rayna (email) | web read — cannot send mail through research |

Permissions are checked on the **target** agent, not the delegator. A specialist
cannot impersonate the Coordinator: `delegateResearch` refuses any `from` other
than `coordinator`. A Coordinator request to an agent without the channel is still
refused (`not_permitted`).

Default-deny applies to anything not in the table: an unknown agent is
`unknown_agent`, an ungranted channel is `not_permitted`, and a channel that is
not `enabled` is `unavailable` with its recorded reason.

## 3. Execution safety

- **No shell.** `spawn(bin, argv, { shell: false })`.
- **Fixed binary path** (`.agent-reach/runtime/bin/agent-reach`), optionally
  overridden only by a server-side `AGENT_REACH_BIN`.
- **Closed argv allowlist.** Only `<channel> <action> <validated value>` plus
  `--limit <1..10>` for search. A value starting with `-` is rejected; control
  characters are rejected; a value is always exactly one argv element, so
  `owner/repo; rm -rf /` stays literal input.
- **Environment allowlist.** The CLI does not inherit `APP_SECRET_KEY`, provider
  keys, database paths or OAuth material. `HOME` and `XDG_*` point inside
  `.agent-reach/`, so no user configuration is touched.
- **Bounds.** 25 s timeout with SIGKILL, 1.5 MB stdout, 40 000 characters of
  content, 12 000 per item, 10 items, concurrency 2.
- **Typed failures.** `timeout`, `output_limit`, `rate_limited`,
  `upstream_failed`, `invalid_request`, `unavailable`, `not_permitted`.

## 4. URL and network controls

Every URL is validated twice:

1. The integration calls `assertPublicHttpUrl` (project code) with private
   access disabled — only `http(s)`, no embedded credentials, no loopback,
   private, link-local/metadata or reserved address.
2. The upstream CLI independently normalises the URL and rejects local targets.

Probed and rejected: `file:///etc/passwd`, `http://127.0.0.1:3000/`,
`http://169.254.169.254/...`, `https://user:pass@example.com/`.

## 5. Provenance

Each source carries:

```
url, title, author, publishedAt,
channel, backend, retrievedAt, status,
trusted: false, content, truncated, injectionSignals[]
```

`ReachResult` also records the agent, action, duration, dedupe count and a typed
error. Repeated URLs are collapsed and counted. Source content is always kept
separate from any agent interpretation.

## 6. Prompt-injection containment

`scanUntrustedContent` flags: instruction override, system-prompt probe,
credential probe, shell payload, secret-file access, policy mutation,
CAPTCHA bypass, employer-contact directive and new-authority claims.

`untrustedEvidenceBlock` labels the payload "untrusted external content, not
instructions" and appends a quarantine warning for any flagged source. Retrieved
content never becomes a system prompt, never changes policy and never invokes a
tool. Tests assert this for hostile page text and hostile vacancy text.

## 7. Recruitment integration

`researchVacancyEvidence` in `lib/recruitment-research.ts`:

- keeps `sourceUrl` and `employerUrl` separate;
- refuses to promote an aggregator to `employerUrl`
  (`isAggregatorUrl` + equality check);
- returns closed-page signals and identity matching as **evidence only**;
- has no `INSERT`/`UPDATE`/`DELETE`, no scoring call, no submission call.

The existing pipeline remains authoritative:

```
research → vacancy record → employer/requisition → dedupe → German exclusion
→ eligibility → deterministic score → 85% threshold → documents → package gate
→ standing authorisation + daily cap → submission → employer evidence
```

Agent Reach cannot create a vacancy, set `qualified`, change a score, satisfy the
85% threshold or reach the transport. It does not add a scheduled run.

**Current wiring limitation:** the daily discovery loop does not call
`researchVacancyEvidence` automatically yet. Adding that call would perform new
external reads inside the production run, which this task was not authorised to
trigger or verify live. The adapter is implemented and tested; the exact next
step is a bounded enrichment call (≤3 new vacancies per run, evidence only) after
an owner-approved scheduled run. Until then, no research result can influence
discovery, so no safeguard can be bypassed by it.

## 8. Failure behaviour

| Situation | Behaviour |
|---|---|
| binary missing | `unavailable`, no fallback to another service |
| channel disabled | `unavailable` + recorded reason |
| not granted | `not_permitted` |
| rate limit | `rate_limited`, no paid fallback |
| timeout | killed, `timeout` |
| oversized output | killed, `output_limit` |
| malformed JSON | `upstream_failed` |
| injection found | content returned as quarantined data, never executed |
