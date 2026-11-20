#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Restore a backup into an explicit target directory. This never writes to the
 * live DATA_DIR: a live restore is a deliberate operator action (stop service,
 * move the current data aside, then point the service at the restored copy).
 *
 * Usage:
 *   node scripts/restore.mjs --backup data/backups/atw-backup-... --target /tmp/atw-restore
 */

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const backupDir = arg("--backup") ? path.resolve(arg("--backup")) : null;
const target = arg("--target") ? path.resolve(arg("--target")) : null;
const force = process.argv.includes("--force");
if (!backupDir || !target) {
  console.error("Usage: node scripts/restore.mjs --backup <backup-dir> --target <empty-directory> [--force]");
  process.exit(2);
}

const liveData = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
if (target === liveData || target === path.join(liveData, "at-ai-workforce.db") || target.startsWith(`${liveData}${path.sep}`)) {
  console.error(`Refusing to restore into the live data directory: ${liveData}`);
  process.exit(2);
}
if (!fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) {
  console.error(`Backup directory not found: ${backupDir}`);
  process.exit(2);
}
if (fs.existsSync(target)) {
  if (!force) {
    console.error(`Target already exists: ${target}. Use --force only for a disposable restore test.`);
    process.exit(2);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(target, { recursive: true, mode: 0o700 });

const manifestPath = path.join(backupDir, "manifest.json");
const sumsPath = path.join(backupDir, "SHA256SUMS");
const sourceDb = path.join(backupDir, "at-ai-workforce.db");
if (!fs.existsSync(manifestPath) || !fs.existsSync(sumsPath) || !fs.existsSync(sourceDb)) {
  console.error("Backup is incomplete: manifest.json, SHA256SUMS or at-ai-workforce.db is missing.");
  process.exit(2);
}

for (const line of fs.readFileSync(sumsPath, "utf8").split(/\r?\n/).filter(Boolean)) {
  const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
  if (!match) throw new Error("Malformed SHA256SUMS entry.");
  const [, expected, name] = match;
  const file = path.join(backupDir, name);
  if (!fs.existsSync(file)) throw new Error(`Backup file missing: ${name}`);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch: ${name}`);
}

const targetDb = path.join(target, "at-ai-workforce.db");
fs.copyFileSync(sourceDb, targetDb);
fs.chmodSync(targetDb, 0o600);
const uploadsArchive = path.join(backupDir, "uploads.tar.gz");
if (fs.existsSync(uploadsArchive)) {
  execFileSync("tar", ["-xzf", uploadsArchive, "-C", target], { stdio: "pipe" });
  fs.chmodSync(path.join(target, "uploads"), 0o700);
}

const verify = new DatabaseSync(targetDb, { readOnly: true });
let integrity;
let schema;
let counts;
try {
  integrity = verify.prepare("PRAGMA integrity_check").get()?.integrity_check;
  schema = verify.prepare("PRAGMA user_version").get()?.user_version;
  counts = verify.prepare(`SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM agents) AS agents,
    (SELECT COUNT(*) FROM jobs) AS jobs,
    (SELECT COUNT(*) FROM applications) AS applications,
    (SELECT COUNT(*) FROM documents) AS documents,
    (SELECT COUNT(*) FROM tasks) AS tasks`).get();
} finally {
  verify.close();
}
if (integrity !== "ok") throw new Error(`Restored database integrity check failed: ${integrity}`);

console.log(JSON.stringify({ restoredTo: target, source: backupDir, schema, integrity, counts }, null, 2));
