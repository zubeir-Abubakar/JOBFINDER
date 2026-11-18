import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "atw-runtime-"));
process.env.DATA_DIR = dataDir;

const { getDb, one, run, SCHEMA_VERSION, TEMP_DIR, UPLOAD_DIR } = await import("../lib/db.ts");
const { emitWorkflowEvent, listWorkflowEvents, subscribeWorkflowEvents } = await import("../lib/events.ts");
const { cleanupTempObjects, registerTempObject, tempStorageStats } = await import("../lib/temp-store.ts");
const { voiceCapabilities, voiceConfig } = await import("../lib/voice.ts");

test("workflow events and temp-object registry migrate additively", () => {
  const db = getDb();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(tables.includes("workflow_events"));
  assert.ok(tables.includes("temp_objects"));
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  const tablesAfterPhase2 = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  for (const table of ["recruitment_runs", "recruitment_run_agents", "schedule_jobs", "submission_attempts", "application_events"]) {
    assert.ok(tablesAfterPhase2.includes(table), `${table} must exist`);
  }
});

test("workflow events persist in order and reach live subscribers", () => {
  run("INSERT INTO workflows (id, kind, label, status, created_at) VALUES ('wf_events', 'recruitment', 'Event test', 'running', ?)", [new Date().toISOString()]);
  const received: number[] = [];
  const unsubscribe = subscribeWorkflowEvents("wf_events", (event) => received.push(event.id));
  emitWorkflowEvent({ workflowId: "wf_events", type: "agent.started", agentKey: "research", message: "Job Research started." });
  emitWorkflowEvent({ workflowId: "wf_events", type: "agent.completed", agentKey: "research", message: "Job Research found 7 positions." });
  unsubscribe();
  emitWorkflowEvent({ workflowId: "wf_events", type: "agent.started", agentKey: "analysis", message: "Analysis started." });

  assert.equal(received.length, 2, "unsubscribed listener must stop receiving");
  const events = listWorkflowEvents("wf_events");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.type), ["agent.started", "agent.completed", "agent.started"]);
  assert.match(events[1].message ?? "", /7 positions/);
});

test("cleanup removes only expired registered temp objects", async () => {
  mkdirSync(TEMP_DIR, { recursive: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const tempName = "expired-speech.wav";
  const keepName = "original-cv.pdf";
  writeFileSync(join(TEMP_DIR, tempName), "a".repeat(2048));
  writeFileSync(join(UPLOAD_DIR, keepName), "pdf-bytes");
  registerTempObject({ kind: "tts_audio", fileName: tempName, sizeBytes: 2048, ttlHours: -1 });
  run(
    "INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, created_at) VALUES ('doc_keep', 'u1', 'original_cv', 'Original CV', ?, 'application/pdf', ?, 9, ?)",
    [keepName, keepName, new Date().toISOString()],
  );
  const before = tempStorageStats();
  assert.ok(before.activeCount >= 1);

  const result = await cleanupTempObjects("test-suite");
  assert.ok(result.removed >= 1);
  assert.equal(existsSync(join(TEMP_DIR, tempName)), false);
  assert.equal(existsSync(join(UPLOAD_DIR, keepName)), true, "permanent upload must survive temp cleanup");
  assert.ok(one("SELECT id FROM documents WHERE id = 'doc_keep'"), "document record must survive temp cleanup");
});

test("voice adapter refuses an unconfigured or disabled gateway", () => {
  const saved = {
    enabled: process.env.FREELLMAPI_ENABLED,
    base: process.env.FREELLMAPI_BASE_URL,
    key: process.env.FREELLMAPI_API_KEY,
  };
  process.env.FREELLMAPI_ENABLED = "false";
  const disabled = voiceConfig();
  assert.equal(disabled.configured, false);
  assert.ok(disabled.issues.some((issue) => /disabled/i.test(issue)));

  process.env.FREELLMAPI_ENABLED = "true";
  process.env.FREELLMAPI_BASE_URL = "";
  process.env.FREELLMAPI_API_KEY = "";
  assert.equal(voiceConfig().configured, false);
  assert.equal(voiceCapabilities().configured, false);

  process.env.FREELLMAPI_ENABLED = saved.enabled;
  if (saved.base === undefined) delete process.env.FREELLMAPI_BASE_URL;
  else process.env.FREELLMAPI_BASE_URL = saved.base;
  if (saved.key === undefined) delete process.env.FREELLMAPI_API_KEY;
  else process.env.FREELLMAPI_API_KEY = saved.key;
});
