# Regression comparison

| Check | Before | After | Result |
|---|---|---|---|
| Test suite | 579 tests, 575 pass, 4 skip, 0 fail | 585 tests, 581 pass, 4 skip, 0 fail | Pass — six mock tests added |
| TypeScript | Not captured before edit | `tsc --noEmit` exit 0 | Pass |
| Production build | Existing build `vURcId9uYOO2BPOmbKHyE` | Clean build `IsRfatOQDJ29aZJJecbur`, exit 0 | Pass |
| HTTP service | Two listeners on port 3000 | One listener, supervisor 3914 / next-server 3921 | Pass — duplicate removed |
| Root / login | 200 / 200 | 200 / 200 | Pass |
| Public `/api/health` | 404 (production token required) | 404 (production token required) | Unchanged, not a regression |
| Direct operational health | operational, schema 26 | operational, schema 26 | Pass |
| Database counts | users 1, jobs 66, apps 5, docs 40, tasks 92, workflows 14, usage 162 | users 1, jobs 66, apps 5, docs 40, tasks 92, workflows 14, usage 163 | Pass — counts preserved; no new Ollama row |
| Roster | 8 enabled agents | 8 enabled agents | Pass |
| Agent assignments | Gemini/FreeLLMAPI map | identical; OpenRouter assignment empty | Pass |
| Recruitment schedule | 12:00 Europe/Zurich daily | 12:00 Europe/Zurich daily | Pass |
| Gemini text | operational | real `CHIEF_LIVE_OK`, `gemini-3.6-flash` | Pass |
| FreeLLMAPI text | operational | real `openai/gpt-oss-20b`, routed via groq, 92/24/116 | Pass |
| Gemini Live | operational | HTTP 200, `gemini-3.8-live`, Chief/Charon, ephemeral token | Pass — session minted |
| OpenRouter key | HTTP 401 | HTTP 200, free tier, usage 0, limit remaining 10 | Pass |
| OpenRouter text | adapter absent | three exact free models, all upstream HTTP 429 | **Fail — upstream rate limit** |
| OpenRouter HeyGen speech | not integrated | HTTP 200, PCM wrapped as WAV, 421672 bytes, 4.78 s | Pass |
| Browser HeyGen playback | not possible | Chromium `readyState=4`, `currentTime=0.27639`, no error | Pass |
| Chief response-to-speech | FreeLLMAPI TTS / browser | Chief Gemini → HeyGen WAV → Chromium playback | Pass |
| MP3 response | expected | provider only supports PCM; route returns WAV | **Not met — format constraint** |
| Paid/dynamic rejection | pass | pass, plus zero-price catalogue validation | Pass |
| 429 handling | pass | pass, live 429 fail-closed; no fallback | Pass |
| No Ollama substitution on OpenRouter failure | not applicable | no new Ollama usage row | Pass |
| CHF 0.00 enforcement | pass | key usage 0, no paid route or recharge | Pass |

## Net result

The application, database, roster, schedule, Gemini, FreeLLMAPI, Gemini Live and zero-cost protections are preserved. The key is valid; HeyGen speech, Chief's end-to-end flow and browser playback now pass. OpenRouter text remains blocked by upstream 429, and the provider cannot return MP3, so the delivered audio is WAV.
