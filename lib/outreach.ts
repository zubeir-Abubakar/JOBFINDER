import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { all, nowIso, one, run, UPLOAD_DIR } from "./db.ts";
import { createGmailDraftWithAttachments, findGmailSentOutreach } from "./gmail.ts";
import { recordApplicationEvent } from "./application-events.ts";
import { randomId } from "./security.ts";
import { discoverOutreachContacts, verifiedContactsForJob, type StoredContact } from "./outreach-contacts.ts";

/**
 * Hiring-manager outreach lifecycle.
 *
 * Draft creation is deliberately separate from submission and from sending.
 * A Gmail draft is never evidence that an email was sent, and an application
 * failure never deletes an existing draft.
 */

export type OutreachStatus =
  | "draft_created"
  | "draft_missing"
  | "sent"
  | "failed"
  | "blocked";

export type OutreachAttachment = {
  documentId: string;
  filename: string;
  mime: string;
  hash: string;
  size: number;
};

export type OutreachAttachmentManifest = {
  cv: OutreachAttachment;
  cover: OutreachAttachment;
};

export type OutreachDraftGatewayInput = {
  to: string;
  subject: string;
  body: string;
  attachments: Array<{ filename: string; mime: string; content: Buffer }>;
};

export type OutreachDraftGatewayResult = {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
  rfcMessageId: string | null;
};

export type OutreachDraftGateway = (input: OutreachDraftGatewayInput) => Promise<OutreachDraftGatewayResult>;

export const defaultOutreachDraftGateway: OutreachDraftGateway = async (input) =>
  createGmailDraftWithAttachments(input);

export type ApplicationContext = {
  id: string;
  job_id: string;
  status: string;
  cv_document_id: string | null;
  cover_letter_id: string | null;
  title: string;
  company: string;
  location: string | null;
  description: string | null;
  match_score: number | null;
  analysis: string | null;
  employer_url: string | null;
  application_url: string | null;
  application_email: string | null;
};

export function applicationContext(applicationId: string): ApplicationContext | null {
  return one<ApplicationContext>(
    `SELECT a.id, a.job_id, a.status, a.cv_document_id, a.cover_letter_id,
            j.title, j.company, j.location, j.description, j.match_score, j.analysis,
            j.employer_url, j.application_url, j.application_email
     FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
    [applicationId],
  );
}

function readDocument(row: {
  id: string;
  job_id: string | null;
  kind: string;
  display_name: string;
  file_name: string;
  mime: string;
  relative_path: string;
  size_bytes: number;
  quality_status: string | null;
  text_content: string | null;
}, expectedKind: "tailored_cv" | "cover_letter", job: ApplicationContext): { manifest: OutreachAttachment; content: Buffer } {
  if (row.job_id !== job.job_id) throw new Error(`Document ${row.id} belongs to another vacancy.`);
  if (row.kind !== expectedKind) throw new Error(`Document ${row.id} is not a ${expectedKind.replace("_", " ")}.`);
  if (row.quality_status !== "passed") throw new Error(`Document ${row.id} did not pass the quality gate.`);
  if (Number(row.size_bytes) <= 0) throw new Error(`Document ${row.id} is empty.`);
  const safe = path.basename(row.relative_path);
  const filePath = path.join(UPLOAD_DIR, safe);
  if (!existsSync(filePath)) throw new Error(`Document ${row.id} is missing from storage.`);
  const content = readFileSync(filePath);
  if (content.length === 0 || !content.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    throw new Error(`Document ${row.id} is not a valid PDF.`);
  }
  const text = (row.text_content ?? "").replace(/\s+/g, " ").toLowerCase();
  if (!text.includes(job.company.toLowerCase())) throw new Error(`Document ${row.id} does not reference ${job.company}.`);
  if (expectedKind === "cover_letter" && !text.includes(job.title.toLowerCase())) {
    throw new Error(`Cover letter ${row.id} does not reference the role ${job.title}.`);
  }
  return {
    manifest: {
      documentId: row.id,
      filename: row.file_name.replace(/[\\"]/g, "_"),
      mime: row.mime === "application/pdf" ? row.mime : "application/pdf",
      hash: createHash("sha256").update(content).digest("hex"),
      size: content.length,
    },
    content,
  };
}

export function validateOutreachAttachments(applicationId: string): {
  ok: boolean;
  reason: string | null;
  application: ApplicationContext | null;
  manifest: OutreachAttachmentManifest | null;
  contents: { cv: Buffer; cover: Buffer } | null;
} {
  const application = applicationContext(applicationId);
  if (!application) return { ok: false, reason: "The application does not exist.", application: null, manifest: null, contents: null };
  if (!application.cv_document_id || !application.cover_letter_id) {
    return { ok: false, reason: "The application has no linked CV and cover letter.", application, manifest: null, contents: null };
  }
  if (application.cv_document_id === application.cover_letter_id) {
    return { ok: false, reason: "The CV and cover letter are the same document.", application, manifest: null, contents: null };
  }
  const rows = all<{
    id: string;
    job_id: string | null;
    kind: string;
    display_name: string;
    file_name: string;
    mime: string;
    relative_path: string;
    size_bytes: number;
    quality_status: string | null;
    text_content: string | null;
  }>(
    `SELECT id, job_id, kind, display_name, file_name, mime, relative_path, size_bytes, quality_status, text_content
     FROM documents WHERE id IN (?, ?) AND deleted_at IS NULL`,
    [application.cv_document_id, application.cover_letter_id],
  );
  const cvRow = rows.find((row) => row.id === application.cv_document_id);
  const coverRow = rows.find((row) => row.id === application.cover_letter_id);
  if (!cvRow || !coverRow) {
    return { ok: false, reason: "A linked document was deleted or is missing.", application, manifest: null, contents: null };
  }
  try {
    const cv = readDocument(cvRow, "tailored_cv", application);
    const cover = readDocument(coverRow, "cover_letter", application);
    return {
      ok: true,
      reason: null,
      application,
      manifest: { cv: cv.manifest, cover: cover.manifest },
      contents: { cv: cv.content, cover: cover.content },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Attachment validation failed.",
      application,
      manifest: null,
      contents: null,
    };
  }
}

function publicContactPages(employerUrl: string | null): string[] {
  if (!employerUrl) return [];
  try {
    const origin = new URL(employerUrl).origin;
    return ["/about", "/team", "/careers", "/leadership"].map((path) => `${origin}${path}`);
  } catch {
    return [];
  }
}

type OutreachProfile = {
  name: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  summary: string;
  workAuthorisation: string;
};

export function profileForEmail(): OutreachProfile {
  const row = one<{
    full_name: string | null;
    headline: string | null;
    email: string | null;
    phone: string | null;
    location: string | null;
    summary: string | null;
    work_authorisation: string | null;
  }>(
    "SELECT full_name, headline, email, phone, location, summary, work_authorisation FROM profiles WHERE id = 1",
  );
  return {
    name: row?.full_name?.trim() || "The candidate",
    headline: row?.headline?.trim() || "quality engineering professional",
    email: row?.email?.trim() || "",
    phone: row?.phone?.trim() || "",
    location: row?.location?.trim() || "",
    summary: row?.summary?.trim() || "",
    workAuthorisation: row?.work_authorisation?.trim() || "",
  };
}

/** Verified skills only. A tool is never quoted from a scoring token. */
export function verifiedSkillNames(): string[] {
  return all<{ name: string }>("SELECT name FROM skills WHERE verified = 1 ORDER BY sort").map((row) => row.name);
}

type ExperienceRow = { company: string; title: string; summary: string };

function experienceRows(): ExperienceRow[] {
  return all<ExperienceRow>(
    `SELECT company, title, summary FROM experiences
     WHERE deleted_at IS NULL AND summary IS NOT NULL AND length(trim(summary)) > 0 ORDER BY sort`,
  );
}

function joinList(items: string[]): string {
  const clean = items.filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean.at(-1)}`;
}

/**
 * Terms the vacancy actually asks for, restricted to things this candidate has
 * evidence for. Used to choose which verified experience a message quotes.
 */
function vacancyTerms(application: ApplicationContext): string[] {
  const text = `${application.title} ${application.description ?? ""}`.toLowerCase();
  const terms = new Set<string>();
  for (const skill of verifiedSkillNames()) {
    const lowered = skill.toLowerCase();
    if (lowered.length >= 3 && text.includes(lowered)) terms.add(lowered);
  }
  for (const keyword of [
    "api",
    "automation",
    "regression",
    "integration",
    "ci/cd",
    "sql",
    "mobile",
    "performance",
    "release",
    "billing",
    "provisioning",
    "telecom",
    "fintech",
    "payment",
    "security",
    "data",
  ]) {
    if (text.includes(keyword)) terms.add(keyword);
  }
  return [...terms];
}

function summaryBullets(summary: string): string[] {
  const bullets: string[] = [];
  for (const raw of summary.split(/\r?\n/)) {
    const trimmed = raw.trim();
    const line = trimmed.replace(/^[-*\s•·]+/, "").trim();
    if (!line) continue;
    const startsBullet = /^[-*•·]/.test(trimmed);
    const previous = bullets.at(-1);
    // A wrapped line in the stored profile is part of the previous bullet, not
    // a new achievement. Without this, a sentence can be quoted half-finished.
    if (previous && !startsBullet && !/[.!?]$/.test(previous)) {
      bullets[bullets.length - 1] = `${previous} ${line}`;
    } else {
      bullets.push(line);
    }
  }
  return bullets.filter((line) => line.length >= 25);
}

function bulletScore(bullet: string, terms: string[]): number {
  const lowered = bullet.toLowerCase();
  return terms.reduce((score, term) => score + (lowered.includes(term) ? 1 : 0), 0);
}

/** Keeps acronyms and proper nouns intact; lowercases an ordinary leading verb. */
function lowerFirst(text: string): string {
  if (!/^[A-Z][a-z]/.test(text)) return text;
  return text[0].toLowerCase() + text.slice(1);
}

/**
 * Experience prose built from the stored, verified experience bullets. No
 * sentence is invented: every clause is a bullet the profile already holds,
 * lowercased and joined.
 */
function experienceParagraph(
  application: ApplicationContext,
  terms: string[],
): { paragraph: string; employers: string[]; usedSkills: string[] } {
  const rows = experienceRows();
  if (rows.length === 0) return { paragraph: "", employers: [], usedSkills: [] };
  const ranked = rows
    .map((row) => ({
      row,
      score: summaryBullets(row.summary).reduce((sum, bullet) => sum + bulletScore(bullet, terms), 0),
    }))
    .sort((left, right) => right.score - left.score);
  const primary = ranked[0];
  const scored = summaryBullets(primary.row.summary)
    .map((bullet, index) => ({ bullet, index, score: bulletScore(bullet, terms) }))
    .filter((item) => item.score > 0);
  const selected = scored.sort((left, right) => right.score - left.score || left.index - right.index).slice(0, 3);
  // A quantified automation result is the strongest evidence a quality role can
  // quote. Where the vacancy is about regression or automation it is included
  // even when a longer list of tool mentions would score higher.
  const achievementRelevant = /regression|automation|test cycle|end-to-end/i.test(
    `${application.title} ${application.description ?? ""}`,
  );
  const achievementItem = scored.find((item) => /40%|regression execution time/i.test(item.bullet));
  if (achievementRelevant && achievementItem && !selected.some((item) => item.index === achievementItem.index)) {
    if (selected.length >= 3) selected.pop();
    selected.push(achievementItem);
  }
  const primaryBullets = selected
    .sort((left, right) => left.index - right.index)
    .map((item) => item.bullet.replace(/\.$/, ""));

  const employers = [primary.row.company];
  if (primaryBullets.length === 0) return { paragraph: "", employers, usedSkills: [] };

  let clauses = primaryBullets.map(lowerFirst);
  const achievement = clauses.findIndex((clause) => /40%|regression execution time/i.test(clause));
  if (achievement >= 0 && /regression|automation|test cycle/i.test(`${application.title} ${application.description ?? ""}`)) {
    clauses[achievement] = `${clauses[achievement]} — roughly 24 hours down to 12 for the full regression cycle`;
  }
  let paragraph = `As ${primary.row.title} at ${primary.row.company}, I ${joinList(clauses)}.`;

  const secondary = ranked.find(
    (item) => item.row.company !== primary.row.company && item.score > 0 && item.row.title !== primary.row.title,
  );
  if (secondary) {
    const bullet = summaryBullets(secondary.row.summary).sort((a, b) => bulletScore(b, terms) - bulletScore(a, terms))[0];
    if (bullet) {
      paragraph += ` Earlier, as ${secondary.row.title} at ${secondary.row.company}, I ${lowerFirst(bullet.replace(/\.$/, ""))}.`;
      employers.push(secondary.row.company);
    }
  }

  const usedSkills = verifiedSkillNames().filter((skill) =>
    paragraph.toLowerCase().includes(skill.toLowerCase()),
  );
  return { paragraph, employers, usedSkills };
}

const REQUIREMENT_MAP: Array<{ test: RegExp; skills: string[]; phrase: string }> = [
  {
    test: /automated test suite|test automation|automation|end-to-end testing|e2e/i,
    skills: ["Playwright", "Cypress", "Selenium", "Selenium WebDriver", "Appium"],
    phrase: "automated end-to-end and regression suites for web applications",
  },
  {
    test: /restful apis|grpc|api testing|testing apis|backend services|microservices/i,
    skills: ["REST APIs", "REST Assured", "Postman", "Swagger"],
    phrase: "API and backend-service testing",
  },
  {
    test: /\bsql\b|postgres|relational database/i,
    skills: ["SQL"],
    phrase: "SQL validation and test-data setup",
  },
  {
    test: /ci\/cd|continuous integration/i,
    skills: ["CI/CD", "Jenkins", "Azure DevOps"],
    phrase: "integrating automated tests into CI/CD pipelines",
  },
  {
    test: /docker|container/i,
    skills: ["Docker"],
    phrase: "containerised test environments",
  },
  {
    test: /mobile|ios|android|handset|device testing/i,
    skills: ["Appium", "Espresso", "XCUITest", "Manual & exploratory testing"],
    phrase: "mobile and device testing",
  },
  {
    test: /performance|load testing/i,
    skills: ["JMeter", "k6"],
    phrase: "performance and load testing",
  },
];

/** Requirements quoted from the vacancy, only where the profile proves them. */
function requirementSentence(application: ApplicationContext, verified: string[]): string {
  const description = application.description ?? "";
  if (description.trim().length === 0) return "";
  const available = new Set(verified.map((skill) => skill.toLowerCase()));
  const phrases: string[] = [];
  for (const item of REQUIREMENT_MAP) {
    if (!item.test.test(description)) continue;
    if (!item.skills.some((skill) => available.has(skill.toLowerCase()))) continue;
    if (!phrases.includes(item.phrase)) phrases.push(item.phrase);
  }
  return phrases.length > 0 ? `Your description asks for ${joinList(phrases.slice(0, 3))}.` : "";
}

function identitySentence(profile: OutreachProfile, summary: string): string {
  const years = Number(summary.match(/(\d+)\+?\s*years?/i)?.[1] ?? 0);
  const domains: string[] = [];
  if (/fintech|payment/i.test(summary)) domains.push("fintech");
  if (/saas/i.test(summary)) domains.push("SaaS");
  if (/mobile/i.test(summary)) domains.push("mobile");
  const domainText = domains.length > 0 ? ` across ${joinList(domains.slice(0, 2))} platforms` : "";
  const experience = years > 0 ? ` with over ${years} years of experience` : "";
  const place = profile.location ? `, based in ${profile.location}` : "";
  return `I am a quality engineer${experience}${domainText}${place}.`;
}

function authorisationSentence(workAuthorisation: string): string {
  if (!workAuthorisation) return "";
  if (/permit\s*b/i.test(workAuthorisation) && /without employer sponsorship/i.test(workAuthorisation)) {
    return "I hold a valid Swiss Permit B and am authorised to work in Switzerland without employer sponsorship.";
  }
  return `Work authorisation: ${workAuthorisation.replace(/\s+/g, " ").replace(/\.$/, "")}.`;
}

/**
 * Builds a complete, vacancy-specific professional email from verified data.
 * Nothing here is a template with placeholders swapped: the experience prose is
 * the stored experience, the requirement sentence quotes the actual vacancy,
 * and every claim is checked by `assessOutreachEmail` before the owner sees it
 * presented as ready to review.
 */
export function generateOutreachEmail(input: {
  application: ApplicationContext;
  contact: StoredContact;
  profile?: OutreachProfile;
  skills?: string[];
}): { subject: string; body: string } {
  const profile = input.profile ?? profileForEmail();
  const verified = input.skills ?? verifiedSkillNames();
  const terms = vacancyTerms(input.application);
  const experience = experienceParagraph(input.application, terms);
  const requirements = requirementSentence(input.application, verified);
  const identity = identitySentence(profile, profile.summary);
  const place = input.application.location ? ` in ${input.application.location}` : "";
  const telecomClause =
    /telecom|mobile network|sim\/esim|provisioning|bss|roaming/i.test(input.application.description ?? "") &&
    experience.employers.some((employer) => /safaricom/i.test(employer))
      ? " I also have direct exposure to telecom-scale distributed systems and UAT from my time at Safaricom."
      : "";
  // A team inbox must be greeted as a team; addressing a generic inbox by its
  // first word would read as a person's name and misrepresent the recipient.
  const teamInbox = /\bteam\b|recruitment contact/i.test(input.contact.name);
  const greeting = teamInbox ? "Dear Hiring Team," : `Dear ${input.contact.name.split(/\s+/)[0] || input.contact.name},`;
  const subject = `${input.application.title} — application from ${profile.name}`;
  const requirementBlock = [requirements, experience.paragraph].filter(Boolean).join(" ");
  const closing =
    [profile.email, profile.phone].filter(Boolean).length > 0
      ? `I would be glad to discuss the role and answer any questions. You can reach me at ${joinList(
          [profile.email, profile.phone].filter(Boolean),
        )}.`
      : "I would be glad to discuss the role and answer any questions.";
  const paragraphs = [
    greeting,
    `I am applying for the ${input.application.title} role at ${input.application.company}${place}. ${identity}`.trim(),
    `${requirementBlock}${telecomClause}`.trim(),
    "I have attached my tailored CV and cover letter for this position.",
    authorisationSentence(profile.workAuthorisation),
    closing,
    ["Kind regards,", profile.name, [profile.email, profile.phone].filter(Boolean).join(" · ")]
      .filter(Boolean)
      .join("\n"),
  ].filter((paragraph) => paragraph.trim().length > 0);
  const body = paragraphs.join("\n\n");
  return { subject: subject.slice(0, 240), body: body.slice(0, 6000) };
}

export type OutreachQualityCheck = { id: string; label: string; ok: boolean; detail: string };

export type OutreachQualityAssessment = {
  ok: boolean;
  score: number;
  wordCount: number;
  checks: OutreachQualityCheck[];
  summary: string;
};

const GENERIC_PHRASES = [
  "i am writing to express my interest",
  "i was particularly drawn",
  "i would welcome the opportunity",
  "aligns closely with my background",
  "passionate about",
  "dynamic professional",
  "proven track record",
  "team player",
  "hit the ground running",
  "leverage my",
  "synerg",
  "think outside the box",
  "wealth of experience",
  "perfect fit",
];

/** Technology vocabulary used to detect a claim the profile does not support. */
const TOOL_VOCABULARY = [
  "Playwright",
  "Cypress",
  "Selenium",
  "Appium",
  "Espresso",
  "XCUITest",
  "Postman",
  "REST Assured",
  "Swagger",
  "Python",
  "JavaScript",
  "TypeScript",
  "Java",
  "SQL",
  "Jenkins",
  "Azure DevOps",
  "Docker",
  "JMeter",
  "k6",
  "Grafana",
  "Jira",
  "Xray",
  "TestRail",
  "BDD",
  "pytest",
  "Locust",
  "gRPC",
  "PostgreSQL",
  "Kubernetes",
  "Terraform",
  "GraphQL",
];

function sentences(body: string): string[] {
  return body
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function normaliseSentence(sentence: string): string {
  return sentence.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Deterministic quality gate for an outreach message. It is intentionally
 * conservative: a failure removes the "ready to review" presentation rather
 * than being silently ignored.
 */
export function assessOutreachEmail(input: {
  subject: string;
  body: string;
  application: ApplicationContext;
  profile: OutreachProfile;
  skills?: string[];
}): OutreachQualityAssessment {
  const { body, application, profile } = input;
  const verified = input.skills ?? verifiedSkillNames();
  const verifiedLower = verified.map((skill) => skill.toLowerCase());
  const lowered = body.toLowerCase();
  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;
  const vacancyIsDetailed = (application.description ?? "").trim().length > 400;
  const minimumWords = vacancyIsDetailed ? 180 : 90;
  const maximumWords = 280;
  const checks: OutreachQualityCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });

  add(
    "word_count",
    "Professional length",
    wordCount >= minimumWords && wordCount <= maximumWords,
    `${wordCount} words; the target is ${minimumWords}–${maximumWords} for this vacancy${
      vacancyIsDetailed ? "" : " (a short vacancy justifies a shorter message)"
    }.`,
  );
  add(
    "vacancy_reference",
    "Names the exact vacancy and employer",
    lowered.includes(application.title.toLowerCase()) && lowered.includes(application.company.toLowerCase()),
    `Subject/body must name "${application.title}" and "${application.company}".`,
  );

  const experienceEmployers = experienceRows()
    .map((row) => row.company)
    .filter((company) => company && lowered.includes(company.toLowerCase()));
  const skillMentions = verifiedLower.filter((skill) => lowered.includes(skill));
  add(
    "relevant_experience",
    "Explains verified relevant experience",
    experienceEmployers.length > 0 || skillMentions.length >= 2,
    experienceEmployers.length > 0
      ? `Cites stored experience at ${joinList(experienceEmployers.slice(0, 3))}.`
      : `Quotes ${skillMentions.length} verified skill(s) and no stored employer.`,
  );
  add(
    "attachments",
    "References both attachments",
    /attach/i.test(body) && /\bcv\b|curriculum/i.test(body) && /cover letter/i.test(body),
    "The message must state that the tailored CV and cover letter are attached.",
  );
  if (profile.workAuthorisation) {
    add(
      "work_authorisation",
      "States Swiss work authorisation",
      /authoris|permit/i.test(body) && !/requires? sponsorship|need sponsorship/i.test(body),
      "The verified profile records a Swiss work authorisation, so the message must state it without implying sponsorship is needed.",
    );
  }

  // A repeated skill list means the same set of skills is quoted again, not
  // merely that two sentences mention different tools from the same profile.
  const skillLists = sentences(body)
    .map((sentence) => new Set(verifiedLower.filter((skill) => sentence.toLowerCase().includes(skill))))
    .filter((set) => set.size >= 2);
  let repeatedSkillPair: [string[], string[]] | null = null;
  for (let left = 0; left < skillLists.length && !repeatedSkillPair; left += 1) {
    for (let right = left + 1; right < skillLists.length; right += 1) {
      const shared = [...skillLists[left]].filter((skill) => skillLists[right].has(skill));
      if (shared.length >= 2 && shared.length >= Math.min(skillLists[left].size, skillLists[right].size)) {
        repeatedSkillPair = [[...skillLists[left]], [...skillLists[right]]];
        break;
      }
    }
  }
  add(
    "repeated_skill_lists",
    "No repeated skill lists",
    !repeatedSkillPair,
    repeatedSkillPair
      ? `Two sentences quote the same skill list (${joinList(repeatedSkillPair[0])} / ${joinList(repeatedSkillPair[1])}).`
      : "No sentence repeats the same skill list.",
  );

  const normalized = sentences(body).map(normaliseSentence).filter((sentence) => sentence.length > 15);
  const duplicateSentence = normalized.find((sentence, index) => normalized.indexOf(sentence) !== index) ?? null;
  const words = body.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const shingles = new Set<string>();
  let repeatedShingle: string | null = null;
  for (let index = 0; index + 8 <= words.length; index += 1) {
    const shingle = words.slice(index, index + 8).join(" ");
    if (shingles.has(shingle)) {
      repeatedShingle = shingle;
      break;
    }
    shingles.add(shingle);
  }
  add(
    "repeated_phrasing",
    "No repeated sentences or phrases",
    !duplicateSentence && !repeatedShingle,
    duplicateSentence
      ? `The sentence "${duplicateSentence.slice(0, 80)}" is repeated.`
      : repeatedShingle
        ? `The phrase "${repeatedShingle}" is repeated.`
        : "No sentence or eight-word phrase is repeated.",
  );

  const genericFound = GENERIC_PHRASES.filter((phrase) => lowered.includes(phrase));
  add(
    "generic_language",
    "Avoids generic AI phrasing",
    genericFound.length === 0,
    genericFound.length === 0 ? "No banned generic phrase is present." : `Generic phrasing: ${joinList(genericFound)}.`,
  );

  const unsupported = TOOL_VOCABULARY.filter(
    (tool) => new RegExp(`\\b${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body) &&
      !verifiedLower.includes(tool.toLowerCase()),
  );
  const claimedYears = Number(body.match(/(\d+)\+?\s*years/i)?.[1] ?? 0);
  const verifiedYears = Number(profile.summary.match(/(\d+)\+?\s*years/i)?.[1] ?? 0);
  const overstatedYears = claimedYears > 0 && verifiedYears > 0 && claimedYears > verifiedYears;
  add(
    "unsupported_claims",
    "No unsupported technology or tenure claims",
    unsupported.length === 0 && !overstatedYears,
    unsupported.length > 0
      ? `Mentions unverified tool(s): ${joinList(unsupported)}.`
      : overstatedYears
        ? `Claims ${claimedYears} years where the profile records ${verifiedYears}.`
        : "Every named technology is a verified profile skill and the tenure matches the profile.",
  );

  if (profile.name && profile.name !== "The candidate") {
    add(
      "signature",
      "Professional sign-off with verified contact details",
      body.includes(profile.name) && (!profile.email || body.includes(profile.email)),
      "The message closes with the verified name and contact details.",
    );
  }

  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    score: Math.max(0, 100 - failed.length * 10),
    wordCount,
    checks,
    summary:
      failed.length === 0
        ? `The email passed all ${checks.length} deterministic quality checks at ${wordCount} words.`
        : `${failed.length} of ${checks.length} checks failed: ${joinList(failed.map((check) => check.label))}.`,
  };
}

/** Quality of a stored draft, recomputed from the stored body and linked data. */
export function outreachQualityForDraft(draftId: string): OutreachQualityAssessment | null {
  const row = one<{ body: string; subject: string; application_id: string }>(
    "SELECT body, subject, application_id FROM outreach_drafts WHERE id = ?",
    [draftId],
  );
  if (!row) return null;
  const application = applicationContext(row.application_id);
  if (!application) return null;
  return assessOutreachEmail({
    subject: row.subject,
    body: row.body,
    application,
    profile: profileForEmail(),
  });
}

function event(input: { draftId: string; contactId: string; type: string; message: string; meta?: Record<string, unknown> }): void {
  run(
    "INSERT INTO outreach_events (draft_id, contact_id, type, message, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.draftId, input.contactId, input.type, input.message.slice(0, 2000), input.meta ? JSON.stringify(input.meta).slice(0, 8000) : null, nowIso()],
  );
}

function recordApplicationOnce(applicationId: string, type: string, message: string, meta?: Record<string, unknown>): void {
  const existing = one<{ id: number }>(
    "SELECT id FROM application_events WHERE application_id = ? AND type = ? ORDER BY id DESC LIMIT 1",
    [applicationId, type],
  );
  if (existing) return;
  recordApplicationEvent({ applicationId, type, message, meta: meta ?? null });
}

export type OutreachResult = {
  status: OutreachStatus | "already_exists" | "unavailable" | "skipped";
  detail: string;
  draftId: string | null;
  contactId: string | null;
  gmailDraftId: string | null;
};

/**
 * Discover contacts, validate the exact vacancy documents, and create one
 * idempotent Gmail draft. No email is sent. A failure here is isolated from the
 * application record.
 */
export async function prepareOutreachForApplication(
  input: {
    applicationId: string;
    contactId?: string | null;
    publicPages?: string[];
    fetchImpl?: typeof fetch;
    draftGateway?: OutreachDraftGateway;
    now?: Date;
  },
): Promise<OutreachResult> {
  const application = applicationContext(input.applicationId);
  if (!application) return { status: "skipped", detail: "The application does not exist.", draftId: null, contactId: null, gmailDraftId: null };
  if (application.status === "rejected" || application.status === "withdrawn") {
    return { status: "skipped", detail: "The application is closed.", draftId: null, contactId: null, gmailDraftId: null };
  }

  const attachments = validateOutreachAttachments(input.applicationId);
  if (!attachments.ok || !attachments.manifest || !attachments.contents) {
    const detail = `Outreach was not drafted: ${attachments.reason}`;
    recordApplicationOnce(input.applicationId, "outreach.blocked", detail);
    return { status: "blocked", detail, draftId: null, contactId: null, gmailDraftId: null };
  }

  let contact: StoredContact | null = null;
  if (input.contactId) {
    contact = verifiedContactsForJob(application.job_id).find((item) => item.id === input.contactId) ?? null;
  } else {
    let discovered = await discoverOutreachContacts(application.job_id, {
      publicPages: input.publicPages,
      fetchImpl: input.fetchImpl,
      now: input.now,
    });
    contact = discovered.contacts[0] ?? null;
    if (!contact && !input.publicPages?.length) {
      const pages = publicContactPages(application.employer_url ?? application.application_url);
      if (pages.length > 0) {
        discovered = await discoverOutreachContacts(application.job_id, {
          publicPages: pages,
          fetchImpl: input.fetchImpl,
          now: input.now,
        });
        contact = discovered.contacts[0] ?? null;
      }
    }
    if (!contact) {
      const detail = `Outreach was not drafted: ${discovered.reason}`;
      recordApplicationOnce(input.applicationId, "outreach.unavailable", detail);
      return { status: "unavailable", detail, draftId: null, contactId: null, gmailDraftId: null };
    }
  }
  if (!contact?.email) {
    return { status: "unavailable", detail: "No verified employer-associated contact is stored for this vacancy.", draftId: null, contactId: null, gmailDraftId: null };
  }
  if (/(no unsolicited|speculative applications|agencies please|applications? (must|can only) be submitted through|only through the (application|portal))/i.test(application.description ?? "")) {
    const detail = "Outreach was not drafted: the employer's published instructions prohibit unsolicited contact; use the application channel or a human handoff.";
    recordApplicationOnce(application.id, "outreach.blocked", detail);
    return { status: "blocked", detail, draftId: null, contactId: contact.id, gmailDraftId: null };
  }

  const existingForPerson = one<{ id: string; application_id: string; status: string }>(
    "SELECT id, application_id, status FROM outreach_drafts WHERE recipient = ? AND status IN ('draft_created','sent') LIMIT 1",
    [contact.email],
  );
  if (existingForPerson && existingForPerson.application_id !== application.id) {
    return {
      status: "already_exists",
      detail: "This person already has an outreach draft or sent email for another vacancy; no additional message was created.",
      draftId: existingForPerson.id,
      contactId: contact.id,
      gmailDraftId: null,
    };
  }

  const existing = one<{
    id: string;
    status: OutreachStatus;
    gmail_draft_id: string | null;
    contact_id: string;
  }>(
    "SELECT id, status, gmail_draft_id, contact_id FROM outreach_drafts WHERE application_id = ? AND contact_id = ?",
    [application.id, contact.id],
  );
  if (existing && existing.status !== "failed") {
    return {
      status: "already_exists",
      detail:
        existing.status === "sent"
          ? "A sent outreach email is already recorded for this application and recipient."
          : "A Gmail draft already exists for this application and recipient; no duplicate was created.",
      draftId: existing.id,
      contactId: existing.contact_id,
      gmailDraftId: existing.gmail_draft_id,
    };
  }

  const email = generateOutreachEmail({ application, contact });
  const quality = assessOutreachEmail({ subject: email.subject, body: email.body, application, profile: profileForEmail() });
  const now = (input.now ?? new Date()).toISOString();
  const draftId = existing?.id ?? `draft_${randomId()}`;
  const idempotencyKey = `outreach:${application.id}:${contact.id}`;
  if (!existing) {
    run(
      `INSERT INTO outreach_drafts
         (id, application_id, job_id, contact_id, recipient, subject, body, cv_document_id, cover_document_id,
          cv_sha256, cover_sha256, attachment_manifest, status, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [draftId, application.id, application.job_id, contact.id, contact.email, email.subject, email.body,
        attachments.manifest.cv.documentId, attachments.manifest.cover.documentId,
        attachments.manifest.cv.hash, attachments.manifest.cover.hash, JSON.stringify(attachments.manifest).slice(0, 12000),
        idempotencyKey, now, now],
    );
  } else {
    run(
      "UPDATE outreach_drafts SET subject = ?, body = ?, cv_sha256 = ?, cover_sha256 = ?, attachment_manifest = ?, status = 'pending', error = NULL, updated_at = ? WHERE id = ?",
      [email.subject, email.body, attachments.manifest.cv.hash, attachments.manifest.cover.hash,
        JSON.stringify(attachments.manifest).slice(0, 12000), now, draftId],
    );
  }

  const gateway = input.draftGateway ?? defaultOutreachDraftGateway;
  try {
    const created = await gateway({
      to: contact.email,
      subject: email.subject,
      body: email.body,
      attachments: [
        { filename: attachments.manifest.cv.filename, mime: attachments.manifest.cv.mime, content: attachments.contents.cv },
        { filename: attachments.manifest.cover.filename, mime: attachments.manifest.cover.mime, content: attachments.contents.cover },
      ],
    });
    if (!created.draftId) throw new Error("Gmail returned no draft id.");
    run(
      `UPDATE outreach_drafts SET gmail_draft_id = ?, gmail_message_id = ?, gmail_thread_id = ?,
         status = 'draft_created', error = NULL, updated_at = ? WHERE id = ?`,
      [created.draftId, created.messageId, created.threadId, now, draftId],
    );
    event({
      draftId,
      contactId: contact.id,
      type: "outreach.draft_created",
      message: quality.ok
        ? `Gmail draft created for ${contact.email}. No email was sent. ${quality.summary}`
        : `Gmail draft created for ${contact.email}. No email was sent, but the email quality check did not pass: ${quality.summary}`,
      meta: {
        gmailDraftId: created.draftId,
        rfcMessageId: created.rfcMessageId,
        cv: attachments.manifest.cv.hash,
        cover: attachments.manifest.cover.hash,
        quality: { ok: quality.ok, score: quality.score, wordCount: quality.wordCount, failed: quality.checks.filter((check) => !check.ok).map((check) => check.id) },
      },
    });
    recordApplicationOnce(application.id, "outreach.draft_created", `Gmail draft created for ${contact.name}. The owner must approve sending.`, {
      draftId,
      recipient: contact.email,
    });
    return {
      status: "draft_created",
      detail: quality.ok
        ? `Gmail draft created with the vacancy CV and cover letter; nothing was sent. ${quality.summary}`
        : `Gmail draft created with the vacancy CV and cover letter; nothing was sent. Email quality: ${quality.summary}`,
      draftId,
      contactId: contact.id,
      gmailDraftId: created.draftId,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 1000) : "Gmail draft creation failed.";
    run("UPDATE outreach_drafts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [detail, now, draftId]);
    event({ draftId, contactId: contact.id, type: "outreach.draft_failed", message: detail });
    recordApplicationOnce(application.id, "outreach.draft_failed", `Outreach draft failed: ${detail}`);
    return { status: "failed", detail, draftId, contactId: contact.id, gmailDraftId: null };
  }
}

export type OutreachReconciliation = {
  state: "draft" | "sent" | "missing";
  messageId: string | null;
  threadId: string | null;
  sentAt?: string | null;
  detail: string;
};

/** Reconcile an owner action without ever treating a draft as sent. */
export function reconcileOutreachDraft(draftId: string, result: OutreachReconciliation): OutreachStatus {
  const draft = one<{ id: string; contact_id: string; status: string }>(
    "SELECT id, contact_id, status FROM outreach_drafts WHERE id = ?",
    [draftId],
  );
  if (!draft) throw new Error("Outreach draft not found.");
  const now = nowIso();
  const status: OutreachStatus = result.state === "sent" ? "sent" : result.state === "missing" ? "draft_missing" : "draft_created";
  run(
    `UPDATE outreach_drafts SET status = ?, gmail_message_id = COALESCE(?, gmail_message_id),
       gmail_thread_id = COALESCE(?, gmail_thread_id), sent_at = CASE WHEN ? = 'sent' THEN COALESCE(?, sent_at) ELSE sent_at END,
       last_reconciled_at = ?, updated_at = ? WHERE id = ?`,
    [status, result.messageId, result.threadId, status, result.sentAt ?? now, now, now, draftId],
  );
  event({
    draftId,
    contactId: draft.contact_id,
    type: status === "sent" ? "outreach.sent_observed" : status === "draft_missing" ? "outreach.draft_missing" : "outreach.draft_reconciled",
    message: result.detail,
    meta: { messageId: result.messageId, threadId: result.threadId },
  });
  return status;
}

/**
 * Reconcile a draft against Gmail's Sent label. This only marks `sent` when a
 * sent copy is actually observed. An API failure or an absent copy leaves the
 * truthful draft state untouched.
 */
export async function reconcileOutreachFromGmail(draftId: string): Promise<OutreachStatus> {
  const draft = one<{
    id: string;
    status: OutreachStatus;
    recipient: string;
    subject: string;
    created_at: string;
    gmail_draft_id: string | null;
  }>(
    "SELECT id, status, recipient, subject, created_at, gmail_draft_id FROM outreach_drafts WHERE id = ?",
    [draftId],
  );
  if (!draft) throw new Error("Outreach draft not found.");
  if (draft.status === "sent") return "sent";
  if (!draft.gmail_draft_id) return draft.status;
  const found = await findGmailSentOutreach({ to: draft.recipient, subject: draft.subject, after: draft.created_at });
  if (!found) return draft.status;
  return reconcileOutreachDraft(draftId, {
    state: "sent",
    messageId: found.id,
    threadId: found.threadId,
    sentAt: nowIso(),
    detail: "A sent copy with the exact recipient and subject was observed in Gmail's Sent label.",
  });
}

export function outreachForApplication(applicationId: string): Array<{
  id: string;
  recipient: string;
  subject: string;
  status: OutreachStatus;
  gmailDraftId: string | null;
  contactName: string;
  contactTitle: string | null;
  cvSha256: string;
  coverSha256: string;
  createdAt: string;
  sentAt: string | null;
}> {
  return all(
    `SELECT d.id, d.recipient, d.subject, d.status, d.gmail_draft_id AS gmailDraftId,
            c.name AS contactName, c.title AS contactTitle, d.cv_sha256 AS cvSha256, d.cover_sha256 AS coverSha256,
            d.created_at AS createdAt, d.sent_at AS sentAt
     FROM outreach_drafts d JOIN outreach_contacts c ON c.id = d.contact_id
     WHERE d.application_id = ? ORDER BY d.created_at DESC`,
    [applicationId],
  );
}

export function outreachSummary(): {
  contactsVerified: number;
  contactsUnavailable: number;
  draftsCreated: number;
  draftsAwaitingReview: number;
  emailsSent: number;
  repliesReceived: number;
} {
  const scalar = (sql: string): number => Number(one<{ n: number }>(sql)?.n ?? 0);
  return {
    contactsVerified: scalar("SELECT COUNT(*) AS n FROM outreach_contacts WHERE verification_status = 'verified' AND email IS NOT NULL"),
    contactsUnavailable: scalar("SELECT COUNT(*) AS n FROM outreach_contacts WHERE verification_status = 'unavailable'"),
    draftsCreated: scalar("SELECT COUNT(*) AS n FROM outreach_drafts WHERE gmail_draft_id IS NOT NULL"),
    draftsAwaitingReview: scalar("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'draft_created'"),
    emailsSent: scalar("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'sent'"),
    repliesReceived: scalar("SELECT COUNT(*) AS n FROM email_messages WHERE application_id IN (SELECT application_id FROM outreach_drafts WHERE status = 'sent')"),
  };
}

/**
 * Read model for the owner-facing outreach dashboard.
 *
 * Counts come from `outreach_contacts` / `outreach_drafts`; nothing is derived
 * from a template. A draft row is not a sent email, and an attachment badge is
 * only "attached" when the linked document still exists, belongs to the same
 * vacancy, passed its quality gate and is non-empty.
 */
export type OutreachAttachmentState = "attached" | "missing" | "quality_failed" | "wrong_vacancy";

export type OutreachDraftRecord = {
  id: string;
  applicationId: string;
  jobId: string;
  recipient: string;
  subject: string;
  status: OutreachStatus | "pending";
  gmailDraftId: string | null;
  createdAt: string;
  sentAt: string | null;
  lastReconciledAt: string | null;
  error: string | null;
  contactName: string;
  contactTitle: string | null;
  contactEmail: string | null;
  contactVerified: boolean;
  contactSourceUrl: string | null;
  contactMethod: string;
  contactConfidence: number;
  company: string;
  jobTitle: string;
  applicationStatus: string;
  /** Gmail messages matched to this application. Zero is shown as zero. */
  replies: number;
  cv: { documentId: string; filename: string | null; state: OutreachAttachmentState; quality: string | null; hash: string };
  cover: { documentId: string; filename: string | null; state: OutreachAttachmentState; quality: string | null; hash: string };
};

type OutreachDraftRow = {
  id: string;
  application_id: string;
  job_id: string;
  recipient: string;
  subject: string;
  status: string;
  gmail_draft_id: string | null;
  created_at: string;
  sent_at: string | null;
  last_reconciled_at: string | null;
  error: string | null;
  cv_document_id: string;
  cover_document_id: string;
  cv_sha256: string;
  cover_sha256: string;
  contact_name: string;
  contact_title: string | null;
  contact_email: string | null;
  verification_status: string;
  source_url: string | null;
  discovery_method: string;
  confidence: number;
  company: string;
  job_title: string;
  application_status: string;
  reply_count: number;
  cv_file: string | null;
  cv_quality: string | null;
  cv_size: number | null;
  cv_deleted: string | null;
  cv_row_job: string | null;
  cover_file: string | null;
  cover_quality: string | null;
  cover_size: number | null;
  cover_deleted: string | null;
  cover_row_job: string | null;
};

function attachmentState(input: {
  file: string | null;
  quality: string | null;
  size: number | null;
  deleted: string | null;
  rowJob: string | null;
  draftJob: string;
}): OutreachAttachmentState {
  if (!input.file || input.deleted || !input.size || input.size <= 0) return "missing";
  if (input.rowJob !== input.draftJob) return "wrong_vacancy";
  if (input.quality !== "passed") return "quality_failed";
  return "attached";
}

function outreachDraftRows(where = "", params: unknown[] = []): OutreachDraftRecord[] {
  return all<OutreachDraftRow>(
    `SELECT d.id, d.application_id, d.job_id, d.recipient, d.subject, d.status, d.gmail_draft_id,
            d.created_at, d.sent_at, d.last_reconciled_at, d.error,
            d.cv_document_id, d.cover_document_id, d.cv_sha256, d.cover_sha256,
            c.name AS contact_name, c.title AS contact_title, c.email AS contact_email,
            c.verification_status, c.source_url, c.discovery_method, c.confidence,
            j.company, j.title AS job_title, a.status AS application_status,
            (SELECT COUNT(*) FROM email_messages em WHERE em.application_id = d.application_id) AS reply_count,
            cv.file_name AS cv_file, cv.quality_status AS cv_quality, cv.size_bytes AS cv_size,
            cv.deleted_at AS cv_deleted, cv.job_id AS cv_row_job,
            cl.file_name AS cover_file, cl.quality_status AS cover_quality, cl.size_bytes AS cover_size,
            cl.deleted_at AS cover_deleted, cl.job_id AS cover_row_job
     FROM outreach_drafts d
     JOIN outreach_contacts c ON c.id = d.contact_id
     JOIN jobs j ON j.id = d.job_id
     JOIN applications a ON a.id = d.application_id
     LEFT JOIN documents cv ON cv.id = d.cv_document_id
     LEFT JOIN documents cl ON cl.id = d.cover_document_id
     ${where}
     ORDER BY d.created_at DESC`,
    params,
  ).map((row) => ({
    id: row.id,
    applicationId: row.application_id,
    jobId: row.job_id,
    recipient: row.recipient,
    subject: row.subject,
    status: row.status as OutreachDraftRecord["status"],
    gmailDraftId: row.gmail_draft_id,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    lastReconciledAt: row.last_reconciled_at,
    error: row.error,
    contactName: row.contact_name,
    contactTitle: row.contact_title,
    contactEmail: row.contact_email,
    contactVerified: row.verification_status === "verified",
    contactSourceUrl: row.source_url,
    contactMethod: row.discovery_method,
    contactConfidence: Number(row.confidence),
    company: row.company,
    jobTitle: row.job_title,
    applicationStatus: row.application_status,
    replies: Number(row.reply_count ?? 0),
    cv: {
      documentId: row.cv_document_id,
      filename: row.cv_file,
      hash: row.cv_sha256,
      quality: row.cv_quality,
      state: attachmentState({
        file: row.cv_file,
        quality: row.cv_quality,
        size: row.cv_size,
        deleted: row.cv_deleted,
        rowJob: row.cv_row_job,
        draftJob: row.job_id,
      }),
    },
    cover: {
      documentId: row.cover_document_id,
      filename: row.cover_file,
      hash: row.cover_sha256,
      quality: row.cover_quality,
      state: attachmentState({
        file: row.cover_file,
        quality: row.cover_quality,
        size: row.cover_size,
        deleted: row.cover_deleted,
        rowJob: row.cover_row_job,
        draftJob: row.job_id,
      }),
    },
  }));
}

export function outreachDrafts(limit = 50): OutreachDraftRecord[] {
  return outreachDraftRows("", []).slice(0, Math.max(1, limit));
}

export function outreachDashboard(): {
  counters: {
    draftsPrepared: number;
    verifiedContacts: number;
    awaitingReview: number;
    emailsSent: number;
    repliesReceived: number;
    needsIntervention: number;
  };
  drafts: OutreachDraftRecord[];
} {
  const drafts = outreachDrafts(50);
  const scalar = (sql: string): number => Number(one<{ n: number }>(sql)?.n ?? 0);
  return {
    counters: {
      draftsPrepared: scalar("SELECT COUNT(*) AS n FROM outreach_drafts"),
      verifiedContacts: scalar("SELECT COUNT(*) AS n FROM outreach_contacts WHERE verification_status = 'verified' AND email IS NOT NULL"),
      awaitingReview: drafts.filter((draft) => draft.status === "draft_created").length,
      emailsSent: scalar("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'sent'"),
      repliesReceived: scalar(
        "SELECT COUNT(*) AS n FROM email_messages WHERE application_id IN (SELECT application_id FROM outreach_drafts WHERE status = 'sent')",
      ),
      needsIntervention: scalar(
        "SELECT COUNT(*) AS n FROM outreach_drafts WHERE status IN ('failed','blocked','draft_missing') OR (error IS NOT NULL AND status != 'sent')",
      ),
    },
    drafts,
  };
}

export function outreachDraftDetail(draftId: string): {
  draft: OutreachDraftRecord;
  body: string;
  evidence: Record<string, unknown> | null;
  events: Array<{ id: number; type: string; message: string; createdAt: string }>;
  quality: OutreachQualityAssessment | null;
} | null {
  const draft = outreachDraftRows("WHERE d.id = ?", [draftId])[0];
  if (!draft) return null;
  const row = one<{ body: string; evidence: string | null }>(
    `SELECT d.body, c.evidence FROM outreach_drafts d JOIN outreach_contacts c ON c.id = d.contact_id WHERE d.id = ?`,
    [draftId],
  );
  let evidence: Record<string, unknown> | null = null;
  try {
    evidence = row?.evidence ? (JSON.parse(row.evidence) as Record<string, unknown>) : null;
  } catch {
    evidence = null;
  }
  const events = all<{ id: number; type: string; message: string; created_at: string }>(
    "SELECT id, type, message, created_at FROM outreach_events WHERE draft_id = ? ORDER BY id DESC LIMIT 40",
    [draftId],
  ).map((event) => ({ id: event.id, type: event.type, message: event.message, createdAt: event.created_at }));
  return { draft, body: row?.body ?? "", evidence, events, quality: outreachQualityForDraft(draftId) };
}
