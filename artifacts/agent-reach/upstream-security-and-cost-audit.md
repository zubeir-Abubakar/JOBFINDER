# Agent Reach — upstream security and cost audit

Audited 2026-11-26 from the upstream repository, not from older instructions.

## 1. Pinned version

| Item | Value |
|---|---|
| Repository | https://github.com/Panniantong/Agent-Reach |
| Release | **v1.6.1** |
| Commit | `7a38047acf26a729cbb27851e3cb81639da86b29` |
| `main` at audit time | `8d9ecc1f5521fe7d223cde782aaa4005695e2671` (2026-11-24) — **not used** |
| License | MIT |
| Runtime | Python `>=3.10` |
| Verified installed version | `1.6.1`, install method `uv` |

Production dependency is the tag commit, not a moving branch. `agent-reach
update` was **not** run; the reviewed commit stays installed.

## 2. License and redistribution

MIT. Installing the unmodified package locally creates no redistribution
obligation. No upstream source was copied into this repository.

## 3. Dependencies

Declared: `requests>=2.28`, `loguru>=0.7`, `pyyaml>=6.0`,
`yt-dlp[default]==2026.8.19`.

Resolved at install:

```
agent-reach 1.6.1 (git 7a38047)
brotli 1.2.1        certifi 2026.11.20   charset-normalizer 3.5.3
idna 3.20           loguru 0.8.0         mutagen 1.48.1
pycryptodomex 3.24.2 pyyaml 6.0.4        requests 2.34.2
urllib3 2.8.0       websockets 17.4      yt-dlp 2026.8.19
yt-dlp-ejs 0.8.0
```

14 packages, no native build, no compiler, no system package.

## 4. Installation actually performed

```bash
HOME=$PWD/.agent-reach/home \
UV_TOOL_DIR=$PWD/.agent-reach/runtime/tools \
UV_TOOL_BIN_DIR=$PWD/.agent-reach/runtime/bin \
UV_PYTHON_INSTALL_DIR=$PWD/.agent-reach/runtime/python \
UV_CACHE_DIR=$PWD/.agent-reach/runtime/cache \
uv tool install --python 3.12 \
  "git+https://github.com/Panniantong/Agent-Reach@7a38047acf26a729cbb27851e3cb81639da86b29"
```

- No `sudo`, no system-wide package, no global Python change.
- A private Python 3.12.15 was placed in the project sandbox (the system Python
  is 3.9 and below the upstream floor).
- Total footprint: **73 MB** in `.agent-reach/` (git-ignored).
- `agent-reach setup`, `add`, `login` and `browser` were **never** run, so no
  skill file, no login, no channel tool and no browser profile was created.

Files written by this task:

```
.agent-reach/home/                     isolated HOME, config, caches
.agent-reach/runtime/tools/            uv tool environment
.agent-reach/runtime/bin/agent-reach   executable
.agent-reach/runtime/python/           private CPython 3.12
.agent-reach/runtime/cache/            uv cache
```

Nothing was written to the user's home directory, shell profile or Chrome
profile. No elevated permission is required.

## 5. Data flows and endpoints

| Channel | Endpoint | Account/key | Data sent |
|---|---|---|---|
| web read | `r.jina.ai` (Jina Reader) | none | the public page URL |
| web search | `mcp.exa.ai` (hosted MCP) | none | the search query |
| github | `api.github.com` | none (optional token not configured) | repository search/target |
| v2ex | `www.v2ex.com` | none | topic/node query |
| youtube | local `yt-dlp` → YouTube | none | video id/query |
| install | github.com, PyPI, python-build-standalone | none | package downloads |

Nothing is posted, commented, liked, followed or messaged: the CLI surface used
here is read/search only, and the integration exposes no write verb.

## 6. Cookies, tokens and browser sessions

Upstream can copy a site login from the user's Chrome into its own browser for
login-walled channels. **This integration never triggers that path**: the
channels that need a session are not exposed, the browser is never started, no
cookie is imported, and `agent-reach login` is never called. No password,
OAuth token or session cookie is read, stored or passed to a model.

The subprocess environment is an allowlist (`NODE_ENV`, `PATH`, isolated
`HOME`/`XDG_*`, `LANG`, `NO_COLOR`, `PYTHONIOENCODING`). Application secrets such
as `APP_SECRET_KEY`, provider keys and database paths are **not** inherited.

## 7. Security findings

1. **Unpinned transitive ranges.** `requests`, `loguru` and `pyyaml` allow newer
   versions. Mitigation: the top-level package is pinned to a commit, updates are
   never automatic, and installs happen in a throwaway project sandbox.
2. **Third-party content is untrusted.** The integration screens retrieved text
   for instruction-override, credential, shell, secret-file, policy-mutation,
   CAPTCHA-bypass and authority claims, marks it `trusted: false`, and wraps it
   in an explicit "data, not instructions" block.
3. **Upstream URL validation is present and was probed.** `file:///etc/passwd`,
   `http://127.0.0.1:3000/` and metadata-style targets are rejected with
   `BAD_INPUT`. The integration also validates every URL with the project's own
   `assertPublicHttpUrl` (blocks loopback, private ranges, link-local metadata,
   embedded credentials) before spawning the CLI.
4. **No shell.** `spawn` is called with `shell: false`; argv is rebuilt from a
   closed allowlist; agent strings cannot become flags (a leading `-` is
   rejected) or additional argv entries.
5. **Bounded execution.** 25 s default timeout with SIGKILL, 1.5 MB stdout cap,
   40 000-character total content cap, 12 000 per item, concurrency 2, at most
   10 items. Failures return a typed error instead of throwing.
6. **Supply-chain exposure.** Installing from git executes a build backend
   (`hatchling`) at install time. It ran in the sandbox with no secrets in the
   environment. No installer script was pipe-executed.
7. **Elevation.** None requested or needed.

## 8. Cost assessment

| Capability | Basis | Verdict |
|---|---|---|
| web read (Jina) | no key, no account, no payment method | CHF 0.00 — verified by live call |
| web search (Exa hosted MCP) | no key, no account, no payment method; quota not contractual | CHF 0.00 — verified by live call; no billing relationship exists, so it cannot silently charge |
| github | anonymous REST, 60 req/h documented, fails closed at the limit | CHF 0.00 — verified |
| youtube metadata/subtitles | local yt-dlp | CHF 0.00 — verified |
| v2ex | public API | CHF 0.00 — verified |
| youtube/xiaoyuzhou transcription | paid Groq/OpenAI key | **blocked** |
| any proxy / residential proxy | paid service | **blocked, never configured** |
| login-walled social channels | free but requires user session | **disabled pending explicit user action** |

No paid API, subscription, proxy, CAPTCHA-solving service or paid search was
configured. No trial that can convert to paid was started. No billing details
were entered. **External spend for this task: CHF 0.00.**

## 9. Residual risk

The Exa hosted endpoint is free without an account but its allowance is not a
contract. If it starts returning `RATE_LIMITED`, the service reports that state
and never substitutes a paid route. If the upstream project changes its
behaviour, the pinned commit is unaffected until a deliberate upgrade is
reviewed.
