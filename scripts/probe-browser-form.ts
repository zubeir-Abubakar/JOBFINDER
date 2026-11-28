/**
 * Proves the Playwright candidate-form executor against a real JavaScript ATS
 * page without submitting anything.
 *
 *   npx tsx scripts/probe-browser-form.ts [jobId]
 *
 * The executor renders the page, detects the form, fills every answer from the
 * verified profile/documents, verifies each field, and returns before any
 * submit or next control is activated. A screenshot is written to .tmp.
 */
export {};

process.env.RECRUITMENT_BROWSER_FORMS = "true";
process.env.RECRUITMENT_SCHEDULER = "false";

import { readFileSync } from "node:fs";
import path from "node:path";

const { DATA_DIR, all, one, closeDb } = await import("../lib/db.ts");
const { runBrowserCandidateForm } = await import("../lib/browser-form.ts");

const target = process.argv[2] ?? "job_9b3dd7e919e54471"; // Transgourmet, prospective.ch ATS
const directUrl = /^https?:\/\//i.test(target) ? target : null;

const job = directUrl
  ? { id: "external-probe", title: process.argv[3] ?? "QA Engineer", company: process.argv[4] ?? "External ATS", application_url: directUrl, url: directUrl }
  : one<{
      id: string;
      title: string;
      company: string;
      application_url: string | null;
      url: string | null;
    }>("SELECT id, title, company, application_url, url FROM jobs WHERE id = ?", [target]);
if (!job?.application_url) throw new Error(`No application URL for ${target}`);

const profileRow = one<{
  full_name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin: string | null;
  website: string | null;
  work_authorisation: string | null;
  summary: string | null;
  languages: string | null;
}>(
  "SELECT full_name, email, phone, location, linkedin, website, work_authorisation, summary, languages FROM profiles ORDER BY id LIMIT 1",
);
const skills = all<{ name: string }>("SELECT name FROM skills ORDER BY sort LIMIT 40").map((row) => row.name);
const experiences = all<{
  company: string;
  title: string;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
  summary: string | null;
  achievements: string | null;
}>("SELECT company, title, location, start_date, end_date, summary, achievements FROM experiences ORDER BY sort LIMIT 10");
const experienceText = experiences
  .map((item) =>
    `${item.title} at ${item.company} (${item.start_date ?? "?"}–${item.end_date ?? "present"}). ${item.summary ?? ""} ${item.achievements ?? ""}`.trim(),
  )
  .join("\n");
let languages: string[] = [];
try {
  const parsed = JSON.parse(profileRow?.languages ?? "[]");
  if (Array.isArray(parsed)) {
    languages = parsed.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
  }
} catch {
  languages = [];
}

function documentBuffer(documentId: string | null): { buffer: Buffer; name: string } | null {
  if (!documentId) return null;
  const row = one<{ relative_path: string; display_name: string; file_name: string }>(
    "SELECT relative_path, display_name, file_name FROM documents WHERE id = ? AND deleted_at IS NULL",
    [documentId],
  );
  if (!row) return null;
  try {
    return { buffer: readFileSync(path.join(DATA_DIR, row.relative_path)), name: row.file_name || row.display_name };
  } catch {
    return null;
  }
}

const cv = one<{ id: string }>(
  "SELECT id FROM documents WHERE kind = 'tailored_cv' AND deleted_at IS NULL AND quality_status = 'passed' ORDER BY created_at DESC LIMIT 1",
);
const cover = one<{ id: string }>(
  "SELECT id FROM documents WHERE kind = 'cover_letter' AND deleted_at IS NULL AND quality_status = 'passed' ORDER BY created_at DESC LIMIT 1",
);

const run = await runBrowserCandidateForm({
  pageUrl: job.application_url,
  jobTitle: job.title,
  company: job.company,
  profile: {
    fullName: profileRow?.full_name ?? null,
    email: profileRow?.email ?? null,
    phone: profileRow?.phone ?? null,
    location: profileRow?.location ?? null,
    linkedin: profileRow?.linkedin ?? null,
    website: profileRow?.website ?? null,
    workAuthorisation: profileRow?.work_authorisation ?? null,
    summary: profileRow?.summary ?? null,
    skills,
    languages,
    experienceText: experienceText || null,
    educationText: null,
    sponsorshipAnswer: null,
  },
  documents: {
    cv: documentBuffer(cv?.id ?? null),
    cover: documentBuffer(cover?.id ?? null),
    coverText: null,
  },
  probeOnly: true,
  screenshotPath: path.join(process.cwd(), ".tmp", directUrl ? "real-ats-probe.png" : "prospective-probe.png"),
});

console.log(
  JSON.stringify(
    {
      job: { id: job.id, title: job.title, company: job.company, applicationUrl: job.application_url },
      probe: run.probe ?? null,
      plan: { status: run.plan.status, action: run.plan.action, fields: run.plan.fields.length, blockers: run.plan.blockers },
      result: { status: run.result.status, detail: run.result.detail, finalUrl: run.result.finalUrl, sent: run.result.evidence?.sent },
    },
    null,
    2,
  ),
);
closeDb();
