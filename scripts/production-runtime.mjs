#!/usr/bin/env node
/**
 * Local production supervisor for AT AI Workforce.
 *
 * It starts `next start` (not `next dev`), keeps exactly one supervisor alive
 * per data directory, and restarts the server only if the child exits
 * unexpectedly. The server owns the SQLite scheduler and workers; this script
 * does not touch schedule rows or recruitment data.
 *
 * Usage:
 *   npm run start:production              # foreground supervisor
 *   npm run start:production:detached     # detached supervisor, survives the terminal
 *
 * Build first:
 *   npm run build
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const runtimeDir = path.join(root, "data", "runtime");
const lockFile = path.join(runtimeDir, "production.lock");
const pidFile = path.join(runtimeDir, "production.pid");
const logFile = path.join(runtimeDir, "production.log");
const buildId = path.join(root, ".next", "BUILD_ID");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const scriptFile = fileURLToPath(import.meta.url);
const args = new Set(process.argv.slice(2));
const detach = args.has("--detach");
const supervise = args.has("--supervise") || !detach;
const port = Number(process.env.PORT ?? "3000");
const host = process.env.ATW_HOST?.trim() || "0.0.0.0";
const maxRestarts = 5;

function stamp() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[production-runtime ${stamp()}] ${message}`);
}

function ensureRuntimeDir() {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStaleLock() {
  const lock = readLock();
  if (lock && processAlive(Number(lock.pid))) return false;
  try {
    fs.unlinkSync(lockFile);
  } catch {}
  try {
    fs.unlinkSync(pidFile);
  } catch {}
  return true;
}

function acquireLock() {
  ensureRuntimeDir();
  if (fs.existsSync(lockFile)) {
    const lock = readLock();
    if (lock && processAlive(Number(lock.pid))) {
      console.error(
        `[production-runtime] refused duplicate start: supervisor ${lock.pid} is already running (port ${lock.port ?? "unknown"}).`,
      );
      return false;
    }
    removeStaleLock();
  }
  try {
    const fd = fs.openSync(lockFile, "wx", 0o600);
    fs.writeFileSync(
      fd,
      `${JSON.stringify({
        pid: process.pid,
        startedAt: stamp(),
        port,
        host,
        cwd: root,
        nextPid: null,
      }, null, 2)}\n`,
    );
    fs.closeSync(fd);
    fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    console.error(
      `[production-runtime] could not acquire ${lockFile}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return false;
  }
}

function updateLock(nextPid) {
  try {
    const lock = readLock() ?? {};
    fs.writeFileSync(
      lockFile,
      `${JSON.stringify({ ...lock, nextPid, updatedAt: stamp() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {}
}

function cleanupLock() {
  try {
    const lock = readLock();
    if (lock && Number(lock.pid) !== process.pid) return;
    fs.unlinkSync(lockFile);
  } catch {}
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (pid === process.pid) fs.unlinkSync(pidFile);
  } catch {}
}

async function portAvailable() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        console.error(`[production-runtime] port ${port} is already in use. Stop the existing server first.`);
      } else {
        console.error(`[production-runtime] port preflight failed: ${error?.message ?? "unknown error"}`);
      }
      resolve(false);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function checkBuild() {
  if (!fs.existsSync(buildId)) {
    console.error("[production-runtime] .next/BUILD_ID is missing. Run `npm run build` first.");
    return false;
  }
  if (!fs.existsSync(nextBin)) {
    console.error("[production-runtime] Next.js binary is missing. Run `npm install`.");
    return false;
  }
  return true;
}

if (args.has("--help")) {
  console.log(`Usage:
  npm run build
  npm run start:production
  npm run start:production:detached

Environment:
  PORT      Bind port (default 3000)
  ATW_HOST  Bind host (default 0.0.0.0)

The detached form writes to data/runtime/production.log and refuses to start a
second supervisor for the same project.`);
  process.exit(0);
}

if (detach && !args.has("--supervise")) {
  ensureRuntimeDir();
  const existing = readLock();
  if (existing && processAlive(Number(existing.pid))) {
    console.error(
      `[production-runtime] refused duplicate start: supervisor ${existing.pid} is already running.`,
    );
    process.exit(1);
  }
  if (!removeStaleLock()) {
    console.error("[production-runtime] a live supervisor lock exists.");
    process.exit(1);
  }
  if (!checkBuild()) process.exit(1);
  const out = fs.openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, [scriptFile, "--supervise"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  console.log(
    JSON.stringify({
      started: true,
      supervisorPid: child.pid,
      port,
      host,
      log: logFile,
      note: "The detached supervisor owns the server and survives terminal closure.",
    }),
  );
  process.exit(0);
}

if (!supervise) process.exit(1);
if (!checkBuild()) process.exit(1);
if (!(await portAvailable())) process.exit(1);
if (!acquireLock()) process.exit(1);

const logFd = fs.openSync(logFile, "a", 0o600);
let child = null;
let restartTimer = null;
let stopping = false;
let restarts = 0;

function startChild() {
  child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", host], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(port),
    },
    stdio: ["ignore", logFd, logFd],
  });
  updateLock(child.pid ?? null);
  log(`started next start pid=${child.pid ?? "unknown"} on ${host}:${port}`);

  child.on("error", (error) => {
    log(`failed to start next start: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    updateLock(null);
    child = null;
    log(`next start exited code=${code ?? "null"} signal=${signal ?? "none"}`);
    if (stopping) {
      cleanupLock();
      process.exit(0);
    }
    restarts += 1;
    if (restarts > maxRestarts) {
      log(`restart limit reached (${maxRestarts}); supervisor exiting`);
      cleanupLock();
      process.exit(1);
    }
    const delay = Math.min(30_000, 1_000 * 2 ** Math.max(0, restarts - 1));
    log(`restarting in ${delay}ms`);
    restartTimer = setTimeout(startChild, delay);
    restartTimer.unref?.();
  });
}

function requestStop(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${reason})`);
  if (restartTimer) clearTimeout(restartTimer);
  if (child && !child.killed) child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child && !child.killed) child.kill("SIGKILL");
    cleanupLock();
    process.exit(0);
  }, 15_000);
  force.unref?.();
  if (!child) {
    cleanupLock();
    process.exit(0);
  }
}

process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGHUP", () => log("SIGHUP received; supervisor remains alive"));
process.on("exit", cleanupLock);

log(`supervisor pid=${process.pid} cwd=${root}`);
startChild();
