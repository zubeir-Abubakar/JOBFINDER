#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
const sourceDb = path.join(root, "at-ai-workforce.db");
const backupRoot = path.resolve(process.env.BACKUP_DIR || path.join(root, "backups"));
const retentionDays = Math.min(365, Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS || 30)));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(backupRoot, `atw-backup-${stamp}`);
const dbTarget = path.join(target, "at-ai-workforce.db");
const uploadsTarget = path.join(target, "uploads.tar.gz");

if (!fs.existsSync(sourceDb)) {
  console.error(`Database not found: ${sourceDb}`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true, mode: 0o700 });
try {
  const db = new DatabaseSync(sourceDb);
  try {
    db.exec(`VACUUM INTO '${dbTarget.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  fs.chmodSync(dbTarget, 0o600);

  if (fs.existsSync(path.join(root, "uploads"))) {
    execFileSync("tar", ["-czf", uploadsTarget, "-C", root, "uploads"], { stdio: "pipe" });
    fs.chmodSync(uploadsTarget, 0o600);
  }

  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const envTarget = path.join(target, "env.baseline");
    fs.copyFileSync(envPath, envTarget);
    fs.chmodSync(envTarget, 0o600);
    const keys = fs.readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => `${match[1]}=${match[2].trim() ? "configured" : "empty"}`);
    fs.writeFileSync(path.join(target, "environment-keys.txt"), `${keys.join("\n")}\n`, { mode: 0o600 });
  }

  for (const file of ["package.json", "package-lock.json"]) {
    if (fs.existsSync(path.join(process.cwd(), file))) {
      fs.copyFileSync(path.join(process.cwd(), file), path.join(target, file));
    }
  }

  const verify = new DatabaseSync(dbTarget, { readOnly: true });
  let schema;
  let integrity;
  let counts;
  try {
    schema = verify.prepare("PRAGMA user_version").get()?.user_version;
    integrity = verify.prepare("PRAGMA integrity_check").get()?.integrity_check;
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

  const files = fs.readdirSync(target).filter((file) => fs.statSync(path.join(target, file)).isFile());
  const hashes = files.sort().map((file) => {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(target, file))).digest("hex");
    return `${hash}  ${file}`;
  });
  fs.writeFileSync(path.join(target, "SHA256SUMS"), `${hashes.join("\n")}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(target, "manifest.json"),
    `${JSON.stringify({
      createdAt: new Date().toISOString(),
      source: sourceDb,
      schema,
      integrity,
      counts,
      retentionDays,
      environmentFileCopied: fs.existsSync(path.join(target, "env.baseline")),
      uploadsArchiveCopied: fs.existsSync(uploadsTarget),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  if (integrity !== "ok") throw new Error(`Backup integrity check failed: ${integrity}`);
  console.log(JSON.stringify({ backup: target, schema, integrity, counts, files: files.length }, null, 2));
} catch (error) {
  fs.rmSync(target, { recursive: true, force: true });
  throw error;
}

const cutoff = Date.now() - retentionDays * 86_400_000;
for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("atw-backup-")) continue;
  const full = path.join(backupRoot, entry.name);
  if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
}
