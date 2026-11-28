#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Post-push verifier: fetch a remote branch and prove what is published.
 *
 * Run this AFTER `git push --force-with-lease`, never between the local rewrite
 * and the push: fetching the un-rewritten remote re-imports the objects the
 * purge removed.
 *
 * It checks three things about the fetched history, all of them about the
 * remote rather than the local clone:
 *   1. the remote tip is the commit that was pushed (the rewrite landed);
 *   2. no credential-shaped value is reachable from it, using the same hardened
 *      patterns the purge used;
 *   3. no purged path, database dump or environment file is reachable from it.
 *
 * Findings never print the matched value: path, commit, pattern, length, the
 * first four characters and a truncated SHA-256 only.
 *
 * Exit codes: 0 clean, 1 findings or mismatch, 2 usage/environment error.
 */

const USAGE = `Usage: node scripts/verify-remote-history.mjs [options]

Fetches a remote branch and proves the published history is clean.

Options:
  --remote <name>   Remote to verify (default: origin)
  --branch <name>   Branch to verify (default: main)
  --expect <sha>    Commit the remote tip must be (default: local HEAD)
  -h, --help        Show this help

Run after the force-push. Requires read access to the remote.`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.join(HERE, "secret-scan.mjs");

const BANNED_PATHS = [
  { re: /^(?:\.tmp|\.checkpoints)\//, why: "purged working directory" },
  { re: /^artifacts\/backups\//, why: "database backup directory" },
  { re: /\.db(?:-wal|-shm|-journal)?$/, why: "SQLite database dump" },
  { re: /(?:^|\/)\.env(?:\.local|\.development|\.production|\.test)?$/, why: "environment file" },
];

function fail(message, code = 2) {
  console.error(`verify-remote-history: ${message}`);
  if (code === 2) console.error(USAGE);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { remote: "origin", branch: "main", expect: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--remote" || arg === "--branch" || arg === "--expect") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    fail(`unknown option: ${arg}`);
  }
  return options;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function firstLine(value) {
  return String(value ?? "").split("\n").find((line) => line.trim()) ?? "";
}

function short(sha) {
  return String(sha || "").slice(0, 8) || "(none)";
}

const options = parseArgs(process.argv.slice(2));

let root;
try {
  root = git(["rev-parse", "--show-toplevel"]).trim();
} catch {
  fail("not inside a Git repository");
}

const branchRef = `refs/heads/${options.branch}`;
// A namespace of its own: verification must never move the origin/* refs the
// operator is about to rely on.
const verifyRef = `refs/atw-verify/${options.branch.replace(/[^A-Za-z0-9._-]/g, "-")}`;

const failures = [];
const pass = (message) => console.log(`  PASS  ${message}`);
const failCheck = (message) => {
  console.log(`  FAIL  ${message}`);
  failures.push(message);
};

console.log(`Verifying ${options.remote}/${options.branch} in ${root}`);

let published = "";
try {
  const output = git(["ls-remote", "--heads", options.remote, branchRef], root);
  published = output.split("\n").map((line) => line.split(/\s+/)[0]).filter(Boolean)[0] ?? "";
} catch (error) {
  fail(`could not read ${options.remote}: ${firstLine(error.stderr || error.message)}`);
}
if (!published) fail(`${options.remote}/${options.branch} does not exist`);

let remoteTip = "";
try {
  // Fetch into the verification ref only; --no-tags keeps unrelated history out.
  git(["fetch", "--no-tags", "--force", "--quiet", options.remote, `+${branchRef}:${verifyRef}`], root);
  remoteTip = git(["rev-parse", "--verify", `${verifyRef}^{commit}`], root).trim();
} catch (error) {
  try {
    git(["update-ref", "-d", verifyRef], root);
  } catch {
    // Nothing to clean up.
  }
  fail(`could not fetch ${options.remote}/${options.branch}: ${firstLine(error.stderr || error.message)}`);
}

if (published !== remoteTip) {
  failCheck(`remote moved during verification: ls-remote ${short(published)}, fetched ${short(remoteTip)}`);
}

const expected = options.expect ?? git(["rev-parse", "HEAD"], root).trim();
const comparedTo = options.expect ? "the expected commit" : "local HEAD";
if (remoteTip === expected) {
  pass(`remote tip ${short(remoteTip)} matches ${comparedTo} ${short(expected)}`);
} else {
  failCheck(`remote tip ${short(remoteTip)} is not ${comparedTo} ${short(expected)} — the rewrite is not published`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "atw-remote-verify-"));
let commitCount = 0;
try {
  // A throwaway, bare repository holding only the fetched branch, so the
  // history scanner sees exactly what the remote publishes and nothing from the
  // local clone (whose reflogs, tags and other branches are irrelevant here).
  // Bare matters: with a worktree, `main` is checked out and Git refuses to
  // fetch into it.
  git(["init", "--quiet", "--bare"], scratch);
  git(["fetch", "--no-tags", "--quiet", root, `+${verifyRef}:${branchRef}`], scratch);
  commitCount = Number(git(["rev-list", "--count", branchRef], scratch).trim());

  let scanOutput = "";
  let scanStatus = 0;
  try {
    scanOutput = execFileSync(process.execPath, [SCANNER, "--history"], {
      cwd: scratch,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    scanStatus = typeof error.status === "number" ? error.status : 1;
    scanOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  if (scanStatus === 0) {
    pass(`no credential-shaped value in ${commitCount} commit${commitCount === 1 ? "" : "s"} reachable from the remote`);
  } else {
    failCheck("a credential-shaped value is still reachable from the remote history");
    for (const line of scanOutput.split("\n").filter((entry) => entry.trim().startsWith("  ")).slice(0, 20)) {
      console.log(`        ${line.trim()}`);
    }
  }

  const changedPaths = git(["log", "--all", "--format=", "--name-only", branchRef], scratch)
    .split("\n")
    .filter(Boolean);
  const banned = new Map();
  for (const file of changedPaths) {
    for (const rule of BANNED_PATHS) {
      if (rule.re.test(file)) {
        banned.set(file, rule.why);
        break;
      }
    }
  }
  if (banned.size === 0) {
    pass("no purged path, database dump or environment file in the remote history");
  } else {
    failCheck(`${banned.size} forbidden path(s) reachable from the remote history`);
    for (const [file, why] of [...banned].slice(0, 20)) console.log(`        ${file} — ${why}`);
  }
} catch (error) {
  failCheck(`could not inspect the fetched history: ${firstLine(error.stderr || error.message)}`);
} finally {
  // The scratch repository holds the remote's blobs, secrets included when the
  // check fails, so it is always removed.
  fs.rmSync(scratch, { recursive: true, force: true });
  try {
    git(["update-ref", "-d", verifyRef], root);
  } catch {
    // The ref may never have been created.
  }
}

if (failures.length > 0) {
  console.error(`\nRemote history NOT verified: ${failures.length} problem(s). No value is printed above.`);
  console.error("If the rewrite has not been published, the remote still holds the old history.");
  console.error("This fetch re-imported its objects locally; prune them before retrying the push:");
  console.error(
    `  git update-ref refs/remotes/${options.remote}/${options.branch} refs/heads/${options.branch} && git gc --prune=now`,
  );
  process.exit(1);
}

console.log(
  `\nRemote history verified clean: ${options.remote}/${options.branch} at ${short(remoteTip)} (${commitCount} commit${commitCount === 1 ? "" : "s"}).`,
);
