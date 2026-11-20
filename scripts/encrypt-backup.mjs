#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Encrypt a verified backup directory for off-host storage.
 *
 * Format: "ATWENC1" + 12-byte IV + AES-256-GCM ciphertext + 16-byte tag.
 * The key is never printed. Prefer BACKUP_ENCRYPTION_KEY_FILE (mode 0600) over
 * an inline environment value. Keep the key somewhere other than the backup
 * destination: losing it makes the backup unrecoverable.
 */

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function keyBytes() {
  const file = process.env.BACKUP_ENCRYPTION_KEY_FILE;
  const inline = process.env.BACKUP_ENCRYPTION_KEY;
  let encoded = "";
  if (file) {
    encoded = fs.readFileSync(file, "utf8").trim();
  } else if (inline) {
    encoded = inline.trim();
  } else {
    throw new Error("Set BACKUP_ENCRYPTION_KEY_FILE (preferred) or BACKUP_ENCRYPTION_KEY to a base64/hex 32-byte key.");
  }
  const key = /^[a-f0-9]{64}$/i.test(encoded) ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("The backup encryption key must decode to exactly 32 bytes.");
  return key;
}

const backupDir = arg("--backup") ? path.resolve(arg("--backup")) : null;
if (!backupDir) {
  console.error("Usage: node scripts/encrypt-backup.mjs --backup <backup-dir> [--out <file>] [--force]");
  process.exit(2);
}
if (!fs.existsSync(path.join(backupDir, "manifest.json")) || !fs.existsSync(path.join(backupDir, "SHA256SUMS"))) {
  console.error("Backup is incomplete: manifest.json or SHA256SUMS is missing.");
  process.exit(2);
}
for (const line of fs.readFileSync(path.join(backupDir, "SHA256SUMS"), "utf8").split(/\r?\n/).filter(Boolean)) {
  const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
  if (!match) throw new Error("Malformed SHA256SUMS entry; refusing to encrypt an unverified backup.");
  const [, expected, name] = match;
  const file = path.join(backupDir, name);
  if (!fs.existsSync(file)) throw new Error(`Backup file missing: ${name}`);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch: ${name}; refusing to encrypt.`);
}

const out = path.resolve(arg("--out") || `${backupDir}.tar.gz.atwenc`);
if (fs.existsSync(out) && !process.argv.includes("--force")) {
  console.error(`Output already exists: ${out}. Use --force to replace it.`);
  process.exit(2);
}
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });

const key = keyBytes();
const tmpTar = path.join(os.tmpdir(), `atw-backup-${crypto.randomBytes(8).toString("hex")}.tar.gz`);
try {
  execFileSync("tar", ["-czf", tmpTar, "-C", path.dirname(backupDir), path.basename(backupDir)], { stdio: "pipe" });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const stream = fs.createWriteStream(out, { mode: 0o600 });
  if (!stream.write(Buffer.concat([Buffer.from("ATWENC1"), iv]))) await once(stream, "drain");
  for await (const chunk of fs.createReadStream(tmpTar)) {
    const encrypted = cipher.update(chunk);
    if (encrypted.length && !stream.write(encrypted)) await once(stream, "drain");
  }
  stream.end(Buffer.concat([cipher.final(), cipher.getAuthTag()]));
  await once(stream, "finish");

  const digest = crypto.createHash("sha256").update(fs.readFileSync(out)).digest("hex");
  fs.writeFileSync(`${out}.sha256`, `${digest}  ${path.basename(out)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ encrypted: out, checksumFile: `${out}.sha256`, bytes: fs.statSync(out).size }, null, 2));
} catch (error) {
  fs.rmSync(out, { force: true });
  fs.rmSync(`${out}.sha256`, { force: true });
  throw error;
} finally {
  fs.rmSync(tmpTar, { force: true });
}
