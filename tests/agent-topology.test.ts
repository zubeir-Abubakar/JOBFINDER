import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-agent-topology-"));
process.env.APP_SECRET_KEY = "agent-topology-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";

const db = await import("../lib/db.ts");
const topology = await import("../lib/agent-topology.ts");
const events = await import("../lib/events.ts");
const { AGENT_IDENTITY_KEYS, AGENT_IDENTITIES } = await import("../lib/agent-identity.ts");

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

const WORKFLOW = "wf_topology_fixture";
const RUN = "run_topology_fixture";
const ACTOR = { id: "u_topology_admin", role: "admin" };
const AT = "2026-11-22T12:00:00.000Z";

db.run(
  "INSERT INTO workflows (id, kind, label, status, started_by, created_at) VALUES (?, 'autonomous_recruitment', 'Daily autonomous recruitment fixture', 'running', NULL, ?)",
  [WORKFLOW, AT],
);
db.run(
  `INSERT INTO recruitment_runs (id, run_key, workflow_id, scheduled_for, trigger, status, started_at, jobs_discovered, jobs_updated, discovery_scope, created_at)
   VALUES (?, '2026-11-22#full-1000', ?, ?, 'schedule', 'searching', ?, 14, 3, 'full', ?)`,
  [RUN, WORKFLOW, AT, AT, AT],
);

const tasks = [
  ["task_topology_coordinator", "coordinator", "Create the daily recruitment run", "completed", "Assigned discovery and analysis.", AT, "2026-11-22T12:00:02.000Z"],
  ["task_topology_research", "research", "Monitor configured recruitment sources", "running", "Reading every enabled source and reconciling new vacancies.", "2026-11-22T12:00:03.000Z", null],
  ["task_topology_analysis", "analysis", "Score the new vacancies", "queued", "Waiting for Saffa's discovery result.", "2026-11-22T12:00:03.500Z", null],
  ["task_topology_cv", "cv", "Tailor CV for the strongest vacancy", "completed", "CV generated from verified profile facts.", "2026-11-22T11:59:00.000Z", "2026-11-22T12:00:04.000Z"],
  ["task_topology_ats", "ats", "Audit generated documents", "failed", "Quality audit could not verify the employer field.", "2026-11-22T11:58:00.000Z", "2026-11-22T12:00:05.000Z"],
] as const;

for (const [id, key, title, status, detail, startedAt, finishedAt] of tasks) {
  db.run(
    `INSERT INTO tasks (id, workflow_id, agent_key, title, status, detail, output, error, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      WORKFLOW,
      key,
      title,
      status,
      detail,
      status === "completed" ? `${title} completed from persisted evidence.` : null,
      status === "failed" ? "Quality audit could not verify the employer field." : null,
      startedAt,
      startedAt,
      finishedAt,
    ],
  );
}

const assignments = [
  ["coordinator", "Create and supervise the run", "completed"],
  ["research", "Discover vacancies across configured sources", "running"],
  ["analysis", "Score and rank discovered vacancies", "queued"],
  ["cv", "Prepare tailored CV", "completed"],
  ["ats", "Audit documents", "failed"],
  ["cover", "Prepare cover letter", "skipped"],
  ["application", "Prepare submission package", "queued"],
] as const;
for (const [key, assignment, status] of assignments) {
  db.run(
    `INSERT INTO recruitment_run_agents (run_id, agent_key, assignment, status, output, error, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      RUN,
      key,
      assignment,
      status,
      status === "completed" ? "Recorded from the persisted assignment." : null,
      status === "failed" ? "Document audit failed." : null,
      AT,
      status === "completed" || status === "failed" ? AT : null,
      AT,
    ],
  );
}

db.run("UPDATE agents SET status = 'working', current_task = 'Create the daily recruitment run' WHERE key = 'coordinator'");
db.run("UPDATE agents SET status = 'working', current_task = 'Monitor configured recruitment sources' WHERE key = 'research'");
db.run("UPDATE agents SET status = 'completed', current_task = NULL WHERE key = 'cv'");
db.run("UPDATE agents SET status = 'failed', current_task = NULL WHERE key = 'ats'");
db.run("UPDATE agents SET enabled = 0, status = 'disabled', current_task = NULL WHERE key = 'email'");

events.emitWorkflowEvent({
  workflowId: WORKFLOW,
  type: "workflow.started",
  agentKey: "coordinator",
  message: "Daily autonomous recruitment fixture started. Agents execute sequentially.",
});
events.emitWorkflowEvent({
  workflowId: WORKFLOW,
  type: "agent.started",
  agentKey: "research",
  message: "Saffa started: Monitor configured recruitment sources",
});
events.emitWorkflowEvent({
  workflowId: WORKFLOW,
  type: "agent.queued",
  agentKey: "analysis",
  message: "Ali queued: Score the new vacancies",
});
events.emitWorkflowEvent({
  workflowId: WORKFLOW,
  type: "agent.completed",
  agentKey: "cv",
  message: "Kora completed its step: CV generated from verified profile facts.",
});
events.emitWorkflowEvent({
  workflowId: WORKFLOW,
  type: "agent.failed",
  agentKey: "ats",
  message: "Kali failed: Quality audit could not verify the employer field.",
});

test("the topology uses exactly the eight configured agents and their real portraits", () => {
  const snapshot = topology.getAgentTopologySnapshot(ACTOR, new Date(AT));
  assert.equal(snapshot.agents.length, AGENT_IDENTITY_KEYS.length);
  assert.deepEqual(snapshot.agents.map((agent) => agent.key), [...AGENT_IDENTITY_KEYS]);
  assert.equal(snapshot.coordinator.key, "coordinator");
  assert.equal(snapshot.coordinator.name, AGENT_IDENTITIES.coordinator.name);
  assert.equal(snapshot.specialists.length, 7);
  for (const agent of snapshot.agents) {
    assert.equal(agent.portrait, AGENT_IDENTITIES[agent.key].image);
    assert.ok(agent.portrait.startsWith("/assets/agents/"));
    assert.equal(agent.initials, topology.initialsForName(agent.name));
    assert.ok(agent.voiceName);
  }
  assert.equal(topology.initialsForName("Jean Luc"), "JL");
  assert.equal(topology.initialsForName("Chief"), "C");
});

test("working, waiting, completed, failed, idle and offline states come from persisted records", () => {
  const snapshot = topology.getAgentTopologySnapshot(ACTOR, new Date(AT));
  const byKey = new Map(snapshot.agents.map((agent) => [agent.key, agent]));
  assert.equal(snapshot.run?.workflowId, WORKFLOW);
  assert.equal(snapshot.workflow?.id, WORKFLOW);
  assert.equal(snapshot.workflow?.status, "running");
  assert.equal(byKey.get("coordinator")?.state, "working");
  assert.equal(byKey.get("coordinator")?.stateLabel, "Orchestrating");
  assert.equal(byKey.get("research")?.state, "working");
  assert.equal(byKey.get("analysis")?.state, "waiting");
  assert.equal(byKey.get("cv")?.state, "completed");
  assert.equal(byKey.get("ats")?.state, "failed");
  assert.match(byKey.get("ats")?.activity ?? "", /employer field/i);
  assert.equal(byKey.get("cover")?.state, "idle");
  assert.equal(byKey.get("email")?.state, "offline");
  assert.equal(byKey.get("email")?.enabled, false);
  assert.deepEqual(
    {
      working: snapshot.stats.working,
      waiting: snapshot.stats.waiting,
      completed: snapshot.stats.completed,
      failed: snapshot.stats.failed,
      idle: snapshot.stats.idle,
      offline: snapshot.stats.offline,
    },
    { working: 2, waiting: 2, completed: 1, failed: 1, idle: 1, offline: 1 },
  );
});

test("only a genuine running assignment illuminates an animated connection", () => {
  const snapshot = topology.getAgentTopologySnapshot(ACTOR, new Date(AT));
  const active = snapshot.connections.filter((connection) => connection.active);
  assert.deepEqual(active.map((connection) => connection.agentKey), ["research"]);
  assert.equal(active[0].direction, "chief-to-agent");
  assert.match(active[0].label ?? "", /Monitor configured recruitment sources/);
  const analysis = snapshot.connections.find((connection) => connection.agentKey === "analysis");
  assert.equal(analysis?.active, false, "a queued task is waiting, not active");
  const cv = snapshot.connections.find((connection) => connection.agentKey === "cv");
  assert.equal(cv?.active, false, "a completed task never animates");
  assert.equal(cv?.direction, "agent-to-chief");
  const ats = snapshot.connections.find((connection) => connection.agentKey === "ats");
  assert.equal(ats?.active, false, "a failed task never animates");
  assert.equal(ats?.direction, "agent-to-chief");
});

test("the run panel uses the real run and assignment counts without an invented completion percentage", () => {
  const snapshot = topology.getAgentTopologySnapshot(ACTOR, new Date(AT));
  assert.ok(snapshot.run);
  assert.equal(snapshot.run?.id, RUN);
  assert.equal(snapshot.run?.type, "Full discovery");
  assert.equal(snapshot.run?.scope, "full");
  assert.equal(snapshot.run?.status, "searching");
  assert.equal(snapshot.run?.jobsDiscovered, 14);
  assert.equal(snapshot.run?.jobsUpdated, 3);
  assert.deepEqual(snapshot.run?.counts, {
    total: 7,
    completed: 2,
    running: 1,
    waiting: 2,
    failed: 1,
    skipped: 1,
  });
  const serialized = JSON.stringify(snapshot);
  assert.equal(/"progress"\s*:/.test(serialized), false);
  assert.equal(/"percent(age)?"\s*:/.test(serialized), false);
});

test("the timeline is ordered from persisted workflow events and reconnecting after the last id is empty", () => {
  const snapshot = topology.getAgentTopologySnapshot(ACTOR, new Date(AT));
  assert.equal(snapshot.events.length, 5);
  assert.deepEqual(
    snapshot.events.map((event) => event.message),
    [
      "Daily autonomous recruitment fixture started. Agents execute sequentially.",
      "Saffa started: Monitor configured recruitment sources",
      "Ali queued: Score the new vacancies",
      "Kora completed its step: CV generated from verified profile facts.",
      "Kali failed: Quality audit could not verify the employer field.",
    ],
  );
  const lastId = snapshot.events.at(-1)?.id ?? 0;
  assert.deepEqual(events.listWorkflowEvents(WORKFLOW, lastId), []);
  const replay = events.listWorkflowEvents(WORKFLOW, 0);
  assert.equal(new Set(replay.map((event) => event.id)).size, replay.length, "event replay never duplicates ids");
});

test("a refresh reconstructs the same state and a real status change updates topology and edges", () => {
  const first = topology.getAgentTopologySnapshot(ACTOR, new Date(AT));
  const refreshed = topology.getAgentTopologySnapshot(ACTOR, new Date(AT));
  assert.deepEqual(refreshed.agents.map((agent) => [agent.key, agent.state]), first.agents.map((agent) => [agent.key, agent.state]));
  assert.deepEqual(refreshed.events.map((event) => event.id), first.events.map((event) => event.id));

  db.run(
    "UPDATE tasks SET status = 'completed', finished_at = ? WHERE id = 'task_topology_research'",
    ["2026-11-22T12:00:10.000Z"],
  );
  db.run("UPDATE agents SET status = 'completed', current_task = NULL WHERE key = 'research'");
  db.run("UPDATE tasks SET status = 'running', started_at = ? WHERE id = 'task_topology_analysis'", ["2026-11-22T12:00:10.000Z"]);
  db.run("UPDATE agents SET status = 'working', current_task = 'Score the new vacancies' WHERE key = 'analysis'");
  events.emitWorkflowEvent({
    workflowId: WORKFLOW,
    type: "agent.started",
    agentKey: "analysis",
    message: "Ali started: Score the new vacancies",
  });

  const changed = topology.getAgentTopologySnapshot(ACTOR, new Date(AT));
  const byKey = new Map(changed.agents.map((agent) => [agent.key, agent]));
  assert.equal(byKey.get("research")?.state, "completed");
  assert.equal(byKey.get("analysis")?.state, "working");
  assert.deepEqual(changed.connections.filter((connection) => connection.active).map((connection) => connection.agentKey), ["analysis"]);
  assert.equal(changed.events.at(-1)?.message, "Ali started: Score the new vacancies");
});

test("a blocked task exposes its real dependency reason and heartbeat in the topology", () => {
  db.run(
    `INSERT INTO tasks (id, workflow_id, agent_key, title, status, detail, task_type, state_reason, heartbeat_at, depends_on, retry_count, error_class, recovery_state, created_at, started_at, finished_at)
     VALUES ('task_topology_cover_blocked', ?, 'cover', 'Generate cover letter', 'blocked', 'Cover letter depends on the audited CV.', 'cover_letter_generation', 'Task is blocked because failed prerequisite task(s): task_topology_ats (failed).', ?, '["task_topology_ats"]', 0, 'dependency', 'blocked', ?, NULL, NULL)`,
    [WORKFLOW, "2026-11-22T12:00:06.000Z", "2026-11-22T12:00:06.000Z"],
  );
  const snapshot = topology.getAgentTopologySnapshot(ACTOR, new Date(AT));
  const cover = snapshot.agents.find((agent) => agent.key === "cover");
  assert.equal(cover?.state, "waiting");
  assert.match(cover?.activity ?? "", /failed prerequisite/i);
  assert.equal(cover?.task?.status, "blocked");
  assert.equal(cover?.task?.errorClass, "dependency");
  assert.deepEqual(cover?.task?.dependsOn, ["task_topology_ats"]);
  assert.equal(cover?.task?.heartbeatAt, "2026-11-22T12:00:06.000Z");
  assert.equal(snapshot.connections.find((connection) => connection.agentKey === "cover")?.active, false);
});

test("state derivation is deterministic for disabled, paused and terminal agents", () => {
  assert.equal(topology.deriveTopologyState({ enabled: false, agentStatus: "working", taskStatus: "running" }), "offline");
  assert.equal(topology.deriveTopologyState({ enabled: true, agentStatus: "paused", taskStatus: "running" }), "offline");
  assert.equal(topology.deriveTopologyState({ enabled: true, agentStatus: "thinking", taskStatus: "running" }), "processing");
  assert.equal(topology.deriveTopologyState({ enabled: true, agentStatus: "idle", taskStatus: "queued" }), "waiting");
  assert.equal(topology.deriveTopologyState({ enabled: true, agentStatus: "idle", taskStatus: "completed" }), "completed");
  assert.equal(topology.deriveTopologyState({ enabled: true, agentStatus: "idle", taskStatus: "failed" }), "failed");
  assert.equal(topology.deriveTopologyState({ enabled: true, agentStatus: "idle", taskStatus: null }), "idle");
});
