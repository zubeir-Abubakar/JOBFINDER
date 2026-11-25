import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Eight-agent contract and execution-path audit.
 *
 * These tests use the real persisted task helpers. They do not call a provider;
 * every task is deterministic. The point is to prove that each registered
 * agent can be assigned work and that only its owner can complete it.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-agent-contracts-"));
process.env.APP_SECRET_KEY = "agent-contracts-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const agents = await import("../lib/agents.ts");
const definitions = await import("../lib/agent-definitions.ts");
const capabilities = await import("../lib/agent-capabilities.ts");
const voices = await import("../lib/agent-voices.ts");
const workflow = await import("../lib/workflow-stages.ts");

db.getDb();
db.run("UPDATE agents SET enabled = 1, status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'idle' END");
db.run("INSERT OR IGNORE INTO profiles (id) VALUES (1)");
db.run(
  "UPDATE profiles SET full_name = ?, email = ?, phone = ?, location = ?, work_authorisation = ? WHERE id = 1",
  ["Ada Lovelace", "ada@example.test", "+41 79 000 00 00", "Zürich", "Swiss Permit B"],
);
db.run(
  "INSERT INTO skills (name, category, level, verified, source, sort) VALUES ('Playwright', 'Automation', 'advanced', 1, 'manual', 1)",
);
db.run(
  "INSERT INTO experiences (company, title, location, start_date, is_current, summary, achievements, sort) VALUES (?, ?, ?, ?, 1, ?, ?, 1)",
  ["Fixture AG", "Senior QA Engineer", "Zürich", "2020-01", "Owned test automation.", JSON.stringify(["Built a suite."])],
);
db.run(
  "INSERT OR REPLACE INTO job_sources (key, name, kind, url, enabled) VALUES ('arbeitnow', 'Arbeitnow job board', 'api', 'https://www.arbeitnow.com/api/job-board-api', 1)",
);

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

const EXPECTED: Array<[string, string]> = [
  ["coordinator", "Chief"],
  ["research", "Saffa"],
  ["analysis", "Ali"],
  ["cv", "Kora"],
  ["cover", "Amira"],
  ["ats", "Kali"],
  ["application", "Noor"],
  ["email", "Rayna"],
];

for (const [key, name] of EXPECTED) {
  test(`${name} (${key}) has a runtime assignment contract and can execute a persisted task`, () => {
    const definition = definitions.agentDefinition(key);
    assert.ok(definition, `${name} must be registered`);
    assert.equal(definition!.name, name);
    assert.ok(definition!.instructions.length > 80, `${name} instructions are substantive`);
    assert.ok(definition!.tools.length > 0, `${name} has actual tools`);
    assert.ok(definition!.input.length > 0 && definition!.output.length > 0);
    assert.ok(definition!.gate.length > 0, `${name} names its gate`);
    assert.match(definition!.providerRoute, /Gemini/);
    assert.match(definition!.providerRoute, /Ollama/);
    assert.doesNotMatch(definition!.providerRoute, /FreeLLMAPI|OpenRouter/i);

    const workflowId = agents.createWorkflow("agent_contract", `${name} contract`, null);
    const taskId = agents.startTask(key, workflowId, `Contract task for ${name}`, "Deterministic contract fixture");
    const started = db.one<{ agent_key: string; status: string; workflow_id: string }>(
      "SELECT agent_key, status, workflow_id FROM tasks WHERE id = ?",
      [taskId],
    );
    assert.equal(started?.agent_key, key);
    assert.equal(started?.status, "running");
    assert.equal(started?.workflow_id, workflowId);

    agents.completeTask(taskId, key, `${name} completed the deterministic contract task.`);
    const completed = db.one<{ status: string; output: string }>(
      "SELECT status, output FROM tasks WHERE id = ?",
      [taskId],
    );
    assert.equal(completed?.status, "completed");
    assert.match(completed?.output ?? "", /completed/);
    assert.equal(
      db.one<{ c: number }>("SELECT COUNT(*) AS c FROM tasks WHERE id = ? AND agent_key = ?", [taskId, key])?.c,
      1,
    );
  });
}

test("the roster follows the required delegated workflow and all handoffs point at registered agents", () => {
  assert.deepEqual(
    definitions.AGENT_DEFINITIONS.map((definition) => definition.key),
    EXPECTED.map(([key]) => key),
  );
  const keys = new Set(EXPECTED.map(([key]) => key));
  for (const definition of definitions.AGENT_DEFINITIONS) {
    for (const upstream of definition.upstream) assert.ok(keys.has(upstream), `${definition.name} upstream ${upstream}`);
    for (const downstream of definition.downstream) assert.ok(keys.has(downstream), `${definition.name} downstream ${downstream}`);
  }
  assert.equal(workflow.workflowOrderLabel(), "Chief → Saffa → Ali → Kora → Amira → Kali → Noor → Rayna");
  assert.deepEqual(workflow.WORKFLOW_STAGES.map((stage) => stage.key), [
    "coordinator",
    "research",
    "analysis",
    "cv",
    "cover",
    "quality",
    "submission",
    "tracking",
  ]);
});

test("no agent can complete or fail another agent's task", () => {
  const workflowId = agents.createWorkflow("ownership", "Task ownership fixture", null);
  const taskId = agents.startTask("cv", workflowId, "Kora-owned task", "Ownership fixture");

  assert.throws(
    () => agents.completeTask(taskId, "cover", "Amira attempted to complete Kora's task."),
    (error: unknown) => {
      assert.ok(error instanceof agents.TaskOwnershipError);
      assert.match(error.message, /Kora|belongs/i);
      return true;
    },
  );
  assert.equal(db.one<{ status: string }>("SELECT status FROM tasks WHERE id = ?", [taskId])?.status, "running");

  agents.completeTask(taskId, "cv", "Kora completed her own task.");
  assert.throws(
    () => agents.completeTask(taskId, "cv", "Duplicate completion."),
    (error: unknown) => {
      assert.ok(error instanceof agents.TaskOwnershipError);
      assert.match(error.message, /completed|not active/i);
      return true;
    },
  );
  assert.equal(db.one<{ status: string }>("SELECT status FROM tasks WHERE id = ?", [taskId])?.status, "completed");
});

test("capability inspection grants no submission, sending, shell, database or credential bypass", () => {
  for (const [key] of EXPECTED) {
    const rows = capabilities.capabilitiesForAgent(key);
    for (const capability of rows) {
      if (capability.prohibited) assert.equal(capability.granted, false);
      assert.equal(capability.available && capability.granted && capability.prohibited, false);
    }
  }
  assert.equal(
    capabilities.capabilitiesForAgent("application").find((capability) => capability.id === "submit_application")?.granted,
    false,
  );
  assert.equal(
    capabilities.capabilitiesForAgent("coordinator").find((capability) => capability.id === "submit_application")?.granted,
    false,
  );
  assert.equal(
    capabilities.capabilitiesForAgent("email").find((capability) => capability.id === "send_approved_gmail")?.granted,
    false,
  );
});

test("all eight voices remain distinct and supported", () => {
  const profiles = Object.values(voices.AGENT_VOICE_PROFILES);
  assert.equal(profiles.length, 8);
  assert.equal(new Set(profiles.map((profile) => profile.voiceId)).size, 8);
  for (const profile of profiles) {
    assert.equal(profile.provider, "gemini-live");
    assert.equal(profile.available, true);
    assert.ok(voices.isLiveVoiceId(profile.voiceId));
  }
});
