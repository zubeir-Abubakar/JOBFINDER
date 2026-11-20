import test from "node:test";
import assert from "node:assert/strict";

import { delegationRequest, namedAddress, resolveHandoverRequest } from "../lib/agent-sessions.ts";

test("ordinary conversation mentioning an agent name never switches agents", () => {
  assert.equal(resolveHandoverRequest("I mentioned Noor in my notes yesterday."), null);
  assert.equal(resolveHandoverRequest("I want to talk to you about our job search."), null);
  assert.equal(resolveHandoverRequest("What did Noor say about the application?"), null);
});

test("an explicit connection request resolves the immutable agent key", () => {
  assert.deepEqual(resolveHandoverRequest("Connect me to Noor."), {
    kind: "target",
    target: "application",
    reason: "Explicit agent request resolved from the registry.",
  });
  const kora = resolveHandoverRequest("Let me talk to Kora.");
  assert.equal(kora?.kind, "target");
  if (kora?.kind === "target") assert.equal(kora.target, "cv");
  const askKora = resolveHandoverRequest("Let me ask Kora something.");
  assert.equal(askKora?.kind, "target");
  if (askKora?.kind === "target") assert.equal(askKora.target, "cv");
  const askNoor = resolveHandoverRequest("Can you ask Noor to check that application?");
  assert.equal(askNoor, null, "a delegation is routed by delegationRequest, not as a bare handoff");
  const chief = resolveHandoverRequest("Take me back to Chief.");
  assert.equal(chief?.kind, "target");
  if (chief?.kind === "target") assert.equal(chief.target, "coordinator");
});

test("a clear connection request with no known target asks for clarification", () => {
  assert.equal(resolveHandoverRequest("Connect me to the onboarding team.")?.kind, "unknown");
});

test("delegation sends the actual request to the named specialist", () => {
  assert.deepEqual(delegationRequest("Ask Saffa to find more jobs."), {
    target: "research",
    request: "find more jobs.",
  });
  assert.deepEqual(delegationRequest("Can you ask Noor to check that application?"), {
    target: "application",
    request: "check that application?",
  });
  assert.deepEqual(delegationRequest("Bring Amira into this conversation."), {
    target: "cover",
    request: "",
  });
});

test("direct address keeps the specialist's real session and remainder", () => {
  assert.deepEqual(namedAddress("Noor, what applications have you submitted?"), {
    target: "application",
    remainder: "what applications have you submitted?",
  });
  assert.equal(namedAddress("What applications have you submitted?"), null);
});

test("a greeting followed by a name addresses that agent, even from another session", () => {
  assert.deepEqual(namedAddress("Hi Chief, how are you?"), {
    target: "coordinator",
    remainder: "how are you?",
  });
  assert.equal(namedAddress("Hey Noor, what did you submit?")?.target, "application");
  assert.equal(namedAddress("Chief how are we doing?")?.target, "coordinator");
});
