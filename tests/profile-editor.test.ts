import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "atw-profile-editor-"));
process.env.DATA_DIR = dataDir;

const { getDb, nowIso, run } = await import("../lib/db.ts");
const { getProfileData, parseLanguageEntries, parseLanguageText, formatLanguageEntries } = await import("../lib/profile.ts");
const { sanitizeRichText, richTextToPlain, richTextToBullets, listToHtml } = await import("../lib/rich-text.ts");

test("languages accept legacy strings and structured rows without duplicates", () => {
  const legacy = parseLanguageEntries(JSON.stringify(["English (C2)", "French", "English (B1)"]));
  assert.deepEqual(legacy, [
    { name: "English", level: "C2" },
    { name: "French", level: "unspecified" },
  ]);
  const structured = parseLanguageEntries(JSON.stringify([
    { name: "Swahili", level: "native" },
    { name: "German", level: "B1" },
    { name: "swahili", level: "C1" },
  ]));
  assert.deepEqual(structured, [
    { name: "Swahili", level: "native" },
    { name: "German", level: "B1" },
  ]);
  assert.equal(formatLanguageEntries(legacy), "English (C2) | French");
});

test("a CV language line imports names and levels, and does not assume English", () => {
  assert.deepEqual(parseLanguageText("English (C2) | French (B2) | Swahili (Native) | Somali (Native)"), [
    { name: "English", level: "C2" },
    { name: "French", level: "B2" },
    { name: "Swahili", level: "native" },
    { name: "Somali", level: "native" },
  ]);
  assert.deepEqual(parseLanguageText("German (C1)"), [{ name: "German", level: "C1" }]);
  assert.deepEqual(parseLanguageText(""), []);
});

test("rich role content keeps supported formatting and removes executable markup", () => {
  const clean = sanitizeRichText('<p>Led <b>quality</b> and <u>release</u>.</p><script>alert(1)</script><img src=x onerror=alert(1)><ul><li>One</li></ul>');
  assert.match(clean, /<b>quality<\/b>/);
  assert.match(clean, /<u>release<\/u>/);
  assert.match(clean, /<ul><li>One<\/li><\/ul>/);
  assert.doesNotMatch(clean, /script|onerror|<img/i);
  assert.equal(richTextToPlain(clean), "Led quality and release.\n• One");
  assert.deepEqual(richTextToBullets(clean), ["Led quality and release.", "One"]);
  assert.match(listToHtml(["Bold? <safe>"]), /&lt;safe&gt;/);
});

test("schema v7 adds editor columns without rewriting existing records", () => {
  const db = getDb();
  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
  for (const column of ["responsibilities_html", "achievements_html", "projects", "projects_html", "source_key", "edited_at", "deleted_at"]) {
    assert.ok(columns("experiences").includes(column), `experiences.${column} missing`);
  }
  assert.ok(columns("skills").includes("deleted_at"));
  assert.ok(columns("profiles").includes("languages_synced_at"));
  assert.ok(columns("profiles").includes("cv_synced_source"));
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
});

test("profile rows passed to client components are plain objects", () => {
  if (getProfileData().skills.length === 0) {
    run("INSERT INTO skills (name, category, level, verified, source, sort) VALUES ('Plain object skill', 'Other', 'unspecified', 1, 'manual', 9500)");
  }
  const data = getProfileData();
  assert.ok(data.skills.length > 0);
  assert.ok(data.skills.every((skill) => Object.getPrototypeOf(skill) === Object.prototype));
  assert.ok(data.experiences.every((experience) => Object.getPrototypeOf(experience) === Object.prototype));
  assert.equal(Object.getPrototypeOf(data.profile), Object.prototype);
});

test("the skill library excludes seed inventory and collapses duplicate names", () => {
  run("INSERT INTO skills (name, category, level, verified, source, sort) VALUES ('Seed-only example', 'Other', 'advanced', 1, 'seed', 9600)");
  run("INSERT INTO skills (name, category, level, verified, source, sort) VALUES ('Duplicate CV example', 'Other', 'working', 1, 'cv', 9601)");
  run("INSERT INTO skills (name, category, level, verified, source, sort) VALUES ('duplicate cv example', 'Other', 'exposure', 1, 'cv', 9602)");
  const skills = getProfileData().skills;
  assert.ok(!skills.some((skill) => skill.name === "Seed-only example"));
  assert.equal(skills.filter((skill) => skill.name.toLowerCase() === "duplicate cv example").length, 1);
});

test("soft-deleted profile entries are excluded from active data while tombstones persist", () => {
  run(
    "INSERT INTO skills (name, category, level, verified, source, sort) VALUES ('Editor test active', 'Other', 'unspecified', 1, 'manual', 9000)",
  );
  run(
    "INSERT INTO skills (name, category, level, verified, source, sort, deleted_at) VALUES ('Editor test removed', 'Other', 'working', 1, 'manual', 9001, ?)",
    [nowIso()],
  );
  run(
    "INSERT INTO experiences (company, title, summary, achievements, sort) VALUES ('Editor Co', 'Active Role', 'Responsibility', '[\"Achievement\"]', 9000)",
  );
  run(
    "INSERT INTO experiences (company, title, summary, achievements, sort, deleted_at) VALUES ('Editor Co', 'Removed Role', NULL, '[]', 9001, ?)",
    [nowIso()],
  );
  const data = getProfileData();
  assert.ok(data.skills.some((skill) => skill.name === "Editor test active"));
  assert.ok(!data.skills.some((skill) => skill.name === "Editor test removed"));
  assert.ok(data.experiences.some((experience) => experience.title === "Active Role"));
  assert.ok(!data.experiences.some((experience) => experience.title === "Removed Role"));
  assert.ok(data.deletedExperiences.some((experience) => experience.title === "Removed Role"));
});
