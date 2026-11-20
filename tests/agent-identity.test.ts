import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_IDENTITY_KEYS,
  AGENT_IDENTITIES,
  agentIdentity,
  agentIdentityForName,
  agentKeyForName,
  agentKeysMentioned,
  agentNameList,
  agentRoster,
  agentSignature,
} from "../lib/agent-identity.ts";
import { workflowOrderLabel } from "../lib/workflow-stages.ts";
import { namedAddress, normaliseAgentKey, resolveHandoverRequest } from "../lib/agent-sessions.ts";

const EXPECTED: Array<[string, string, string]> = [
  ["coordinator", "Chief", "Chief Coordinator / Orchestrator"],
  ["research", "Saffa", "Job Research Agent / Discovery"],
  ["analysis", "Ali", "Job Analysis Agent / Matching"],
  ["cv", "Kora", "CV Optimisation Agent / Documents"],
  ["ats", "Kali", "ATS Quality Control Agent"],
  ["cover", "Amira", "Application Agent / Cover Letter & Documents"],
  ["application", "Noor", "Application Agent / Submission"],
  ["email", "Rayna", "Email & Tracking Agent"],
];

test("all eight names map to the original immutable agent IDs and exact titles", () => {
  assert.deepEqual([...AGENT_IDENTITY_KEYS], EXPECTED.map(([key]) => key));
  assert.equal(agentRoster().length, 8);
  assert.equal(new Set(agentRoster().map((agent) => agent.name)).size, 8);
  for (const [key, name, title] of EXPECTED) {
    const identity = agentIdentity(key);
    assert.equal(identity.key, key, "the internal key is unchanged");
    assert.equal(identity.name, name);
    assert.equal(identity.title, title);
    assert.equal(identity.shortName, name, "legacy UI alias resolves to the display name");
    assert.equal(agentKeyForName(name), key);
    assert.equal(agentIdentityForName(title)?.key, key);
    assert.ok(identity.introduction.startsWith("Hello Boss") || identity.introduction.startsWith("Hi Boss"));
    assert.deepEqual(identity.email.signature.slice(0, 2), [name, title]);
  }
  assert.deepEqual(Object.keys(AGENT_IDENTITIES), EXPECTED.map(([key]) => key));
});

test("names are unique and ambiguous title fragments resolve to the documented agent", () => {
  const names = agentRoster().map((agent) => agent.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.equal(agentKeyForName("Noor"), "application");
  assert.equal(agentKeyForName("Amira"), "cover");
  assert.equal(agentKeyForName("Application Agent / Cover Letter & Documents"), "cover");
  assert.equal(agentKeyForName("Application Agent / Submission"), "application");
  assert.equal(normaliseAgentKey("Rayna"), "email");
  assert.equal(agentKeyForName("not an agent"), null);
  assert.notEqual(agentKeyForName("Kora"), agentKeyForName("Kali"));
});

test("bare names and named addresses select the real agent without a model call", () => {
  assert.deepEqual(namedAddress("Saffa"), { target: "research", remainder: "" });
  assert.deepEqual(namedAddress("Noor, which applications have you submitted?"), {
    target: "application",
    remainder: "which applications have you submitted?",
  });
  assert.deepEqual(namedAddress("Ali, explain why this job was rejected."), {
    target: "analysis",
    remainder: "explain why this job was rejected.",
  });
  assert.deepEqual(namedAddress("Chief, give me today's overview."), {
    target: "coordinator",
    remainder: "give me today's overview.",
  });
  assert.equal(namedAddress("Can you explain the workflow?"), null);
});

test("transfer verbs still route to the correct named agent and Chief remains returnable", () => {
  assert.deepEqual(resolveHandoverRequest("Connect me to Noor"), {
    kind: "target",
    target: "application",
    reason: "Explicit agent request resolved from the registry.",
  });
  assert.deepEqual(resolveHandoverRequest("Take me to Kora"), {
    kind: "target",
    target: "cv",
    reason: "Explicit agent request resolved from the registry.",
  });
  assert.deepEqual(resolveHandoverRequest("Return to Chief"), {
    kind: "target",
    target: "coordinator",
    reason: "Explicit agent request resolved from the registry.",
  });
  assert.equal(resolveHandoverRequest("take me back")?.kind, "previous");
  assert.equal(resolveHandoverRequest("Transfer me to the marketing agent")?.kind, "unknown");
});

test("every agent introduction names its own role and no other agent's role", () => {
  for (const identity of agentRoster()) {
    assert.match(identity.introduction, new RegExp(identity.name));
    assert.match(identity.introduction, new RegExp(identity.title.split(" / ")[0].replace("&", "and")));
    for (const other of agentRoster().filter((candidate) => candidate.key !== identity.key)) {
      if (other.name === "Chief") continue;
      assert.doesNotMatch(identity.introduction, new RegExp(`I'm ${other.name}\\b`));
    }
  }
});

test("Chief's signature is name, title and company in that order", () => {
  assert.deepEqual(agentSignature("coordinator"), [
    "Chief",
    "Chief Coordinator / Orchestrator",
    "AT AI Workforce",
  ]);
  assert.equal(workflowOrderLabel(), "Chief → Saffa → Ali → Kora → Amira → Kali → Noor → Rayna");
  assert.equal(agentNameList(), "Chief, Saffa, Ali, Kora, Kali, Amira, Noor and Rayna");
});

test("names found in free text are resolved centrally, without a duplicate alias table", () => {
  assert.deepEqual(agentKeysMentioned("Noor has submitted an application for the QA role"), ["application"]);
  assert.deepEqual(agentKeysMentioned("Kora and Amira prepared the documents"), ["cv", "cover"]);
  assert.deepEqual(agentKeysMentioned("quality control passed"), ["ats"]);
  assert.deepEqual(agentKeysMentioned("No agent is mentioned here"), []);
  assert.equal(resolveHandoverRequest("Connect me to Noor about my application")?.kind, "target");
  const target = resolveHandoverRequest("Connect me to Noor about my application");
  if (target?.kind === "target") assert.equal(target.target, "application");
  assert.equal(resolveHandoverRequest("Connect me to Noor and Ali")?.kind, "unknown");
});
