# After — OpenRouter + HeyGen integration

Captured: 2026-11-25, after the successful live follow-up.

## Implemented

- `lib/openrouter.ts`: authenticated key check, zero-price catalogue discovery, exact `:free` validation, model/modality validation, expiry enforcement, separate text and speech configuration.
- `lib/providers.ts`: OpenAI-compatible OpenRouter chat-completions adapter, streaming and non-streaming, actual model/provider capture, bounded 429 handling, fail-closed errors, no paid substitution.
- `lib/voice.ts`: dedicated HeyGen speech path using `/api/v1/audio/speech`, model `heygen/heygen-voice-1-turbo:free`, provider restriction `heygen`, `allow_fallbacks:false`, PCM output wrapped as WAV, cache and expiry metadata.
- `app/api/voice/speech/route.ts`: Chief speech uses the dedicated OpenRouter HeyGen path; response headers expose source/model/expiry, never credentials.
- `components/VoiceAssistant.tsx`: default voice `nadine`; unsupported stored voices fall back to the published HeyGen free-voice set.
- `lib/agent-models.ts`: opt-in `OPENROUTER_ASSIGNED_AGENTS`; empty by default. An assigned OpenRouter agent fails closed instead of falling through to Ollama.
- `lib/ai-spending-policy.ts`: exact `:free` OpenRouter policy gate plus TTS expiry gate.
- Admin AI page, dashboard projection and environment templates show OpenRouter text and HeyGen speech status/expiry.
- `tests/openrouter-integration.test.ts`: six mock-labelled tests, including PCM response and WAV wrapping.

## Test/type/build evidence

```text
npm test: 585 tests
          581 passed
          4 skipped
          0 failed

npm run typecheck: exit 0
npm run build:     exit 0
git diff --check:  exit 0
secret scan:       PASS
```

## Restart

The contaminated test launch was stopped. Final acceptance used a clean production launch with no temporary `DATA_DIR`, `APP_SECRET_KEY` or OpenRouter assignment in the environment.

```text
supervisor PID 3914
next-server PID 3921
TCP *:3000 (IPv4) — one listener
build ID IsRfatOQDJ29aZJJecbur
GET /login = 200
GET /dashboard without session = 307
```

## Database and roster

```text
status: operational
database: integrity ok, schema 26, mode 0600
users 1 · jobs 66 · applications 5 · documents 40
tasks 92 · workflows 14 · provider_usage 163
agents: 8 enabled, 8 registered
```

`provider_usage` is 163. The speech route does not write a `provider_usage` row; OpenRouter key usage is the authoritative evidence there.

Existing assignments remain:

| Agent | Provider | Model |
|---|---|---|
| Chief | Gemini | `gemini-3.6-flash` |
| Saffa | Gemini | `gemini-3.6-flash` |
| Ali | FreeLLMAPI | `gpt-oss-20b` |
| Kora | Gemini | `gemini-3.6-flash` |
| Kali | Gemini | `gemini-3.6-flash` |
| Amira | FreeLLMAPI | `gpt-oss-20b` |
| Noor | Gemini | `gemini-3.6-flash` |
| Rayna | Gemini | `gemini-3.6-flash` |

`OPENROUTER_ASSIGNED_AGENTS` is empty.

## Live checks actually exercised

### Gemini text — passed

```text
provider=gemini
model=gemini-3.6-flash
text=CHIEF_LIVE_OK
```

### FreeLLMAPI text — passed

```text
provider=freellmapi
model=openai/gpt-oss-20b
routedVia=groq/openai/gpt-oss-20b
usage=92/24/116
```

The response was truncated by the test's 24-token cap, but the provider call succeeded.

### Gemini Live — passed (session minted)

```text
agent=coordinator
voice=Charon
model=gemini-3.8-live
ephemeral token returned, not printed
```

A full microphone-to-model audio round-trip was not performed.

### OpenRouter key — passed

```text
HTTP 200
is_free_tier=true
usage=0
limit_remaining=10
free_model_daily_requests=3/50
```

### OpenRouter text — upstream 429

```text
google/gemma-4-31b-it:free       429
google/gemma-4-26b-a4b-it:free   429
liquid/lfm-3-1.7b:free           429
```

No text was returned. The adapter failed closed with `retryCount=0` and no Ollama fallback.

### OpenRouter HeyGen speech — passed

```text
HTTP 200
model=heygen/heygen-voice-1-turbo:free
voice=nadine
source=openrouter-heygen
content-type=audio/wav
bytes=421672
duration=4.780363s
expiresAt=2026-11-30T23:59:59.999Z
```

The provider rejected MP3 and required `response_format=pcm`. The adapter now receives `audio/pcm;rate=44100;channels=1` and wraps it as WAV.

### Chief → speech → browser — passed

```text
Chief reply:   CHIEF_LIVE_OK
Speech:        200, audio/wav, 119296 bytes, 1.352063s
Playback:      readyState=4, currentTime=0.27639, paused=false, error=null
```

## Zero-cost safeguards preserved

- `OPENROUTER_ALLOW_PAID_MODELS`, credits and auto-recharge flags remain ignored.
- Exact `:free` id required; `openrouter/free` is rejected.
- Catalogue price must be all zero.
- Expired free model is rejected.
- TTS is restricted to provider `heygen` with fallbacks disabled.
- Paid counterpart is never substituted.
- No fabricated cost: usage remains `cost_status=unverified`, `cost_chf=0`.
- An OpenRouter failure produces no Ollama call when an agent is explicitly assigned to OpenRouter.

## Remaining limitations

1. OpenRouter text returned 429 for all three exact free models; text inference remains unproven.
2. The HeyGen model does not support MP3; the working output is WAV.
