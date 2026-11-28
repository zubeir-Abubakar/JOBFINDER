import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-agent-ops-"));
process.env.APP_SECRET_KEY = "agent-operations-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const sessions = await import("../lib/agent-sessions.ts");
const voices = await import("../lib/agent-voices.ts");
const capabilities = await import("../lib/agent-capabilities.ts");
const operations = await import("../lib/operations.ts");
const providers = await import("../lib/providers.ts");
const availability = await import("../lib/agent-availability.ts");

db.getDb();
const now = new Date().toISOString();
db.run(
  "INSERT INTO users (id, email, password_hash, name, role, status, must_change_password, created_at) VALUES ('u_ops', 'ops@test.local', 'not-used', 'Owner', 'owner', 'active', 0, ?)",
  [now],
);
db.run(
  "INSERT INTO users (id, email, password_hash, name, role, status, must_change_password, created_at) VALUES ('u_ops2', 'ops2@test.local', 'not-used', 'Owner', 'owner', 'active', 0, ?)",
  [now],
);

test("the current schema persists sessions, provider health, MFA, HTML mail and delivery state without rewriting history", () => {
  assert.equal(db.schemaVersion(), db.SCHEMA_VERSION);
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
  assert.ok(tables.includes("agent_sessions"));
  const columns = db.all<{ name: string }>("PRAGMA table_info(provider_usage)").map((row) => row.name);
  for (const column of ["usage_source", "cached_tokens", "session_id"]) assert.ok(columns.includes(column), `${column} missing`);
  const outboxColumns = db.all<{ name: string }>("PRAGMA table_info(notification_outbox)").map((row) => row.name);
  assert.ok(outboxColumns.includes("html_body"), "html_body missing");
});

test("all eight agents have distinct, supported Gemini Live voices", () => {
  const profiles = Object.values(voices.AGENT_VOICE_PROFILES);
  assert.equal(profiles.length, 8);
  assert.equal(new Set(profiles.map((profile) => profile.voiceId)).size, 8);
  for (const profile of profiles) {
    assert.equal(profile.provider, "gemini-live");
    assert.equal(profile.available, true);
    assert.ok(voices.isLiveVoiceId(profile.voiceId));
  }
  assert.equal(voices.voiceProfileForAgent("coordinator").voiceId, "Charon");
  assert.equal(voices.voiceProfileForAgent("research").voiceId, "Leda");
  assert.equal(voices.voiceProfileForAgent("application").voiceId, "Orus");
  assert.equal(voices.voiceProfileForAgent("email").voiceId, "Zephyr");
  assert.equal(voices.voiceProfileForAgent("not-an-agent").agentKey, "coordinator");
});

test("handover is resolved deterministically from registry names and aliases", () => {
  assert.deepEqual(sessions.resolveHandoverRequest("Transfer me to the research agent"), {
    kind: "target",
    target: "research",
    reason: "Explicit agent request resolved from the registry.",
  });
  assert.equal(sessions.resolveHandoverRequest("I want to talk to ATS Quality Control")?.kind, "target");
  assert.equal(sessions.resolveHandoverRequest("switch to the email agent")?.kind, "target");
  assert.equal(sessions.resolveHandoverRequest("take me back")?.kind, "previous");
  assert.deepEqual(sessions.resolveHandoverRequest("return to the chief coordinator"), {
    kind: "target",
    target: "coordinator",
    reason: "Explicit agent request resolved from the registry.",
  });
  assert.equal(sessions.resolveHandoverRequest("go back to the coordinator")?.kind, "target");
  assert.equal(sessions.resolveHandoverRequest("transfer me to the marketing agent")?.kind, "unknown");
  assert.equal(sessions.resolveHandoverRequest("what are the agents doing?"), null);
  assert.equal(sessions.agentKeyForName("Job Research Agent"), "research");
});

test("direct sessions activate immediately, retain the previous agent and return instantly", () => {
  const first = sessions.activateAgentSession("u_ops", "research", "Earlier context");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.session.agentKey, "research");
  assert.equal(first.session.previousAgentKey, "coordinator");
  assert.equal(sessions.activeAgentSession("u_ops").agentKey, "research");

  const second = sessions.activateAgentSession("u_ops", "cv", "Context for CV");
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(sessions.activeAgentSession("u_ops").agentKey, "cv");
  assert.equal(sessions.previousAgentFor("u_ops"), "research");

  const back = sessions.activateAgentSession("u_ops", "research", "Return context");
  assert.equal(back.ok, true);
  if (!back.ok) return;
  assert.equal(back.session.agentKey, "research");
  assert.equal(sessions.previousAgentFor("u_ops"), "cv");
  assert.equal(sessions.activeAgentSession("u_ops").contextSummary, "Return context");
});

test("disabled or paused agents are refused; a busy agent remains readable", () => {
  db.run("UPDATE agents SET enabled = 0 WHERE key = 'email'");
  const disabled = sessions.activateAgentSession("u_ops2", "email");
  assert.equal(disabled.ok, false);
  assert.match(disabled.reason, /disabled/i);
  db.run("UPDATE agents SET enabled = 1 WHERE key = 'email'");

  db.run("UPDATE agents SET status = 'paused' WHERE key = 'email'");
  const paused = sessions.activateAgentSession("u_ops2", "email");
  assert.equal(paused.ok, false);
  assert.match(paused.reason, /paused/i);
  db.run("UPDATE agents SET status = 'idle' WHERE key = 'email'");

  db.run("UPDATE agents SET status = 'working', current_task = 'Testing direct chat while busy' WHERE key = 'research'");
  const busy = sessions.activateAgentSession("u_ops2", "research");
  assert.equal(busy.ok, true);
  if (!busy.ok) return;
  assert.equal(busy.busy, true);
  assert.match(busy.note ?? "", /read-only/i);
  db.run("UPDATE agents SET status = 'idle', current_task = NULL WHERE key = 'research'");
});

test("permission inspection distinguishes available, granted, policy-gated and prohibited", () => {
  const application = capabilities.capabilitiesForAgent("application");
  const submit = application.find((capability) => capability.id === "submit_application");
  assert.ok(submit);
  assert.equal(submit.available, true);
  assert.equal(submit.granted, false);
  assert.equal(submit.prohibited, false);
  assert.match(submit.restriction ?? "", /standing authorisation|approval/i);

  const email = capabilities.capabilitiesForAgent("email");
  for (const id of ["execute_shell", "modify_database", "export_credentials"] as const) {
    const capability = email.find((item) => item.id === id);
    assert.ok(capability);
    assert.equal(capability.prohibited, true);
    assert.equal(capability.granted, false);
    assert.equal(capability.available, false);
  }
  assert.match(capabilities.permissionBrief(), /Prohibited/);
});

test("token rows carry provider/estimated provenance and one attempt per inference", async () => {
  providers.recordUsage({
    provider: "freellmapi",
    model: "test-model",
    agentKey: "research",
    sessionId: "voice_test_123",
    source: "assistant",
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    usageSource: "provider",
    cachedTokens: 30,
    latencyMs: 12,
    status: "ok",
  });
  providers.recordUsage({
    provider: "ollama",
    model: "local",
    agentKey: "research",
    sessionId: "voice_test_123",
    source: "assistant",
    usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
    usageSource: "estimated",
    latencyMs: 8,
    status: "ok",
  });
  providers.recordUsage({
    provider: "freellmapi",
    model: "test-model",
    agentKey: "research",
    sessionId: "voice_test_123",
    source: "assistant",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    usageSource: "unknown",
    latencyMs: 2,
    status: "error",
    error: "simulated retryable failure",
  });

  const rows = db.all<{ usage_source: string; cached_tokens: number; session_id: string; total_tokens: number }>(
    "SELECT usage_source, cached_tokens, session_id, total_tokens FROM provider_usage WHERE agent_key = 'research' ORDER BY id",
  );
  assert.equal(rows.length, 3, "each provider attempt gets exactly one row");
  assert.deepEqual(rows.map((row) => row.usage_source), ["provider", "estimated", "unknown"]);
  assert.equal(rows[0].cached_tokens, 30);
  assert.equal(rows[0].session_id, "voice_test_123");
  assert.equal(rows[2].total_tokens, 0, "a failed attempt cannot add imaginary tokens");

  const totals = (await operations.getOperationalSnapshot()).tokens.today;
  assert.equal(totals.requests, 3);
  assert.equal(totals.totalTokens, 200);
  assert.equal(totals.providerReportedTokens, 120);
  assert.equal(totals.estimatedTokens, 80);
  assert.equal(totals.failedRequests, 1);
});

test("missing AI restricts Chief without taking deterministic coordination offline", () => {
  const chief = availability.agentAvailability("coordinator");
  assert.equal(chief.available, true);
  assert.equal(chief.restricted, true);
  assert.equal(chief.restriction, "ai_inference");
  assert.match(chief.reason ?? "", /deterministic coordination remains available/i);
  assert.equal(availability.effectiveAgentStatus("idle", true, chief), "idle");
});

test("the live operational snapshot answers without inventing provider or token state", async () => {
  const snapshot = await operations.getOperationalSnapshot();
  assert.equal(snapshot.agentCount, 8);
  assert.equal(snapshot.database.schemaVersion, db.SCHEMA_VERSION);
  assert.ok(snapshot.agents.every((agent) => agent.voice.available));
  assert.equal(snapshot.tokens.today.totalTokens, 200);
  assert.equal(snapshot.tokens.today.costStatus, "unverified");
  assert.equal(snapshot.credentials.freeLlmApiKeyConfigured, false);
  assert.match(snapshot.permissions.summary, /granted/i);

  assert.match(operations.answerFromOperations("How many agents are registered?", snapshot) ?? "", /8 agents/);
  assert.match(operations.answerFromOperations("Which agents are currently running?", snapshot) ?? "", /Running or waiting/);
  assert.match(operations.answerFromOperations("Which agents are idle?", snapshot) ?? "", /Idle/);
  const assignments = operations.answerFromOperations("Which model does each agent use?", snapshot) ?? "";
  assert.match(assignments, /configured/i);
  assert.match(assignments, /actual latest/i);
  const focused = operations.answerFromOperations("What is your current status, provider, model and voice?", snapshot, "research") ?? "";
  assert.match(focused, /Saffa/);
  assert.match(focused, /Job Research Agent \/ Discovery/);
  assert.match(focused, /Leda/);
  assert.match(focused, /provider/i);
  const mostTokens = operations.answerFromOperations("Which agent uses the most tokens?", snapshot) ?? "";
  assert.match(mostTokens, /By agent:/);
  assert.doesNotMatch(mostTokens, /^•/);
  const permissions = operations.answerFromOperations("Which permissions are granted to the agents?", snapshot) ?? "";
  assert.match(permissions, /Prohibited/);
  assert.match(permissions, /granted/i);
  const scheduler = operations.answerFromOperations("What is the recruitment scheduler doing, and how many applications are verified?", snapshot) ?? "";
  assert.match(scheduler, /Scheduler/);
  assert.match(scheduler, /verified submissions/);
  const tokens = operations.answerFromOperations("How many tokens did we use today?", snapshot) ?? "";
  assert.match(tokens, /provider-reported/i);
  assert.match(tokens, /estimated/i);
  assert.match(tokens, /unverified/i);
  const health = operations.answerFromOperations("Is the system healthy?", snapshot) ?? "";
  assert.match(health, /health is/i);
  const latestRun = operations.answerFromOperations("Why did the latest recruitment run fail?", snapshot) ?? "";
  assert.match(latestRun, /Latest run|No recruitment run/);
  const quota = operations.answerFromOperations("Which provider was exhausted and when is the next retry?", snapshot) ?? "";
  assert.match(quota, /Provider routes cooling down/);
  assert.match(quota, /Next provider retry/);
  const email = operations.answerFromOperations("Was Gmail authenticated and did the daily report email send?", snapshot) ?? "";
  assert.match(email, /Email provider:/);
  assert.match(email, /Executive Brief/);
  assert.match(email, /state generated|state queued|state accepted_by_provider|state accepted_by_gmail|state sent_folder_observed|state delivery_confirmed/);
  assert.match(email, /not delivery-confirmed/);
  const brief = operations.operationsBrief(snapshot);
  assert.match(brief, new RegExp(`schema v${db.SCHEMA_VERSION}`));
  assert.match(brief, /provider accepted \(not delivery-confirmed\)/);
  assert.match(brief, /Sent-folder observed/);
  assert.match(brief, /delivery confirmed/);
});
