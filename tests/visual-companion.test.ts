import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-visual-companion-"));
process.env.APP_SECRET_KEY = "visual-companion-test-secret";

const { getDb, run } = await import("../lib/db.ts");
const {
  detectVisualIntent,
  executeVisualTool,
  highlightInterface,
  showDocument,
  visualViewCommand,
} = await import("../lib/visual-companion.ts");

getDb();
run("INSERT OR IGNORE INTO users (id, email, password_hash, name, role, created_at) VALUES ('u_owner','owner@test.local','x','Owner','owner', ?)", [new Date().toISOString()]);
run("INSERT OR IGNORE INTO users (id, email, password_hash, name, role, created_at) VALUES ('u_admin','admin@test.local','x','Admin','admin', ?)", [new Date().toISOString()]);

function addDocument(id: string, userId: string, kind: string, createdAt: string): void {
  run(
    `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, version, created_at)
     VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, 10, 'draft', '1.0', ?)`,
    [id, userId, kind, `${kind} ${id}`, `${id}.pdf`, `${id}.pdf`, createdAt],
  );
}

addDocument("doc_owner_cv", "u_owner", "tailored_cv", "2026-01-02T10:00:00.000Z");
addDocument("doc_owner_original", "u_owner", "original_cv", "2026-01-01T10:00:00.000Z");
addDocument("doc_owner_cover", "u_owner", "cover_letter", "2026-01-03T10:00:00.000Z");
addDocument("doc_other_cv", "u_admin", "tailored_cv", "2026-02-01T10:00:00.000Z");

test("the latest CV is resolved to a real owned document", () => {
  const outcome = showDocument("u_owner", { which: "latest_cv" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.visual?.type, "navigate");
  assert.equal(outcome.visual?.type === "navigate" ? outcome.visual.href : "", "/documents/doc_owner_cv");
  assert.equal(outcome.visual?.type === "navigate" ? outcome.visual.highlight?.target : "", "document-preview");
});

test("the latest cover letter is resolved separately from the CV", () => {
  const outcome = showDocument("u_owner", { which: "latest_cover_letter" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.visual?.type === "navigate" ? outcome.visual.href : "", "/documents/doc_owner_cover");
});

test("an unknown document id is reported and nothing is substituted", () => {
  const outcome = showDocument("u_owner", { which: "specific", document_id: "doc_missing" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.visual, undefined);
  assert.match(outcome.message, /does not exist|not stored/i);
});

test("another account's document cannot be opened through voice", () => {
  const outcome = showDocument("u_owner", { which: "specific", document_id: "doc_other_cv" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.visual, undefined);
});

test("a missing CV is reported rather than invented", () => {
  run("INSERT OR IGNORE INTO users (id, email, password_hash, name, role, created_at) VALUES ('u_empty','empty@test.local','x','Empty','owner', ?)", [new Date().toISOString()]);
  const outcome = showDocument("u_empty", { which: "latest_cv" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.visual, undefined);
  assert.match(outcome.message, /No CV is stored/);
});

test("the provider configuration view is administrator-only", () => {
  const owner = visualViewCommand("providers", { role: "owner" });
  assert.equal(owner.ok, false);
  assert.equal(owner.visual, undefined);
  const admin = visualViewCommand("providers", { role: "admin" });
  assert.equal(admin.ok, true);
});

test("only registry highlight targets can be highlighted", () => {
  const valid = highlightInterface({ target: "recruitment-pipeline", explanation: "Real recorded stages." });
  assert.equal(valid.ok, true);
  assert.equal(valid.visual?.type === "navigate" ? valid.visual.highlight?.target : valid.visual?.type === "highlight" ? valid.visual.highlight.target : "", "recruitment-pipeline");
  const invalid = highlightInterface({ target: "made-up-element" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.visual, undefined);
});

test("natural-language commands open real views without inventing records", () => {
  const cv = detectVisualIntent("u_owner", "Show me the latest CV.");
  assert.equal(cv?.visual?.type === "navigate" ? cv.visual.href : "", "/documents/doc_owner_cv");

  const dashboard = detectVisualIntent("u_owner", "Take me back to the dashboard.");
  assert.equal(dashboard?.visual?.type === "navigate" ? dashboard.visual.href : "", "/dashboard");

  const pipeline = detectVisualIntent("u_owner", "Walk me through the recruitment pipeline.");
  assert.equal(pipeline?.visual?.type === "navigate" ? pipeline.visual.highlight?.target : "", "recruitment-pipeline");
});

test("diagnostic questions are not hijacked into navigation", () => {
  assert.equal(detectVisualIntent("u_owner", "Explain why this job is blocked."), null);
  assert.equal(detectVisualIntent("u_owner", "Why did the CV fail?"), null);
  assert.equal(detectVisualIntent("u_owner", "What is my latest CV?"), null);
});

test("visual tools execute through the registry and reject unknown view names", () => {
  const ok = executeVisualTool("u_owner", "owner", "open_workspace", { view: "documents" });
  assert.equal(ok.ok, true);
  assert.equal(ok.visual?.type === "navigate" ? ok.visual.href : "", "/documents#tailored-documents");
  const bad = executeVisualTool("u_owner", "owner", "open_workspace", { view: "file:///etc/passwd" });
  assert.equal(bad.ok, false);
  assert.equal(bad.visual, undefined);
});
