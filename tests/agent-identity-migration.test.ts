import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-agent-identity-migration-"));
process.env.APP_SECRET_KEY = "agent-identity-migration-test-secret";

const db = await import("../lib/db.ts");
const { AGENT_IDENTITIES } = await import("../lib/agent-identity.ts");

test("display names migrate by immutable key without moving historical tasks", () => {
  db.getDb();
  db.run("INSERT INTO tasks (id, agent_key, title, status, created_at) VALUES ('task_before_identity', 'application', 'Historic submission', 'completed', ?)", [
    new Date().toISOString(),
  ]);
  db.run("UPDATE agents SET name = 'Old Display Name', role = 'Old Role' WHERE key = 'application'");

  // Reopening runs the data migration while the schema version is already current.
  db.closeDb();
  db.getDb();

  const agent = db.one<{ name: string; role: string }>("SELECT name, role FROM agents WHERE key = 'application'");
  assert.equal(agent?.name, AGENT_IDENTITIES.application.name);
  assert.equal(agent?.role, AGENT_IDENTITIES.application.role);
  const task = db.one<{ agent_key: string; title: string }>("SELECT agent_key, title FROM tasks WHERE id = 'task_before_identity'");
  assert.equal(task?.agent_key, "application");
  assert.equal(task?.title, "Historic submission");
  const invalid = db.all("SELECT DISTINCT t.agent_key FROM tasks t LEFT JOIN agents a ON a.key = t.agent_key WHERE a.key IS NULL");
  assert.deepEqual(invalid, []);
});
