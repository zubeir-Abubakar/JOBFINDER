# Final report — OpenRouter + HeyGen live verification

Updated: 2026-11-25

## Outcome

**The key is valid. HeyGen speech, Chief's full response-to-speech flow and real Chromium playback all pass. OpenRouter text inference is still blocked by an upstream HTTP 429. The requested MP3 format is not available from the provider; the working output is WAV.**

No paid model, paid fallback, auto-recharge, direct-HeyGen fallback or Ollama substitution was used. Spending remained CHF 0.00.

## Live acceptance results

| Required check | Result | Evidence |
|---|---|---|
| Validate the key at `/api/v1/key` | **Pass** | HTTP 200, free tier, `usage=0`, `limit_remaining=10` |
| Real free OpenRouter text inference | **Fail — upstream 429** | Three distinct exact `:free` models returned 429; no usable text |
| Exact HeyGen speech generation | **Pass** | HTTP 200, model `heygen/heygen-voice-1-turbo:free`, voice `nadine` |
| Returned MP3 | **Not available** | Provider rejects MP3 and only supports PCM; route now returns WAV |
| Actual browser playback | **Pass** | Chromium `readyState=4`, `currentTime=0.27639`, `paused=false`, no media error |
| Chief Gemini → HeyGen → browser | **Pass** | Chief returned `CHIEF_LIVE_OK`; speech and playback succeeded |
| Gemini Live still works | **Pass (session minted)** | HTTP 200, `gemini-3.8-live`, voice `Charon`, ephemeral credential present |
| FreeLLMAPI still works | **Pass** | `freellmapi` / `openai/gpt-oss-20b`, routed via `groq` |
| CHF 0.00 protection | **Pass** | Key usage `0`; no paid route, fallback or recharge |
| Existing assignments preserved | **Pass** | Gemini and FreeLLMAPI map unchanged; no OpenRouter assignment |

## Key validation

`GET https://openrouter.ai/api/v1/key` returned HTTP 200 for the current key.

```text
is_free_tier:            true
limit:                   10
limit_remaining:         10
usage:                   0
usage_daily:             0
free_model_daily_requests:
  used:                  3
  limit:                 50
  remaining:             47
```

The three used requests are the three failed text attempts. The key was never printed or logged.

## OpenRouter text — remaining blocker

These exact free models were each attempted once:

```text
google/gemma-4-31b-it:free       HTTP 429  "Provider returned error"
google/gemma-4-26b-a4b-it:free   HTTP 429  "Provider returned error"
liquid/lfm-3-1.7b:free           HTTP 429  "Provider returned error"
```

The failure was fail-closed:

```text
errorClass:       rate_limited
httpStatus:       429
retryCount:       0
fallbackDecision: openrouter
fallbackFrom:     null
usableContent:    false
```

No text inference succeeded. No paid route and no Ollama call was made. The key itself is valid because speech succeeds against the same account; this is an upstream text/model-capacity 429, not an authentication failure.

## HeyGen speech — passed, but WAV not MP3

The live request used:

```text
model:   heygen/heygen-voice-1-turbo:free
voice:   nadine
provider.only:       ["heygen"]
provider.allow_fallbacks: false
```

OpenRouter rejected the original MP3 request with HTTP 400:

```text
HeyGen Voice only supports response_format "pcm".
```

The adapter now requests PCM, receives:

```text
Content-Type: audio/pcm;rate=44100;channels=1
```

and wraps the PCM16LE bytes in a WAV header locally. There is no new runtime transcoder or system dependency.

Direct speech evidence:

```text
bytes:          421672
format:         WAV / pcm_s16le / 44100 Hz / mono
duration:       4.780363 s
source:         openrouter-heygen
expiresAt:      2026-11-30T23:59:59.999Z
generationId:   gen-tts-1795618509-ArLHtTqXDd3ro90zQp0v
sha256:         a68b8605765e7a2cfb5fb637a30544d49d4530a315a6c6d75aad9e77353ebd28
```

Saved at `artifacts/openrouter-integration/live-heygen-nadine.wav`.

MP3 is not returned by this provider/model. If MP3 is a hard contract, it requires a transcoding step or a different speech provider; that remains unresolved.

## Chief → speech → browser — passed

The real authenticated page called `/api/assistant/message` and received:

```text
status:     200
agentKey:   coordinator
reply:      CHIEF_LIVE_OK
chars:      13
```

The same browser then called `/api/voice/speech` and received:

```text
status:        200
Content-Type:  audio/wav
source:        openrouter-heygen
model:         heygen/heygen-voice-1-turbo:free
voice:         nadine
bytes:         119296
RIFF/WAVE:     valid
duration:      1.352063 s
```

Chromium decoded and played the returned audio:

```text
readyState:   4
duration:     1.352063
currentTime:  0.27639
paused:       false
ended:        false
error:        null
```

Saved at `artifacts/openrouter-integration/chief-live-reply.wav`.

The earlier Chief 401 was a test-launch artifact: that supervisor had inherited a temporary `DATA_DIR`, so its session lookup used a different database. The test process was stopped. Final acceptance ran from a clean production launch with no test environment overrides.

## Gemini Live and FreeLLMAPI

Gemini Live session endpoint:

```text
status:                 200
model:                  gemini-3.8-live
voice:                  Charon
agent:                  coordinator
ephemeral credential:   present (not printed)
expires:                returned by the endpoint
```

A token was minted successfully. A full microphone-to-model live audio round-trip was not performed.

FreeLLMAPI text:

```text
provider:    freellmapi
model:       openai/gpt-oss-20b
routedVia:   groq / openai/gpt-oss-20b
usage:       92 prompt / 24 completion / 116 total
latency:     1856 ms
```

The response was truncated by the deliberately small 24-token test cap, but the live provider call succeeded.

## Preserved state and zero-cost safeguards

```text
users 1 · jobs 66 · applications 5 · documents 40
tasks 92 · workflows 14 · provider_usage 163
agents 8/8 enabled and registered
```

`provider_usage` is 163. The speech route does not write a `provider_usage` row; OpenRouter key usage is the authoritative evidence for that call. The last rows contain no new Ollama usage.

Assignments remain:

| Agent | Provider | Model |
|---|---|---|
| Chief, Saffa, Kora, Kali, Noor, Rayna | Gemini | `gemini-3.6-flash` |
| Ali, Amira | FreeLLMAPI | `gpt-oss-20b` |

`OPENROUTER_ASSIGNED_AGENTS` is empty. No paid model, paid fallback, auto-recharge or Ollama substitution was used. Gemini and FreeLLMAPI behavior is unchanged.

## Verification

```text
npm test:           585 tests, 581 pass, 4 skip, 0 fail
npm run typecheck:  exit 0
clean build:        exit 0, BUILD_ID IsRfatOQDJ29aZJJecbur
git diff --check:   exit 0
secret scan:        pass
server:             supervisor 3914, next-server 3921, one listener on :3000
GET /login:         200
GET /dashboard:     307 without a session
```

The production server was restarted cleanly with no temporary `DATA_DIR`, `APP_SECRET_KEY` or OpenRouter test assignment in its environment. No commit, push or deploy was made.

## Remaining blockers

1. **OpenRouter text 429** — all three exact free text models failed upstream with 429. The feature fails closed; text inference remains unproven until OpenRouter returns a successful completion.
2. **MP3 unavailable** — `heygen/heygen-voice-1-turbo:free` only emits PCM. The route returns browser-playable WAV. MP3 needs a transcoder or another provider.
