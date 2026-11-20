import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "atw-api-limit-"));
process.env.DATA_DIR = temp;

const db = await import("../lib/db.ts");
const limit = await import("../lib/api-rate-limit.ts");
db.getDb();
limit.resetApiRateLimits();

test("API limits survive a database reopen and return a retry window", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  for (let i = 0; i < 3; i += 1) {
    const result = limit.consumeApiRateLimit({ key: "198.51.100.7:/api/test", limit: 3, now });
    assert.equal(result.limited, false);
    assert.equal(result.count, i + 1);
    assert.equal(result.durable, true);
  }
  const blocked = limit.consumeApiRateLimit({ key: "198.51.100.7:/api/test", limit: 3, now });
  assert.equal(blocked.limited, true);
  assert.ok(blocked.retryAfter > 0);

  // Reopen the database to prove the counter is not just process memory.
  db.closeDb();
  db.getDb();
  const afterReopen = limit.consumeApiRateLimit({ key: "198.51.100.7:/api/test", limit: 3, now });
  assert.equal(afterReopen.limited, true);
  assert.equal(afterReopen.count, 5);
});

test("API limits are scoped by key and reset after the window", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  assert.equal(limit.consumeApiRateLimit({ key: "ip-a:/api/one", limit: 2, now }).limited, false);
  assert.equal(limit.consumeApiRateLimit({ key: "ip-b:/api/one", limit: 2, now }).limited, false);
  assert.equal(limit.consumeApiRateLimit({ key: "ip-a:/api/two", limit: 2, now }).limited, false);
  assert.equal(limit.consumeApiRateLimit({ key: "ip-a:/api/one", limit: 2, now }).limited, false);
  assert.equal(limit.consumeApiRateLimit({ key: "ip-a:/api/one", limit: 2, now }).limited, true);
  assert.equal(limit.consumeApiRateLimit({ key: "ip-a:/api/one", limit: 2, now: new Date(now.getTime() + 61_000) }).limited, false);
});

test.after(() => rmSync(temp, { recursive: true, force: true }));
