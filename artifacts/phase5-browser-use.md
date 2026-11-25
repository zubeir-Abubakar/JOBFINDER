# Phase 5 — Browser-use evaluation

Date: 2026-11-24. Decision: **do not install**.

## Findings

- `browser-use` requires Python 3.11+. This machine has **Python 3.9.6**, and
  `import browser_use` fails. Installing it would require adding a second
  Python runtime to the project environment.
- The default Browser Use path is Browser Use Cloud, which needs
  `BROWSER_USE_API_KEY` and is billed. That violates the CHF 0.00 constraint.
- A local Chromium + Ollama path exists, but it gives no guaranteed free
  inference and adds a second autonomous browser agent beside the existing
  candidate-form driver, expanding the attack and maintenance surface.
- The existing candidate-form driver already covers the safe, deterministic
  form-filling use case required for applications, with hard CAPTCHA/MFA gates.

## Decision

No dependency, no Python upgrade, no API key and no cloud account were added.
Automatic submission continues through the existing verified channels. The
integration remains an evaluated option, not part of the runtime.

## What would change the decision

- An owner-provided local model with sufficient tool-calling reliability,
  running on this machine at CHF 0.00, **and** a measured need that the
  deterministic form driver cannot meet. Any adoption would require a separate
  security review, a Python 3.11+ environment and explicit owner approval.
