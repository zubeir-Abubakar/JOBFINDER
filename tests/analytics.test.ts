import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-analytics-"));
process.env.FREELMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const analytics = await import("../lib/analytics.ts");

db.getDb();
const today = analytics.dayKey(new Date());
const now = new Date().toISOString();

db.run(
  "INSERT INTO jobs (id, source, title, company, eligibility, qualified, match_score, match_flag, discovered_at) VALUES ('job_verified', 'test', 'Senior QA', 'Acme', 'eligible', 1, 92, 'strong', ?)",
  [now],
);
db.run(
  "INSERT INTO jobs (id, source, title, company, eligibility, qualified, match_score, match_flag, discovered_at) VALUES ('job_unverified', 'test', 'QA Engineer', 'Beta', 'ineligible', 0, 70, 'possible', ?)",
  [now],
);
db.run(
  "INSERT INTO applications (id, job_id, status, confirmation, submitted_at, last_update, created_at) VALUES ('app_verified', 'job_verified', 'submitted', 'employer-ref-1', ?, ?, ?)",
  [now, now, now],
);
db.run(
  "INSERT INTO applications (id, job_id, status, last_update, created_at) VALUES ('app_unverified', 'job_unverified', 'submission_unverified', ?, ?)",
  [now, now],
);
db.run(
  "INSERT INTO submission_attempts (id, application_id, job_id, channel, status, attempted_at) VALUES ('attempt_1', 'app_verified', 'job_verified', 'http_form', 'submitted', ?)",
  [now],
);
db.run(
  "INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, created_at) VALUES ('doc_cv', 'u1', 'tailored_cv', 'CV', 'cv.pdf', 'application/pdf', 'uploads/cv.pdf', 10, 'job_verified', ?)",
  [now],
);
db.run(
  "INSERT INTO tasks (id, agent_key, title, status, created_at) VALUES ('task_done', 'research', 'Research QA roles', 'completed', ?)",
  [now],
);
db.run(
  "INSERT INTO tasks (id, agent_key, title, status, created_at) VALUES ('task_failed', 'analysis', 'Score vacancy', 'failed', ?)",
  [now],
);
db.run(
  `INSERT INTO provider_usage (provider, model, agent_key, prompt_tokens, completion_tokens, total_tokens, usage_source, status, created_at)
   VALUES ('freellmapi', 'openai/gpt-oss-20b', 'research', 90, 30, 120, 'provider', 'ok', ?)`,
  [now],
);
db.run(
  `INSERT INTO provider_usage (provider, model, agent_key, prompt_tokens, completion_tokens, total_tokens, usage_source, status, created_at)
   VALUES ('ollama', 'llama3.2:3b', 'analysis', 40, 10, 50, 'estimated', 'ok', ?)`,
  [now],
);

const range = {
  from: today,
  to: today,
  preset: "today" as const,
  label: "Today",
};
const data = analytics.getAnalytics(range);

test("provider and model charts use actual inference records with input/output totals", () => {
  assert.equal(data.providerMetric, "calls");
  assert.equal(data.providerDistribution.find((row) => row.label === "FreeLLMAPI")?.value, 1);
  assert.equal(data.providerDistribution.find((row) => row.label === "Ollama (local)")?.value, 1);
  assert.match(data.providerDistribution.find((row) => row.label === "FreeLLMAPI")?.detail ?? "", /120 tokens/);
  assert.equal(data.modelUsage.length, 2);
  assert.equal(data.modelUsage[0].totalTokens, 120);
  assert.equal(data.modelUsage[0].inputTokens, 90);
  assert.equal(data.modelUsage[0].outputTokens, 30);
  assert.equal(data.tokens.total, 170);
  assert.equal(data.tokens.providerReported, 120);
  assert.equal(data.tokens.estimated, 50);
  assert.equal(data.tokens.local, 50);
  assert.equal(data.tokens.cost, "unverified");
});

test("funnel keeps prepared, attempted and verified separate", () => {
  const value = (label: string) => data.funnel.find((row) => row.label.startsWith(label))?.value;
  assert.equal(value("Vacancies discovered"), 2);
  assert.equal(value("Vacancies classified"), 2);
  assert.equal(value("Eligible vacancies"), 1);
  assert.equal(value("Qualified matches"), 1);
  assert.equal(value("Applications prepared"), 1);
  assert.equal(value("Applications attempted"), 1);
  assert.equal(value("Verified submissions"), 1);
});

test("application outcomes are mutually exclusive and reconcile", () => {
  assert.equal(data.outcomesTotal, 2);
  assert.equal(data.outcomes.reduce((sum, row) => sum + row.value, 0), 2);
  assert.equal(data.outcomes.find((row) => row.label === "Verified submissions")?.value, 1);
  assert.equal(data.outcomes.find((row) => row.label === "Unverified submissions")?.value, 1);
  assert.equal(data.outcomes.find((row) => row.label === "Blocked submissions")?.value, 0);
});

test("agent distribution and task ranking distinguish outcomes from idle", () => {
  const completed = data.agentDistribution.find((row) => row.label === "Completed latest task")?.value;
  const failed = data.agentDistribution.find((row) => row.label === "Failed latest task")?.value;
  assert.equal(completed, 1);
  assert.equal(failed, 1);
  assert.equal(data.productivity.find((row) => row.label === "Successful tasks")?.value, 1);
  assert.equal(data.productivity.find((row) => row.label === "Failed tasks")?.value, 1);
  assert.equal(data.productivityRanking[0].completed, 1);
});

test("range resolution supports presets, custom ranges and the all-time floor", () => {
  const fixed = new Date("2026-11-18T12:00:00Z");
  assert.equal(analytics.resolveAnalyticsRange({ preset: "today", today: fixed }).from, "2026-11-18");
  assert.equal(analytics.resolveAnalyticsRange({ preset: "7", today: fixed }).from, "2026-11-12");
  assert.equal(analytics.resolveAnalyticsRange({ preset: "30", today: fixed }).from, "2026-10-20");
  assert.equal(
    analytics.resolveAnalyticsRange({ preset: "custom", from: "2026-11-01", to: "2026-11-10", today: fixed }).from,
    "2026-11-01",
  );
  assert.equal(analytics.resolveAnalyticsRange({ preset: "custom", from: "2026-12-01", to: "2026-11-10", today: fixed }).from, "2026-11-10");
  const earliestJob = db.one<{ d: string | null }>("SELECT MIN(date(discovered_at)) AS d FROM jobs")?.d;
  const allTime = analytics.resolveAnalyticsRange({ preset: "all", today: fixed });
  assert.ok(allTime.from <= "2026-11-18");
  if (earliestJob) assert.ok(allTime.from <= earliestJob, "all-time floor must not start after the first stored job");
});
