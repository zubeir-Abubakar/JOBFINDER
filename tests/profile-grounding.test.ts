import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-profile-grounding-"));
process.env.APP_SECRET_KEY = "profile-grounding-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const assistant = await import("../lib/assistant.ts");
const profileBrief = await import("../lib/profile-brief.ts");

db.getDb();
const now = new Date().toISOString();
db.run(
  "INSERT INTO users (id, email, password_hash, name, role, status, must_change_password, created_at) VALUES ('u_profile', 'profile@test.local', 'not-used', 'Profile Owner', 'owner', 'active', 0, ?)",
  [now],
);
db.run(
  "UPDATE profiles SET full_name = ?, headline = ?, location = ?, summary = ?, source_cv_id = ?, preferences = ? WHERE id = 1",
  [
    "Synthetic Candidate",
    "Senior QA Engineer",
    "Zurich, Switzerland",
    "Quality engineer focused on browser automation.",
    "doc_profile_cv",
    JSON.stringify({ titles: ["Senior QA Engineer"], locations: ["Zurich"], min_salary: 100000, remote_preference: "hybrid_or_remote", employment_types: ["Full-time"], languages: ["English"], industries: [], german_required: "avoid", french: "evaluate" }),
  ],
);
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, text_content, created_at)
   VALUES ('doc_profile_cv', 'system', 'original_cv', 'Synthetic CV.pdf', 'synthetic-cv.pdf', 'application/pdf', 'synthetic-cv.pdf', 120, 'ready', ?, ?)`,
  [
    "Synthetic Candidate. Senior QA Engineer. Built Playwright automation for a Swiss payments platform. Led a team of four quality engineers.",
    now,
  ],
);
db.run(
  "INSERT INTO skills (name, category, level, years, verified, source, sort) VALUES (?, ?, ?, ?, 1, 'cv', 1)",
  ["Playwright", "Automation & testing", "advanced", 6],
);
db.run(
  "INSERT INTO experiences (company, title, location, start_date, end_date, is_current, summary, sort) VALUES (?, ?, ?, ?, NULL, 1, ?, 1)",
  [
    "Synthetic Payments AG",
    "Senior QA Engineer",
    "Zurich, Switzerland",
    "2021-01",
    "Led browser automation and quality engineering.",
  ],
);

test("a profile question is answered from stored fields and extracted CV text", async () => {
  const result = await assistant.handleAssistantMessage("u_profile", "What do you know about me from my profile?");
  assert.match(result.reply, /Synthetic Candidate/);
  assert.match(result.reply, /Senior QA Engineer/);
  assert.match(result.reply, /Stored profile fields/);
  assert.match(result.reply, /not independently verified/);
  assert.match(result.reply, /Synthetic Payments AG/);
  assert.match(result.reply, /Playwright/);
  assert.match(result.reply, /I have not inferred/);
  assert.deepEqual(result.agentKeys, ["coordinator"]);
});

test("a CV question includes extracted evidence and does not claim missing details", async () => {
  const result = await assistant.handleAssistantMessage("u_profile", "Show me what is in my CV.");
  assert.match(result.reply, /Synthetic CV\.pdf/);
  assert.match(result.reply, /Built Playwright automation/);
  assert.match(result.reply, /CV extract/);
  assert.match(result.reply, /Missing information/);
  assert.doesNotMatch(result.reply, /I (?:graduated|earned|worked at) (?!Synthetic)/);
});

test("profile mutation requests are not mistaken for read-only inspection", () => {
  assert.equal(profileBrief.isProfileQuestion("Show me what is in my CV."), true);
  assert.equal(profileBrief.isProfileQuestion("What do you know about me from my profile?"), true);
  assert.equal(profileBrief.isProfileQuestion("Generate a tailored CV for the Noor role."), false);
  assert.equal(profileBrief.isProfileQuestion("Update my profile headline."), false);
  assert.equal(profileBrief.isProfileQuestion("How many tokens did we use today?"), false);
});
