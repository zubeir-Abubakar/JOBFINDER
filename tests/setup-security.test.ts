import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-setup-"));
process.env.APP_SECRET_KEY = "setup-security-test-secret";
process.env.SETUP_TOKEN = "setup-token-that-is-long-enough-123";
process.env.TRUST_PROXY = "true";

const { getDb, one } = await import("../lib/db.ts");
const setup = await import("../lib/setup.ts");
const security = await import("../lib/setup-security.ts");

after(() => {
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

test("setup is open initially and requires the configured token", () => {
  getDb();
  assert.equal(setup.setupClosed(), false);
  const page = security.setupPageState(headers({ host: "jobs.example.com", "x-real-ip": "203.0.113.9" }));
  assert.equal(page.closed, false);
  assert.equal(page.allowed, true, "the token form is reachable remotely");
  assert.equal(page.tokenRequired, true);
  assert.equal(security.setupActionAuthorized(headers({ host: "jobs.example.com" }), "wrong-token"), false);
  assert.equal(
    security.setupActionAuthorized(headers({ host: "jobs.example.com" }), process.env.SETUP_TOKEN!),
    true,
  );
});

test("without a token, only a direct loopback request may initialize", () => {
  const saved = process.env.SETUP_TOKEN;
  delete process.env.SETUP_TOKEN;
  try {
    assert.equal(
      security.setupPageState(headers({ host: "jobs.example.com", "x-real-ip": "203.0.113.9" })).allowed,
      false,
    );
    assert.equal(security.setupPageState(headers({ host: "localhost:3000" })).allowed, true);
    assert.equal(
      security.setupActionAuthorized(headers({ host: "jobs.example.com", "x-real-ip": "203.0.113.9" }), ""),
      false,
    );
  } finally {
    process.env.SETUP_TOKEN = saved;
  }
});

test("initialization is atomic and permanently closes setup", () => {
  const result = setup.initializeAccounts({
    ownerEmail: "owner@example.com",
    ownerName: "Owner",
    ownerPassword: "Owner-Password-123!",
    adminEmail: "admin@example.com",
    adminPassword: "Admin-Password-123!",
  });
  assert.equal(result.ok, true);
  assert.equal(one<{ c: number }>("SELECT COUNT(*) AS c FROM users")?.c, 2);
  assert.equal(setup.setupClosed(), true);
  assert.equal(security.setupActionAuthorized(headers({ host: "localhost:3000" }), process.env.SETUP_TOKEN!), false);
  assert.equal(security.setupPageState(headers({ host: "localhost:3000" })).closed, true);

  const second = setup.initializeAccounts({
    ownerEmail: "second@example.com",
    ownerName: "Second",
    ownerPassword: "Second-Password-123!",
    adminEmail: "second-admin@example.com",
    adminPassword: "Second-Admin-123!",
  });
  assert.equal(second.ok, false);
  assert.equal(one<{ c: number }>("SELECT COUNT(*) AS c FROM users")?.c, 2);
});
