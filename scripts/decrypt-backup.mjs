#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Decrypt an .atwenc backup into a disposable directory for a restore drill. */

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function keyBytes() {
  const file = process.env.BACKUP_ENCRYPTION_KEY_FILE;
  const inline = process.env.BACKUP_ENCRYPTION_KEY;
  let encoded = "";
  if (file) encoded = fs.readFileSync(file, "utf8").trim();
  else if (inline) encoded = inline.trim();
  else throw new Error("Set BACKUP_ENCRYPTION_KEY_FILE (preferred) or BACKUP_ENCRYPTION_KEY.");
  const key = /^[a-f0-9]{64}$/i.test(encoded) ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("The backup encryption key must decode to exactly 32 bytes.");
  return key;
}

const input = arg("--in") ? path.resolve(arg("--in")) : null;
const target = arg("--target") ? path.resolve(arg("--target")) : null;
if (!input || !target) {
  console.error("Usage: node scripts/decrypt-backup.mjs --in <file.atwenc> --target <empty-dir> [--force]");
  process.exit(2);
}
const liveData = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
if (target === liveData || target.startsWith(`${liveData}${path.sep}`)) {
  console.error(`Refusing to decrypt into the live data directory: ${liveData}`);
  process.exit(2);
}
if (fs.existsSync(target)) {
  if (!process.argv.includes("--force")) {
    console.error(`Target already exists: ${target}. Use --force only for a disposable restore drill.`);
    process.exit(2);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(target, { recursive: true, mode: 0o700 });

const stat = fs.statSync(input);
if (stat.size < 7 + 12 + 16) throw new Error("Encrypted backup is too short.");
const fd = fs.openSync(input, "r");
try {
  const header = Buffer.alloc(19);
  fs.readSync(fd, header, 0, 19, 0);
  if (header.subarray(0, 7).toString() !== "ATWENC1") throw new Error("Unrecognised encrypted backup format.");
  const iv = header.subarray(7, 19);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, tag, 0, 16, stat.size - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(), iv);
  decipher.setAuthTag(tag);
  const tmpTar = path.join(os.tmpdir(), `atw-backup-${crypto.randomBytes(8).toString("hex")}.tar.gz`);
  try {
    const output = fs.createWriteStream(tmpTar, { mode: 0o600 });
    for await (const chunk of fs.createReadStream(input, { start: 19, end: stat.size - 17 })) {
      const plain = decipher.update(chunk);
      if (plain.length && !output.write(plain)) await new Promise((resolve) => output.once("drain", resolve));
    }
    output.end(decipher.final());
    await new Promise((resolve, reject) => {
      output.on("finish", resolve);
      output.on("error", reject);
    });
    execFileSync("tar", ["-xzf", tmpTar, "-C", target, "--no-same-owner"], { stdio: "pipe" });
  } finally {
    fs.rmSync(tmpTar, { force: true });
  }
} finally {
  fs.closeSync(fd);
}

const extracted = fs.readdirSync(target);
console.log(JSON.stringify({ decryptedTo: target, entries: extracted }, null, 2));
