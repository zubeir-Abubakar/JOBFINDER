import test from "node:test";
import assert from "node:assert/strict";
import { agentPresentation } from "../lib/agent-presentation.ts";

const available = { available: true, reason: null, dependency: null, cause: null };

test("a completed last task is history, not the current agent state", () => {
  const view = agentPresentation({
    enabled: true,
    status: "completed",
    currentTask: null,
    availability: available,
    lastTask: { status: "completed", title: "Score vacancies", at: "2026-11-18T10:00:00.000Z" },
  });
  assert.equal(view.availability.state, "online");
  assert.equal(view.task.state, "idle");
  assert.equal(view.task.detail, "Idle — no task assigned");
  assert.equal(view.lastOutcome.state, "completed");
  assert.match(view.lastOutcome.detail, /Score vacancies/);
});

test("a failed last task is shown as an outcome while the agent is idle", () => {
  const view = agentPresentation({
    enabled: true,
    status: "idle",
    currentTask: null,
    availability: available,
    lastTask: { status: "failed", title: "Fetch source", at: "2026-11-18T10:00:00.000Z" },
  });
  assert.equal(view.task.state, "idle");
  assert.equal(view.lastOutcome.state, "failed");
});

test("availability distinguishes offline, degraded and unavailable", () => {
  assert.equal(agentPresentation({ enabled: false, status: "disabled", currentTask: null, availability: available }).availability.state, "offline");
  assert.equal(agentPresentation({ enabled: true, status: "paused", currentTask: null, availability: available }).availability.state, "offline");
  assert.equal(
    agentPresentation({
      enabled: true,
      status: "idle",
      currentTask: null,
      availability: { available: false, reason: "gateway down", dependency: "AI provider", cause: "health" },
    }).availability.state,
    "degraded",
  );
  assert.equal(
    agentPresentation({
      enabled: true,
      status: "idle",
      currentTask: null,
      availability: { available: false, reason: "missing key", dependency: "AI provider", cause: "configuration" },
    }).availability.state,
    "unavailable",
  );
});

test("restricted AI keeps the agent operational and labels the limitation", () => {
  const view = agentPresentation({
    enabled: true,
    status: "idle",
    currentTask: null,
    availability: {
      available: true,
      restricted: true,
      restriction: "ai_inference",
      reason: "External AI is blocked by the CHF 0.00 policy.",
      dependency: "AI inference",
      cause: "configuration",
    },
  });
  assert.equal(view.availability.state, "degraded");
  assert.match(view.availability.label, /Operational · AI restricted/);
  assert.equal(view.task.state, "idle");
});

test("active task states remain distinct from availability", () => {
  assert.equal(agentPresentation({ enabled: true, status: "working", currentTask: "Scoring", availability: available }).task.state, "running");
  assert.equal(agentPresentation({ enabled: true, status: "thinking", currentTask: "Scoring", availability: available }).task.state, "thinking");
  assert.equal(agentPresentation({ enabled: true, status: "waiting", currentTask: "Browser", availability: available }).task.state, "waiting_tool");
});
