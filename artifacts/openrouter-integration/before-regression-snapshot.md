# Before — OpenRouter + HeyGen integration

Captured: 2026-11-25, before code changes and before the restart.

## Repository

- Branch: `main`
- Working tree: heavily modified before this task; all existing user changes were preserved.
- No reset, checkout or database migration was performed.
- `.env` was read only to confirm names and presence. Secret values were never printed.
- `OPENROUTER_API_KEY` was present. `OPENROUTER_MODEL`, the TTS variables and `HEYGEN_API_KEY` were absent.
- No OpenRouter inference adapter existed. The prior provider comment/config explicitly blocked OpenRouter at the policy layer.

## Running processes

| Process | PID | Address |
|---|---:|---|
| Production supervisor | 89590 | `0.0.0.0:3000` (IPv4 child 89594) |
| `next dev` | 90963 | `localhost:3000` (IPv6 child 90964) |

Two Next.js servers were sharing port 3000 on different address families before the task.

- Production build ID: `vURcId9uYOO2BPOmbKHyE`
- Production `/api/health` was 404 because production requires a health token and `.env` has no `HEALTHCHECK_TOKEN` / `HEALTH_PUBLIC=true`.
- Dev-server `/api/health` was 200.
- Database integrity was `ok`, schema 26.

## Baseline test result

```text
npm test: 579 tests
          575 passed
          4 skipped
          0 failed
```

The baseline production database counts were recorded as:

| Record | Count |
|---|---:|
| users | 1 |
| jobs | 66 |
| applications | 5 |
| documents | 40 |
| tasks | 92 |
| workflows | 14 |
| provider_usage | 162 |

The same counts were observed after implementation; no database reset or data replacement occurred.

## Baseline provider state

- Gemini text: owner-attested free tier, operational.
- FreeLLMAPI: owner-attested free tier, operational.
- Gemini Live: owner-attested free tier, constrained token path operational.
- OpenRouter: key present, no model assignment, no adapter, blocked.
- HeyGen: not configured.
- External spend ceiling: CHF 0.00.

## OpenRouter catalogue evidence available before implementation

The public catalogue (queried with `output_modalities=speech&max_price=0`) contained:

```text
heygen/heygen-voice-1-turbo:free
pricing.prompt = 0
pricing.completion = 0
expiration_date = 2026-11-30
supported_voices = nadine, tabitha, bram, gareth, noelle, meredith, sabrina, lucian, weston, vincent
```

The text-filtered catalogue contained 11 exact `:free` text models, including `google/gemma-4-31b-it:free`.
