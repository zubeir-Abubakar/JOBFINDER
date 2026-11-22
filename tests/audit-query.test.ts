import assert from "node:assert/strict";
import test from "node:test";
import { auditCategory, auditPageHref, auditSeverity, buildAuditQuery } from "../lib/audit-query";

test("severity is derived from the stored action without rewriting it", () => {
  assert.equal(auditSeverity("application.submission_failed"), "error");
  assert.equal(auditSeverity("login.blocked"), "error");
  assert.equal(auditSeverity("submission_unverified"), "warning");
  assert.equal(auditSeverity("provider.timeout"), "warning");
  assert.equal(auditSeverity("login.success"), "info");
  assert.equal(auditCategory("application.submission_failed"), "application");
  assert.equal(auditCategory("logout"), "logout");
});

test("search, category, agent and date filters become parameterised clauses", () => {
  const query = buildAuditQuery({
    q: "Noor",
    category: "application",
    agentKey: "application",
    agentName: "Noor",
    from: "2026-11-01T00:00:00.000Z",
    to: "2026-11-21T23:59:59.999Z",
  });
  assert.match(query.where, /action LIKE \?/);
  assert.match(query.where, /detail LIKE \?/);
  assert.match(query.where, /entity = 'agent'/);
  assert.match(query.where, /created_at >= \?/);
  assert.equal(query.params.length, 10);
  assert.ok(query.params.includes("%Noor%"));
  assert.ok(!query.where.includes("Noor"), "user input must not be interpolated into SQL");
});

test("severity filters never remove rows from storage and pagination is bounded", () => {
  const error = buildAuditQuery({ severity: "error", page: 2, pageSize: 999 });
  assert.match(error.where, /failed/);
  assert.equal(error.pageSize, 100);
  assert.equal(error.offset, 100);
  const info = buildAuditQuery({ severity: "info" });
  assert.match(info.where, /^WHERE NOT \(/);
  const clamped = buildAuditQuery({ page: -3, pageSize: 2 });
  assert.equal(clamped.page, 1);
  assert.equal(clamped.pageSize, 10);
  assert.equal(clamped.offset, 0);
  assert.equal(buildAuditQuery({}).where, "");
});

test("pagination links keep every active filter", () => {
  const href = auditPageHref({ q: "failed", category: "application", severity: "error", agent: "cv", from: "2026-11-01" }, 3);
  assert.match(href, /^\/admin\/audit\?/);
  assert.match(href, /q=failed/);
  assert.match(href, /category=application/);
  assert.match(href, /severity=error/);
  assert.match(href, /agent=cv/);
  assert.match(href, /from=2026-11-01/);
  assert.match(href, /page=3/);
});
