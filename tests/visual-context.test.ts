import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-visual-context-"));
process.env.APP_SECRET_KEY = "visual-context-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";

const db = await import("../lib/db.ts");
const context = await import("../lib/visual-context.ts");
const companion = await import("../lib/visual-companion.ts");
const live = await import("../lib/live-voice.ts");

db.getDb();
const ts = new Date().toISOString();
db.run("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u_ctx','ctx@example.test','x','Context Owner','owner',?)", [ts]);
db.run("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u_other','other@example.test','x','Other Owner','owner',?)", [ts]);
db.run(
  `INSERT INTO jobs (id, source, title, company, location, discovered_at, status, match_score, match_flag, qualified)
   VALUES ('job_ctx','fixture','Senior QA Engineer','Context AG','Zurich',?,'ready',91,'strong',1)`,
  [ts],
);
db.run(
  `INSERT INTO applications (id, job_id, status, submission_status, last_update, created_at)
   VALUES ('app_ctx','job_ctx','submitted','verified',?,?)`,
  [ts, ts],
);
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, text_content, created_at)
   VALUES ('doc_ctx','u_ctx','tailored_cv','Context CV','cv.pdf','application/pdf','cv.pdf','Summary: Senior QA engineer with Playwright experience.',?)`,
  [ts],
);
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, text_content, created_at)
   VALUES ('doc_other','u_other','tailored_cv','Other CV','other.pdf','application/pdf','other.pdf','Other account secret text.',?)`,
  [ts],
);

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("dashboard context exposes real KPI and pipeline values", () => {
  const page = context.pageContext("u_ctx", "dashboard");
  assert.equal(page.view, "dashboard");
  const total = page.kpis.find((kpi) => kpi.label === "Jobs discovered");
  assert.equal(total?.value, 1);
  const verified = page.statuses.find((status) => status.label === "submitted");
  assert.equal(verified?.value, 1);
});

test("chart context exposes labels, datasets, axes and the selected range", () => {
  const { charts } = context.chartContext("7");
  const verified = charts.find((chart) => chart.id === "verified");
  assert.ok(verified);
  assert.equal(verified!.labels.length, verified!.datasets[0].values.length);
  assert.equal(verified!.axes.x, "Date");
  assert.match(verified!.axes.y, /submissions/i);
  assert.match(verified!.title, /Verified submissions/);
});

test("a document is readable only by its owning account", () => {
  const owned = context.readOwnedDocument("u_ctx", { which: "latest_cv" });
  assert.equal(owned.ok, true);
  if (owned.ok) assert.match(owned.text, /Playwright/);

  const foreign = context.readOwnedDocument("u_ctx", { document_id: "doc_other" });
  assert.equal(foreign.ok, false);

  const missing = context.readOwnedDocument("u_ctx", { document_id: "doc_not_stored" });
  assert.equal(missing.ok, false);
});

test("an explanation uses the stored chart values instead of claiming the screen is invisible", () => {
  const answer = context.explainVisualQuestion("u_ctx", "Explain this graph.");
  assert.ok(answer);
  assert.match(answer!.reply, /Vacancies discovered/);
  assert.match(answer!.reply, /Range/);
  assert.doesNotMatch(answer!.reply, /can'?t see|cannot see your screen/i);
});

test("all eight agents receive the visual-understanding tools", () => {
  for (const agentKey of live.LIVE_AGENT_KEYS) {
    const declarations = live.liveToolDeclarations(agentKey);
    const names = new Set(declarations.map((item) => item.name));
    for (const tool of ["get_page_context", "get_chart_data", "get_table_data", "read_document", "open_workspace", "highlight_interface"]) {
      assert.equal(names.has(tool), true, `${agentKey} is missing ${tool}`);
    }
  }
});

test("structured visual tools execute through the shared registry", () => {
  const page = companion.executeVisualTool("u_ctx", "owner", "get_page_context", { view: "applications" });
  assert.equal(page.ok, true);
  assert.ok(page.facts);

  const table = companion.executeVisualTool("u_ctx", "owner", "get_table_data", { table: "applications" });
  assert.equal(table.ok, true);

  const doc = companion.executeVisualTool("u_ctx", "owner", "read_document", { which: "latest_cv" });
  assert.equal(doc.ok, true);
  assert.match(String(doc.facts?.text ?? ""), /Playwright/);
});
