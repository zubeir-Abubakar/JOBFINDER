import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from "docx";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { JobAnalysis } from "./scoring";
import { skillLevelLabel, type ProfileData, type Skill } from "./profile";

export type DocModel = {
  kind: "cv" | "cover_letter";
  title: string;
  subtitle: string;
  contact: string[];
  sections: Array<{ heading: string; paragraphs: string[]; bullets: string[] }>;
  letterDate?: string;
  addressee?: string[];
};

export type JobLike = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  description: string | null;
  remote: number | boolean;
  url?: string | null;
  analysis?: string | null;
};

function dateLabel(value: string | null): string {
  if (!value) return "";
  const match = value.match(/^(\d{4})-(\d{2})/);
  if (!match) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(match[2]) - 1]} ${match[1]}`;
}

function period(start: string | null, end: string | null, isCurrent: number): string | null {
  if (!start && !end && !isCurrent) return null;
  const from = start ? dateLabel(start) : "Date to confirm";
  const to = isCurrent ? "Present" : end ? dateLabel(end) : "Date to confirm";
  return `${from} – ${to}`;
}

function safeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "_")
    .slice(0, 52);
}

export function documentFileBase(profile: ProfileData, job: JobLike, kind: "cv" | "cover_letter", version: string): string {
  const name = safeSlug(profile.profile.full_name || "Candidate");
  const role = safeSlug(job.title);
  const company = safeSlug(job.company);
  const suffix = kind === "cv" ? "CV" : "Cover_Letter";
  return `${name}_${role}_${company}_${suffix}_v${version.replace(/\./g, "_")}`;
}

const MAX_MATCHED_SKILLS = 14;

export function buildCvModel(profile: ProfileData, job: JobLike, analysis: JobAnalysis | null): DocModel {
  const p = profile.profile;
  const verifiedSkills = profile.skills;
  const matchedSet = new Set(analysis?.matched ?? []);
  const prioritised = verifiedSkills.filter((s) => matchedSet.has(s.name));
  const ordered = [...prioritised, ...verifiedSkills.filter((s) => !matchedSet.has(s.name))];
  const core = ordered.slice(0, MAX_MATCHED_SKILLS);

  const contact = [p.location, p.email, p.phone, p.linkedin, p.website].filter(Boolean) as string[];
  if (p.work_authorisation) {
    contact.push(p.permit_valid_until ? `${p.work_authorisation} (valid until ${dateLabel(p.permit_valid_until)})` : p.work_authorisation);
  }

  const summaryParts: string[] = [];
  if (p.summary) summaryParts.push(p.summary);
  const roleContext = `Targeting the ${job.title} role at ${job.company}${job.location ? ` in ${job.location}` : ""}.`;
  summaryParts.push(roleContext);
  const relevant = prioritised.filter((s) => s.level !== "exposure").map((s) => s.name).slice(0, 6);
  if (relevant.length > 0) {
    summaryParts.push(`Directly relevant, verified strengths: ${relevant.join(", ")}.`);
  }
  if (job.company) {
    const fintech = /fintech|payment|bank|financial|insurance/i.test(job.description ?? "");
    if (fintech) summaryParts.push("Fintech and payment-systems experience is directly applicable to this role.");
  }

  const expertiseByCategory = new Map<string, Skill[]>();
  for (const skill of core) {
    const list = expertiseByCategory.get(skill.category) ?? [];
    list.push(skill);
    expertiseByCategory.set(skill.category, list);
  }

  const skillParagraphs: string[] = [];
  for (const [category, list] of expertiseByCategory) {
    skillParagraphs.push(
      `${category}: ${list.map((s) => (s.level === "exposure" ? `${s.name} (exposure)` : s.name)).join(", ")}`,
    );
  }

  const experienceParagraphs: string[] = [];
  const experienceBullets: string[] = [];
  for (const exp of profile.experiences) {
    const headingLine = `${exp.title} — ${exp.company}`;
    const meta = [period(exp.start_date, exp.end_date, exp.is_current), exp.location].filter(Boolean).join(" · ");
    experienceParagraphs.push(meta ? `${headingLine} (${meta})` : headingLine);
    if (exp.summary) experienceBullets.push(exp.summary);
    try {
      const achievements = JSON.parse(exp.achievements ?? "[]");
      if (Array.isArray(achievements)) {
        for (const bullet of achievements) if (typeof bullet === "string" && bullet.trim()) experienceBullets.push(bullet.trim());
      }
    } catch {}
  }

  const sections: DocModel["sections"] = [
    { heading: "Professional summary", paragraphs: [summaryParts.join(" ")], bullets: [] },
    { heading: "Core skills", paragraphs: skillParagraphs, bullets: [] },
    {
      heading: "Professional experience",
      paragraphs: experienceParagraphs.length ? experienceParagraphs : ["Employment history is held in the master profile."],
      bullets: experienceBullets,
    },
  ];

  const education = profile.items.filter((i) => i.kind === "education" || i.kind === "certification");
  if (education.length > 0) {
    sections.push({
      heading: "Education & certifications",
      paragraphs: education.map((i) => [i.title, i.subtitle, i.end_date ?? i.start_date].filter(Boolean).join(" · ")),
      bullets: [],
    });
  }
  if (profile.languages.length > 0) {
    sections.push({ heading: "Languages", paragraphs: [profile.languages.join(" · ")], bullets: [] });
  }
  const projects = profile.items.filter((i) => i.kind === "project" || i.kind === "achievement");
  if (projects.length > 0) {
    sections.push({
      heading: "Selected projects & achievements",
      paragraphs: projects.map((i) => `${i.title}${i.subtitle ? ` — ${i.subtitle}` : ""}${i.detail ? `: ${i.detail}` : ""}`),
      bullets: [],
    });
  }

  return {
    kind: "cv",
    title: p.full_name || "Curriculum Vitae",
    subtitle: p.headline || "",
    contact,
    sections,
  };
}

export function buildCoverLetterModel(profile: ProfileData, job: JobLike, analysis: JobAnalysis | null): DocModel {
  const p = profile.profile;
  const matched = (analysis?.matched ?? []).filter((name) => {
    const skill = profile.skills.find((s) => s.name === name);
    return !skill || skill.level !== "exposure";
  });
  const stack = matched.slice(0, 5);

  const opening = `I am writing to apply for the ${job.title} position at ${job.company}${job.location ? `, based in ${job.location}` : ""}. I am a senior QA engineer based in Switzerland with more than five years of experience in software quality assurance across fintech, mobile and web products.`;

  const evidence: string[] = [];
  if (stack.length > 0) {
    evidence.push(`My day-to-day work covers ${stack.join(", ")}, together with API, integration and end-to-end testing.`);
  } else {
    evidence.push("My work covers test automation, API, integration and end-to-end testing for mobile and web products.");
  }
  evidence.push(
    "I have built and maintained automation frameworks, led test planning, test strategy and release-readiness decisions, and worked closely with engineering and product teams to turn defect data into shipping decisions.",
  );
  if (/fintech|payment|bank|financial|insurance/i.test(`${job.description ?? ""}`)) {
    evidence.push("That work has been concentrated in financial technology and payment systems, where accuracy, auditability and release confidence matter more than raw test volume.");
  }

  const roleSpecific: string[] = [];
  if (analysis?.yearsRequired) {
    roleSpecific.push(`Your posting asks for ${analysis.yearsRequired} years of relevant experience, which aligns with my background.`);
  }
  if (analysis?.missing?.length) {
    roleSpecific.push(
      `I have not worked with ${analysis.missing.slice(0, 3).join(", ")} in production; my framework experience is concentrated in the stack listed in my CV, and I would approach any new tooling from that foundation.`,
    );
  }
  roleSpecific.push(
    `I would bring a testing perspective grounded in measurable risk: clear test strategy, maintainable automation, and honest release reporting for the ${job.company} team.`,
  );

  const authorisation = p.work_authorisation
    ? `I hold a ${p.work_authorisation.replace(/^Swiss /, "Swiss ")} valid until February 2028 and do not require employer sponsorship to work in Switzerland.`
    : "I am based in Switzerland and available to discuss work authorisation directly.";

  const contact = [p.location, p.email, p.phone].filter(Boolean) as string[];

  return {
    kind: "cover_letter",
    title: p.full_name || "Cover letter",
    subtitle: p.headline || "",
    contact,
    letterDate: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    addressee: ["Hiring Team", job.company, job.location ?? ""].filter(Boolean),
    sections: [
      { heading: "salutation", paragraphs: [`Dear ${job.company} Hiring Team,`], bullets: [] },
      { heading: "Re: " + job.title, paragraphs: [opening], bullets: [] },
      { heading: "Relevant experience", paragraphs: evidence, bullets: [] },
      { heading: "Why this role", paragraphs: roleSpecific, bullets: [] },
      { heading: "Work authorisation", paragraphs: [authorisation], bullets: [] },
      {
        heading: "closing",
        paragraphs: [
          "I would welcome the opportunity to discuss how this experience maps to your requirements. Thank you for your time and consideration.",
          "Sincerely,",
          p.full_name || "",
        ],
        bullets: [],
      },
    ],
  };
}

export function modelToText(model: DocModel): string {
  const lines: string[] = [model.title];
  if (model.subtitle) lines.push(model.subtitle);
  if (model.contact.length) lines.push(model.contact.join(" · "));
  if (model.letterDate) lines.push(model.letterDate);
  if (model.addressee?.length) lines.push("", ...model.addressee);
  for (const section of model.sections) {
    lines.push("");
    if (!["salutation", "closing"].includes(section.heading) && !section.heading.startsWith("Re:")) {
      lines.push(section.heading.toUpperCase());
    }
    for (const paragraph of section.paragraphs) lines.push(paragraph);
    for (const bullet of section.bullets) lines.push(`• ${bullet}`);
  }
  return lines.join("\n");
}

export async function renderDocx(model: DocModel): Promise<Buffer> {
  const children: Paragraph[] = [];
  children.push(
    new Paragraph({
      children: [new TextRun({ text: model.title, bold: true, size: 36 })],
      spacing: { after: 60 },
    }),
  );
  if (model.subtitle) {
    children.push(new Paragraph({ children: [new TextRun({ text: model.subtitle, size: 22, color: "555555" })], spacing: { after: 60 } }));
  }
  if (model.contact.length) {
    children.push(new Paragraph({ children: [new TextRun({ text: model.contact.join("  ·  "), size: 19, color: "444444" })], spacing: { after: 40 } }));
  }
  for (const line of [model.letterDate, ...(model.addressee ?? [])]) {
    if (line) children.push(new Paragraph({ children: [new TextRun({ text: line, size: 21 })], spacing: { after: 40 } }));
  }
  if (model.letterDate) children.push(new Paragraph({ text: "" }));

  for (const section of model.sections) {
    const plain = ["salutation", "closing"].includes(section.heading) || section.heading.startsWith("Re:");
    if (!plain) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: section.heading.toUpperCase(), bold: true, size: 22 })],
          spacing: { before: 200, after: 80 },
          border: { bottom: { color: "DDDDDD", size: 4, space: 2, style: "single" } },
        }),
      );
    }
    for (const paragraph of section.paragraphs) {
      if (!paragraph) continue;
      children.push(new Paragraph({ children: [new TextRun({ text: paragraph, size: 21 })], spacing: { after: 100 }, alignment: AlignmentType.LEFT }));
    }
    for (const bullet of section.bullets) {
      children.push(new Paragraph({ text: bullet, bullet: { level: 0 }, spacing: { after: 60 } }));
    }
  }

  const doc = new Document({
    creator: model.title,
    title: model.title,
    description: "Generated by AT AI Workforce from the verified professional profile",
    sections: [{ properties: { page: { margin: { top: 800, bottom: 800, left: 850, right: 850 } } }, children }],
  });
  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}

function asciiSafe(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = asciiSafe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export async function renderPdf(model: DocModel): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 54;
  const maxWidth = pageWidth - margin * 2;
  let page: PDFPage = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ensureSpace = (needed: number) => {
    if (y - needed < margin) {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };
  const write = (text: string, options: { font?: PDFFont; size?: number; gap?: number; color?: [number, number, number] } = {}) => {
    const usedFont = options.font ?? font;
    const size = options.size ?? 9.6;
    const lineHeight = size * 1.42;
    for (const line of wrap(text, usedFont, size, maxWidth)) {
      ensureSpace(lineHeight);
      page.drawText(line, { x: margin, y: y - size, size, font: usedFont, color: rgb(...(options.color ?? [0.12, 0.13, 0.15])) });
      y -= lineHeight;
    }
    y -= options.gap ?? 0;
  };

  write(model.title, { font: bold, size: 20, gap: 2 });
  if (model.subtitle) write(model.subtitle, { size: 10, color: [0.36, 0.38, 0.4], gap: 2 });
  if (model.contact.length) write(model.contact.join("  ·  "), { size: 8.8, color: [0.33, 0.35, 0.38], gap: 6 });
  for (const line of [model.letterDate, ...(model.addressee ?? [])]) {
    if (line) write(line, { size: 9.6 });
  }
  if (model.letterDate) y -= 6;

  for (const section of model.sections) {
    const plain = ["salutation", "closing"].includes(section.heading) || section.heading.startsWith("Re:");
    if (!plain) {
      ensureSpace(26);
      y -= 8;
      write(section.heading.toUpperCase(), { font: bold, size: 9.4, gap: 3, color: [0.07, 0.34, 0.28] });
      page.drawLine({ start: { x: margin, y: y + 1 }, end: { x: pageWidth - margin, y: y + 1 }, thickness: 0.6, color: rgb(0.85, 0.86, 0.84) });
      y -= 5;
    }
    for (const paragraph of section.paragraphs) {
      if (paragraph) write(paragraph, { gap: 4 });
    }
    for (const bullet of section.bullets) {
      write(`•  ${bullet}`, { gap: 1 });
    }
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

export function jobFromRow(row: Record<string, unknown>): JobLike {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    company: String(row.company ?? ""),
    location: (row.location as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    remote: Number(row.remote ?? 0),
    url: (row.url as string | null) ?? null,
    analysis: (row.analysis as string | null) ?? null,
  };
}

export function skillSummary(skills: Skill[]): string {
  return skills.map((s) => `${s.name} (${skillLevelLabel(s.level)})`).join(", ");
}
