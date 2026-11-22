import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const manifestPath = path.join(root, "artifacts/reset/manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const execute = process.argv.includes("--execute");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const statePath = path.join(root, "artifacts/reset/execution-state.json");
const completionPath = path.join(root, "artifacts/reset/completion.json");
const dbPath = path.join(root, "data/at-ai-workforce.db");
const dataPath = path.join(root, "data");
const quarantinePath = path.join(dataPath, `.reset-quarantine-${stamp}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function shaFile(file) {
  return sha(fs.readFileSync(file));
}

function count(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function state(value) {
  writeJson(statePath, { ...value, manifest: "artifacts/reset/manifest.json" });
}

const expected = {
  jobs: 22,
  applications: 4,
  submission_attempts: 0,
  application_events: 0,
  application_interventions: 0,
  documents_total: 34,
  documents_generated: 32,
  documents_original: 2,
  chat_messages: 722,
  agent_sessions: 8,
  tasks: 124,
  workflows: 31,
  workflow_events: 307,
  recruitment_runs: 14,
  recruitment_run_agents: 110,
  recruitment_recovery: 0,
  provider_usage: 435,
  ai_jobs: 1,
  audit_logs: 280,
  notifications: 56,
  notification_outbox: 17,
  email_messages: 70,
  discovery_source_status: 26,
  temp_objects: 3,
  users: 1,
  sessions: 10,
  profiles: 1,
  skills: 70,
  experiences: 4,
  profile_items: 0,
  settings: 48,
  job_sources: 7,
  gmail_accounts: 1,
  provider_health: 2,
  runtime_workers: 5,
  api_rate_limits: 4,
  schedule_jobs: 2,
  agents: 8,
};

const tables = [
  "jobs",
  "applications",
  "submission_attempts",
  "application_events",
  "application_interventions",
  "chat_messages",
  "agent_sessions",
  "tasks",
  "workflows",
  "workflow_events",
  "recruitment_runs",
  "recruitment_run_agents",
  "recruitment_recovery",
  "provider_usage",
  "ai_jobs",
  "audit_logs",
  "notifications",
  "notification_outbox",
  "email_messages",
  "discovery_source_status",
  "temp_objects",
  "users",
  "sessions",
  "profiles",
  "skills",
  "experiences",
  "profile_items",
  "settings",
  "job_sources",
  "gmail_accounts",
  "provider_health",
  "runtime_workers",
  "api_rate_limits",
  "schedule_jobs",
  "agents",
  "documents",
];

function snapshot(db) {
  const result = { documents_total: count(db, "documents"), documents_generated: 0, documents_original: 0 };
  for (const table of tables) {
    if (table === "documents") continue;
    result[table] = count(db, table);
  }
  result.documents_generated = Number(
    db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind IN ('tailored_cv','cover_letter')").get().n,
  );
  result.documents_original = Number(
    db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind = 'original_cv'").get().n,
  );
  return result;
}

function fingerprint(db) {
  const rows = (sql) => db.prepare(sql).all();
  return {
    agentsConfigSha256: sha(
      JSON.stringify(rows("SELECT key,name,role,description,enabled,config,sort FROM agents ORDER BY key")),
    ),
    profileSha256: sha(JSON.stringify(rows("SELECT * FROM profiles ORDER BY rowid"))),
    settingsSha256: sha(JSON.stringify(rows("SELECT key,value FROM settings ORDER BY key"))),
    jobSourcesSha256: sha(JSON.stringify(rows("SELECT * FROM job_sources ORDER BY key"))),
    scheduleConfigSha256: sha(
      JSON.stringify(
        rows("SELECT key,label,time,timezone,enabled,weekdays,next_run_at FROM schedule_jobs ORDER BY key"),
      ),
    ),
    gmailCredentialsSha256: sha(
      JSON.stringify(
        rows(
          "SELECT id,email,scopes,connected_at,length(access_token) AS token_len,length(refresh_token) AS refresh_len FROM gmail_accounts ORDER BY id",
        ),
      ),
    ),
    usersSha256: sha(JSON.stringify(rows("SELECT * FROM users ORDER BY rowid"))),
    sessionsSha256: sha(JSON.stringify(rows("SELECT * FROM sessions ORDER BY rowid"))),
    skillsSha256: sha(JSON.stringify(rows("SELECT * FROM skills ORDER BY rowid"))),
    experiencesSha256: sha(JSON.stringify(rows("SELECT * FROM experiences ORDER BY rowid"))),
  };
}

function fileSpecs() {
  const generated = manifest.files.deleteGeneratedUploads;
  const rowOnly = manifest.files.deleteGeneratedRowOnlyPaths;
  const preview = manifest.files.deletePreview;
  const logs = manifest.files.deleteLogs;
  assert(generated.length === 30, `expected 30 generated uploads, got ${generated.length}`);
  assert(rowOnly.length === 2, `expected 2 already-absent paths, got ${rowOnly.length}`);
  assert(preview.length === 20, `expected 20 preview files, got ${preview.length}`);
  assert(logs.length === 5, `expected 5 logs, got ${logs.length}`);
  const all = [...generated, ...preview, ...logs];
  assert(new Set(all).size === all.length, "approved delete file lists contain duplicates");
  assert(all.length === 55, `expected 55 files to delete, got ${all.length}`);
  for (const rel of all) {
    assert(
      rel.startsWith("data/uploads/") || rel.startsWith("data/preview/") || rel.startsWith("data/phase1-runtime-") || rel === "data/server.log",
      `unapproved file location: ${rel}`,
    );
    const abs = path.resolve(root, rel);
    assert(abs.startsWith(`${dataPath}${path.sep}`), `file escapes data directory: ${rel}`);
    assert(fs.existsSync(abs), `approved file is missing: ${rel}`);
    const stat = fs.lstatSync(abs);
    assert(stat.isFile() && !stat.isSymbolicLink(), `approved path is not a regular file: ${rel}`);
  }
  for (const rel of rowOnly) {
    const abs = path.resolve(root, rel);
    assert(!fs.existsSync(abs), `expected already-absent file now exists: ${rel}`);
  }
  return { generated, rowOnly, preview, logs, all };
}

function verifyOriginalFiles() {
  const entries = [
    ...manifest.files.preserveOriginalUploads.map((file) => {
      const recorded = manifest.preservationFingerprints.originalCvFilesSha256.find((item) => item.path === file);
      assert(recorded, `missing recorded fingerprint for ${file}`);
      return { file, expected: recorded };
    }),
    ...manifest.files.preserveAvatars.map((file) => {
      const recorded = manifest.preservationFingerprints.avatarFiles.find((item) => item.path === file);
      assert(recorded, `missing recorded fingerprint for ${file}`);
      return { file, expected: recorded };
    }),
  ];
  for (const { file, expected: recorded } of entries) {
    const abs = path.resolve(root, file);
    assert(fs.existsSync(abs), `preserved file is missing: ${file}`);
    const actual = shaFile(abs);
    const bytes = fs.statSync(abs).size;
    assert(actual === recorded.sha256, `preserved file hash changed: ${file}`);
    assert(bytes === recorded.bytes, `preserved file size changed: ${file}`);
  }
  return entries.map(({ file, expected: recorded }) => ({ path: file, sha256: recorded.sha256, bytes: recorded.bytes }));
}

function auditRetained() {
  const category = manifest.categories.find((entry) => entry.category === "Historical audit events");
  assert(category, "missing audit manifest category");
  return category.retainedActions;
}

function verifyDocRows(db, generated) {
  const rows = db
    .prepare(
      "SELECT id,kind,relative_path,deleted_at FROM documents WHERE kind IN ('tailored_cv','cover_letter') ORDER BY id",
    )
    .all();
  assert(rows.length === 32, `expected 32 generated document rows, got ${rows.length}`);
  const generatedNames = new Map(generated.map((rel) => [path.basename(rel), rel]));
  const liveRows = rows.filter((row) => !row.deleted_at);
  assert(liveRows.length === 30, `expected 30 live generated document rows, got ${liveRows.length}`);
  for (const row of liveRows) {
    assert(row.relative_path, `generated document row has no file path: ${row.id}`);
    const rel = generatedNames.get(path.basename(row.relative_path));
    assert(rel, `generated document row has an unapproved file: ${row.relative_path}`);
    assert(fs.existsSync(path.resolve(root, rel)), `generated document file missing: ${rel}`);
  }
  for (const row of rows.filter((entry) => entry.deleted_at)) {
    assert(!row.relative_path || !fs.existsSync(path.resolve(root, "data", row.relative_path.replace(/^\/+/, ""))),
      `soft-deleted generated document unexpectedly has a file: ${row.relative_path}`);
  }
}

function preflight() {
  assert(manifest.purgeExecuted === false, "approved manifest is already marked executed");
  if (fs.existsSync(statePath)) {
    const previous = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert(previous.status !== "completed", "this reset already completed");
    assert(previous.status !== "executing", "a previous execution is marked as still running; inspect before retrying");
  }
  assert(fs.existsSync(dbPath), "live database is missing");
  const backupPath = manifest.backup.path;
  assert(fs.existsSync(backupPath), "verified backup is missing");
  assert(path.resolve(backupPath) !== path.resolve(dataPath), "backup path is inside active data");
  assert(!path.resolve(backupPath).startsWith(`${path.resolve(dataPath)}${path.sep}`), "backup is inside active data");
  assert(fs.existsSync(path.join(backupPath, "SHA256SUMS")), "backup checksum manifest is missing");
  const checksumOutput = execFileSync("shasum", ["-a", "256", "-c", "SHA256SUMS"], {
    cwd: backupPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert(!/FAILED/i.test(checksumOutput), "backup checksum verification failed");

  const processes = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
  assert(
    !processes.split("\n").some((line) => line.includes(root) && /next dev|next-server/.test(line)),
    "the application server is still running",
  );

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const backupDb = new DatabaseSync(path.join(backupPath, "at-ai-workforce.db"), { readOnly: true });
  try {
    const before = snapshot(db);
    for (const [key, value] of Object.entries(expected)) {
      assert(before[key] === value, `precondition ${key}: expected ${value}, got ${before[key]}`);
    }
    assert(db.prepare("PRAGMA integrity_check").get().integrity_check === "ok", "live database integrity is not ok");
    assert(db.prepare("PRAGMA foreign_key_check").all().length === 0, "live database has foreign-key violations");
    assert(backupDb.prepare("PRAGMA integrity_check").get().integrity_check === "ok", "backup integrity is not ok");
    const liveFingerprint = fingerprint(db);
    const backupFingerprint = fingerprint(backupDb);
    for (const key of Object.keys(liveFingerprint)) {
      assert(liveFingerprint[key] === backupFingerprint[key], `live/backup preservation mismatch: ${key}`);
    }
    const actionCounts = Object.fromEntries(
      db.prepare("SELECT action,COUNT(*) AS n FROM audit_logs GROUP BY action").all().map((row) => [row.action, Number(row.n)]),
    );
    const retained = auditRetained();
    let retainedTotal = 0;
    for (const row of retained) {
      assert(actionCounts[row.action] === row.n, `audit split changed for ${row.action}`);
      retainedTotal += row.n;
    }
    assert(retainedTotal === 52, `expected 52 retained audit events, got ${retainedTotal}`);
    const operational = before.audit_logs - retainedTotal;
    assert(operational === 228, `expected 228 operational audit events, got ${operational}`);
    const files = fileSpecs();
    verifyDocRows(db, files.generated);
    verifyOriginalFiles();
    return { before, liveFingerprint, files, retained, retainedTotal, checksumOutput };
  } finally {
    db.close();
    backupDb.close();
  }
}

function stageFiles(files) {
  fs.mkdirSync(quarantinePath, { recursive: true });
  const staged = [];
  for (const rel of files.all) {
    const source = path.resolve(root, rel);
    const destination = path.join(quarantinePath, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const bytes = fs.statSync(source).size;
    const hash = shaFile(source);
    fs.renameSync(source, destination);
    staged.push({ rel, source, destination, bytes, hash });
  }
  return staged;
}

function restoreStaged(staged) {
  for (const item of [...staged].reverse()) {
    if (fs.existsSync(item.destination)) {
      fs.mkdirSync(path.dirname(item.source), { recursive: true });
      fs.renameSync(item.destination, item.source);
    }
  }
  fs.rmSync(quarantinePath, { recursive: true, force: true });
}

function run() {
  const checked = preflight();
  console.log("PREFLIGHT PASS", JSON.stringify({
    counts: checked.before,
    auditRetained: checked.retainedTotal,
    auditOperational: 228,
    filesToDelete: checked.files.all.length,
    backupChecksums: "ok",
  }));
  if (!execute) {
    console.log("DRY RUN ONLY — pass --execute to apply the approved manifest.");
    return;
  }

  state({ status: "executing", startedAt: new Date().toISOString(), backup: manifest.backup.path });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("PRAGMA foreign_keys = ON");
  let staged = [];
  let dbOpen = true;
  let inTransaction = false;
  let committed = false;
  const deletedRows = {};
  try {
    staged = stageFiles(checked.files);
    console.log(`STAGED ${staged.length} approved files for reversible removal`);

    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const del = (table, where = "", params = []) => {
      const sql = `DELETE FROM ${table}${where ? ` WHERE ${where}` : ""}`;
      const changes = Number(db.prepare(sql).run(...params).changes);
      deletedRows[table] = (deletedRows[table] ?? 0) + changes;
      return changes;
    };
    const eq = (actual, expectedValue, label) =>
      assert(actual === expectedValue, `${label}: expected ${expectedValue} changes, got ${actual}`);

    eq(del("application_interventions"), 0, "application_interventions");
    eq(del("submission_attempts"), 0, "submission_attempts");
    eq(del("application_events"), 0, "application_events");
    eq(del("tasks"), 124, "tasks");
    eq(del("workflow_events"), 307, "workflow_events");
    eq(del("workflows"), 31, "workflows");
    eq(del("recruitment_run_agents"), 110, "recruitment_run_agents");
    eq(del("recruitment_recovery"), 0, "recruitment_recovery");
    eq(del("recruitment_runs"), 14, "recruitment_runs");
    eq(del("documents", "kind IN ('tailored_cv','cover_letter')"), 32, "documents");
    eq(del("applications"), 4, "applications");
    eq(del("jobs"), 22, "jobs");
    eq(del("chat_messages"), 722, "chat_messages");
    eq(del("agent_sessions"), 8, "agent_sessions");
    eq(del("provider_usage"), 435, "provider_usage");
    eq(del("ai_jobs"), 1, "ai_jobs");
    const retainedActions = checked.retained.map((entry) => entry.action);
    const placeholders = retainedActions.map(() => "?").join(",");
    eq(del("audit_logs", `action NOT IN (${placeholders})`, retainedActions), 228, "audit_logs");
    eq(del("notifications"), 56, "notifications");
    eq(del("notification_outbox"), 17, "notification_outbox");
    eq(del("email_messages"), 70, "email_messages");
    eq(del("discovery_source_status"), 26, "discovery_source_status");
    eq(del("temp_objects"), 3, "temp_objects");

    const agentChanges = Number(
      db
        .prepare(
          "UPDATE agents SET status='idle', current_task=NULL, last_run_at=NULL, run_count=0, success_count=0, failure_count=0, ai_success_count=0, ai_failure_count=0",
        )
        .run().changes,
    );
    eq(agentChanges, 8, "agents reset");
    const scheduleChanges = Number(
      db
        .prepare(
          "UPDATE schedule_jobs SET last_run_at=NULL, last_run_id=NULL, last_status=NULL, last_error=NULL, last_scheduled_for=NULL, last_checked_at=NULL",
        )
        .run().changes,
    );
    eq(scheduleChanges, 2, "schedule_jobs reset");
    deletedRows.agents_reset = agentChanges;
    deletedRows.schedule_jobs_reset = scheduleChanges;

    const after = snapshot(db);
    const operationalTables = [
      "jobs",
      "applications",
      "submission_attempts",
      "application_events",
      "application_interventions",
      "chat_messages",
      "agent_sessions",
      "tasks",
      "workflows",
      "workflow_events",
      "recruitment_runs",
      "recruitment_run_agents",
      "recruitment_recovery",
      "provider_usage",
      "ai_jobs",
      "notifications",
      "notification_outbox",
      "email_messages",
      "discovery_source_status",
      "temp_objects",
    ];
    for (const table of operationalTables) assert(after[table] === 0, `${table} still has ${after[table]} rows`);
    assert(after.documents_generated === 0, "generated documents remain");
    assert(after.documents_original === 2, `expected 2 original CV rows, got ${after.documents_original}`);
    assert(after.documents_total === 2, `expected 2 total documents, got ${after.documents_total}`);
    assert(after.audit_logs === 52, `expected 52 audit rows, got ${after.audit_logs}`);
    for (const key of [
      "users",
      "sessions",
      "profiles",
      "skills",
      "experiences",
      "profile_items",
      "settings",
      "job_sources",
      "gmail_accounts",
      "provider_health",
      "runtime_workers",
      "api_rate_limits",
      "schedule_jobs",
      "agents",
    ]) {
      assert(after[key] === expected[key], `preserved ${key} changed: expected ${expected[key]}, got ${after[key]}`);
    }
    const actionCounts = Object.fromEntries(
      db.prepare("SELECT action,COUNT(*) AS n FROM audit_logs GROUP BY action").all().map((row) => [row.action, Number(row.n)]),
    );
    for (const entry of checked.retained) {
      assert(actionCounts[entry.action] === entry.n, `retained audit count changed: ${entry.action}`);
    }
    const afterFingerprint = fingerprint(db);
    for (const key of Object.keys(checked.liveFingerprint)) {
      assert(afterFingerprint[key] === checked.liveFingerprint[key], `preservation fingerprint changed: ${key}`);
    }
    assert(
      Number(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE status!='idle' OR current_task IS NOT NULL OR last_run_at IS NOT NULL OR run_count!=0 OR success_count!=0 OR failure_count!=0 OR ai_success_count!=0 OR ai_failure_count!=0").get().n) === 0,
      "agent activity counters were not fully reset",
    );
    assert(
      Number(db.prepare("SELECT COUNT(*) AS n FROM schedule_jobs WHERE last_run_at IS NOT NULL OR last_run_id IS NOT NULL OR last_status IS NOT NULL OR last_error IS NOT NULL OR last_scheduled_for IS NOT NULL OR last_checked_at IS NOT NULL").get().n) === 0,
      "schedule last-run fields were not fully reset",
    );
    verifyOriginalFiles();

    db.exec("COMMIT");
    inTransaction = false;
    committed = true;

    fs.rmSync(quarantinePath, { recursive: true, force: true });
    for (const item of staged) assert(!fs.existsSync(item.source), `approved file still exists: ${item.rel}`);
    for (const rel of checked.files.rowOnly) assert(!fs.existsSync(path.resolve(root, rel)), `already-absent file appeared: ${rel}`);
    let checkpoint;
    try {
      checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } catch (error) {
      checkpoint = { warning: error instanceof Error ? error.message : String(error) };
    }
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    const finalCounts = snapshot(db);
    const finalFingerprint = fingerprint(db);
    assert(integrity === "ok", `post-reset integrity is ${integrity}`);
    assert(foreignKeyViolations === 0, "post-reset foreign-key violations exist");
    for (const key of Object.keys(checked.liveFingerprint)) {
      assert(finalFingerprint[key] === checked.liveFingerprint[key], `post-reset fingerprint changed: ${key}`);
    }
    const preservedFiles = verifyOriginalFiles();
    const completion = {
      status: "RESET COMPLETED — PASS",
      executedAt: new Date().toISOString(),
      approvedManifest: "artifacts/reset/manifest.json",
      backup: manifest.backup.path,
      deletedRows,
      filesDeleted: {
        count: staged.length,
        bytes: staged.reduce((sum, item) => sum + item.bytes, 0),
        paths: staged.map((item) => item.rel),
      },
      alreadyAbsentGeneratedFiles: checked.files.rowOnly,
      preservedCounts: finalCounts,
      preservationFingerprints: {
        before: checked.liveFingerprint,
        after: finalFingerprint,
        match: true,
      },
      retainedAuditEvents: Object.fromEntries(checked.retained.map((entry) => [entry.action, entry.n])),
      preservedFiles,
      database: {
        integrity,
        foreignKeyViolations,
        checkpoint,
        schemaVersion: db.prepare("PRAGMA user_version").get().user_version,
        path: "data/at-ai-workforce.db",
      },
      schedulePreserved: db.prepare("SELECT key,time,timezone,enabled,weekdays,next_run_at FROM schedule_jobs ORDER BY key").all(),
      noSecretValuesIncluded: true,
    };
    writeJson(completionPath, completion);
    state({ status: "completed", completedAt: completion.executedAt, completion: "artifacts/reset/completion.json" });
    console.log("RESET COMPLETED — PASS", JSON.stringify({
      deleted: deletedRows,
      filesDeleted: staged.length,
      bytesDeleted: completion.filesDeleted.bytes,
      preserved: finalCounts,
      integrity,
      foreignKeyViolations,
      completion: "artifacts/reset/completion.json",
    }));
  } catch (error) {
    if (inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original error below.
      }
      inTransaction = false;
    }
    if (!committed) restoreStaged(staged);
    state({
      status: "failed",
      failedAt: new Date().toISOString(),
      databaseCommitted: committed,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (dbOpen) db.close();
  }
}

run();
