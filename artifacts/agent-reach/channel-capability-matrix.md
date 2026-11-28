# Agent Reach — channel capability matrix

Verified against the pinned release **v1.6.1** (`7a38047`) on 2026-11-26 with
live calls from the project sandbox. Installation success is not treated as
proof that a channel works.

## Enabled

| Channel / action | State | Backend | Cost | Login | Evidence |
|---|---|---|---|---|---|
| `web_read` — read a public page | **ENABLED — EXTERNAL FREE ROUTE VERIFIED** | Jina Reader | none, no account | no | Live read of `https://example.com` returned text, `backend: jina`, 434 ms |
| `web_search` — public web search | **ENABLED — EXTERNAL FREE ROUTE VERIFIED** | Exa hosted MCP | none, no key/account | no | Live query returned a Swiss job result, `backend: exa` |
| `github_read` — repo/README/issue/PR | **ENABLED — EXTERNAL FREE ROUTE VERIFIED** | GitHub REST | anonymous 60 req/h | no | Live read of `Panniantong/Agent-Reach`, `backend: github-api` |
| `github_search` — repositories | **ENABLED — EXTERNAL FREE ROUTE VERIFIED** | GitHub REST | anonymous 60 req/h | no | Same anonymous backend; `RATE_LIMITED` is surfaced, never retried into a paid route |
| `youtube_read` — video metadata | **ENABLED — LOCAL / ZERO-COST VERIFIED** | local yt-dlp | none | no | Live metadata read succeeded |
| `youtube_search` | **ENABLED — LOCAL / ZERO-COST VERIFIED** | local yt-dlp | none | no | Same local backend |
| `youtube_subtitle` — available captions | **ENABLED — LOCAL / ZERO-COST VERIFIED** | local yt-dlp | none | no | Public caption route; no login requested |
| `v2ex_hot` — public topics | **ENABLED — EXTERNAL FREE ROUTE VERIFIED** | V2EX public API | none | no | Live read succeeded, `backend: v2ex-api` |
| `v2ex_read` — topic and replies | **ENABLED — EXTERNAL FREE ROUTE VERIFIED** | V2EX public API | none | no | Same public backend |

All nine are read-only. The integration exposes no post, comment, like, follow,
message or account verb.

## Disabled — awaiting explicit user configuration

| Channel | State | Reason |
|---|---|---|
| reddit | AVAILABLE — USER CONFIGURATION REQUIRED | browser login; cookies are never imported automatically |
| twitter / X | AVAILABLE — USER CONFIGURATION REQUIRED | experimental, login-walled |
| facebook | AVAILABLE — USER CONFIGURATION REQUIRED | experimental, login-walled |
| instagram | AVAILABLE — USER CONFIGURATION REQUIRED | experimental, login-walled |
| xiaohongshu | AVAILABLE — USER CONFIGURATION REQUIRED | login-walled |
| linkedin | AVAILABLE — USER CONFIGURATION REQUIRED | in-site search needs a login; not enabled |
| boss | AVAILABLE — USER CONFIGURATION REQUIRED | login-walled job search |
| bilibili | AVAILABLE — USER CONFIGURATION REQUIRED | subtitles need a QR login; not relevant to recruitment |
| xueqiu | AVAILABLE — USER CONFIGURATION REQUIRED | community features need a browser session |

Enabling any of these requires the owner to log in personally. The integration
will not open a login window, extract cookies or accept a password.

## Blocked — cost or security policy

| Channel | State | Reason |
|---|---|---|
| youtube `transcribe` | BLOCKED — COST OR SECURITY POLICY | requires a paid Groq/OpenAI key |
| xiaoyuzhou `transcribe` | BLOCKED — COST OR SECURITY POLICY | requires a paid Groq/OpenAI key |
| **proxy feature** | BLOCKED — COST OR SECURITY POLICY | no proxy was configured, purchased or trialled |
| any write action | BLOCKED — COST OR SECURITY POLICY | this integration is read-only by design |

## Environment limitations

- The system Python is 3.9; upstream needs 3.10+. A private Python 3.12 was
  installed inside the project sandbox, so no system change was made.
- Login-walled channels are not "broken"; they are deliberately closed until the
  owner acts. No claim is made that they work.
