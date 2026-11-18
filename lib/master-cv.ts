import { readFile } from "node:fs/promises";
import path from "node:path";
import { one, UPLOAD_DIR } from "./db";
import { extractText } from "./extract";
import { formatLanguageEntries, getProfileData, hasSpecifiedLanguageLevels, type Experience, type ProfileData } from "./profile";

/**
 * The uploaded CV is the master document. This parser keeps every employment
 * entry, bullet, certification, education line and language it can identify.
 * The verified profile is used only to fill gaps, never to replace the upload.
 */
export type MasterRole = {
  key: string;
  title: string;
  company: string;
  location: string | null;
  dates: string;
  bullets: string[];
  note: string | null;
  /** Optional paragraph before bullets; populated from the editable profile. */
  summary?: string | null;
  /** Optional projects/technical details paragraph from the editor. */
  projects?: string | null;
};

export type MasterSkillGroup = {
  label: string;
  values: string[];
};

export type MasterEducation = {
  title: string;
  date: string | null;
  institution: string | null;
};

export type MasterCv = {
  sourceId: string | null;
  sourceName: string;
  sourceText: string;
  name: string;
  headline: string;
  contact: string[];
  permit: string | null;
  summary: string;
  skillGroups: MasterSkillGroup[];
  roles: MasterRole[];
  certifications: string[];
  education: MasterEducation[];
  languages: string;
  wordCount: number;
  parsedFrom: "original" | "profile";
};

type DocumentRow = {
  id: string;
  file_name: string;
  relative_path: string;
  text_content: string | null;
};

const MONTHS =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DATE_RANGE = `${MONTHS}\\s+\\d{4}\\s*[–—\\-]\\s*(?:${MONTHS}\\s+\\d{4}|Present|Current)(?:\\s*\\([^)]*\\))?`;
const ROLE_START = new RegExp(`^(.*?)\\s+(${DATE_RANGE})\\s*$`, "i");
const SECTION_HEADINGS = [
  "PROFESSIONAL SUMMARY",
  "TECHNICAL SKILLS",
  "PROFESSIONAL EXPERIENCE",
  "CERTIFICATIONS",
  "EDUCATION",
  "LANGUAGES",
];

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cleanBullet(line: string): string {
  return line
    .replace(/^\s*[•●▪◦*-]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function section(lines: string[], heading: string): string[] {
  const index = lines.findIndex((line) => line.trim().toUpperCase() === heading);
  if (index < 0) return [];
  const result: string[] = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    if (SECTION_HEADINGS.includes(lines[i].trim().toUpperCase())) break;
    result.push(lines[i]);
  }
  return result;
}

function parseSkillGroups(lines: string[], profile: ProfileData): MasterSkillGroup[] {
  const groups: Array<{ label: string; raw: string[] }> = [];
  let current: { label: string; raw: string[] } | null = null;
  for (const line of lines) {
    const trimmed = cleanBullet(line);
    if (!trimmed) continue;
    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9 &/+.-]{1,55}):\s*(.*)$/);
    if (match) {
      current = { label: match[1].trim(), raw: [match[2].trim()] };
      groups.push(current);
    } else if (current) {
      current.raw.push(trimmed);
    }
  }

  const result: MasterSkillGroup[] = [];
  for (const group of groups) {
    const text = group.raw.join(" ").replace(/\s+/g, " ").trim();
    const values = [...new Set(text.split(/\s*,\s*/).map((value) => value.trim()).filter(Boolean))];
    if (values.length > 0) result.push({ label: group.label, values });
  }

  // The uploaded CV is the source of truth for presentation. Profile skills are
  // a fallback only when the upload contains no usable skills section; adding
  // an extra group would make the document look like a different CV.
  if (result.length === 0) {
    const extra = profile.skills.filter((skill) => skill.verified === 1).map((skill) => skill.name);
    if (extra.length > 0) result.push({ label: "Technical Skills", values: [...new Set(extra)] });
  }
  return result;
}

function parseCompany(line: string, title: string, profile: ProfileData): { company: string; location: string | null } {
  const clean = line.replace(/\s+/g, " ").trim();
  const fromProfile = profile.experiences.find(
    (experience) =>
      clean.toLowerCase().includes(experience.company.toLowerCase()) ||
      experience.title.toLowerCase() === title.toLowerCase(),
  );
  const city = clean.match(/^(.*?)\s+(Nairobi|Lausanne|Bern|Zürich|Zurich|Geneva|Basel|Remote)\s*,\s*(.+)$/i);
  if (city) {
    return {
      company: city[1].replace(/[,\s]+$/, "").trim() || fromProfile?.company || clean,
      location: `${city[2]}, ${city[3]}`.trim(),
    };
  }
  if (fromProfile && clean.toLowerCase().startsWith(fromProfile.company.toLowerCase())) {
    const remaining = clean.slice(fromProfile.company.length).replace(/^[,\s]+/, "").trim();
    return { company: fromProfile.company, location: remaining || fromProfile.location || null };
  }
  const comma = clean.lastIndexOf(",");
  if (comma > 0) {
    return { company: clean.slice(0, comma).replace(/[,\s]+$/, "").trim(), location: clean.slice(comma + 1).trim() };
  }
  return { company: fromProfile?.company || clean, location: fromProfile?.location || null };
}

function parseRoles(lines: string[], profile: ProfileData): MasterRole[] {
  const roles: MasterRole[] = [];
  let current: MasterRole | null = null;
  let currentBullet = -1;

  const push = () => {
    if (current && (current.title || current.company || current.bullets.length)) roles.push(current);
    current = null;
    currentBullet = -1;
  };

  for (const original of lines) {
    const line = original.trim();
    if (!line) continue;
    if (SECTION_HEADINGS.includes(line.toUpperCase())) break;

    const start = line.match(ROLE_START);
    if (start) {
      push();
      const title = start[1].replace(/[,\s]+$/, "").trim();
      const dates = start[2].replace(/\s+/g, " ").trim();
      current = {
        key: `${title}|${dates}`,
        title,
        company: "",
        location: null,
        dates,
        bullets: [],
        note: null,
        summary: null,
        projects: null,
      };
      continue;
    }

    if (!current) continue;

    const cleaned = cleanBullet(line);
    if (!current.company && !/^[•●▪◦*-]/.test(line)) {
      const company = parseCompany(cleaned, current.title, profile);
      current.company = company.company;
      current.location = company.location;
      continue;
    }
    if (/^\(.*\)$/.test(cleaned)) {
      current.note = cleaned;
      continue;
    }

    const isBullet = /^\s*[•●▪◦*-]\s*/.test(line);
    const looksLikeContinuation =
      currentBullet >= 0 &&
      !isBullet &&
      (/^[a-z]/.test(cleaned) ||
        /(?:[,;&-]|and|or|with|for|to|of|the)$/i.test(current.bullets[currentBullet] ?? "") ||
        cleaned.length < 45);
    if (looksLikeContinuation) {
      current.bullets[currentBullet] = `${current.bullets[currentBullet]} ${cleaned}`.replace(/\s+/g, " ").trim();
    } else if (cleaned) {
      current.bullets.push(cleaned);
      currentBullet = current.bullets.length - 1;
    }
  }
  push();

  for (const role of roles) {
    role.key = `${role.company}|${role.title}|${role.dates}`;
  }
  return roles;
}

function parseEducation(lines: string[]): MasterEducation[] {
  const result: MasterEducation[] = [];
  const clean = lines.map(cleanBullet).filter(Boolean);
  for (let index = 0; index < clean.length; index += 1) {
    const line = clean[index];
    const year = line.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
    const title = (year ? line.slice(0, line.lastIndexOf(year)) : line).replace(/[,\s]+$/, "").trim();
    if (!title) continue;
    const institution = clean[index + 1] && !/\b(19|20)\d{2}\b/.test(clean[index + 1]) ? clean[index + 1] : null;
    result.push({ title, date: year, institution });
    if (institution) index += 1;
  }
  return result;
}

function fromProfile(profile: ProfileData): MasterCv {
  const p = profile.profile;
  const contact = [p.location, p.email, p.phone, p.linkedin, p.website].filter(Boolean) as string[];
  if (p.work_authorisation) contact.push(p.work_authorisation);
  const groups = new Map<string, string[]>();
  for (const skill of profile.skills) {
    const values = groups.get(skill.category) ?? [];
    values.push(skill.name);
    groups.set(skill.category, values);
  }
  const roles: MasterRole[] = profile.experiences.map((experience) => {
    const bullets: string[] = [];
    const summary = (experience.summary ?? "").split(/\r?\n|•/).map(cleanBullet).filter(Boolean);
    bullets.push(...summary);
    try {
      const achievements = JSON.parse(experience.achievements ?? "[]") as unknown;
      if (Array.isArray(achievements)) {
        for (const achievement of achievements) if (typeof achievement === "string") bullets.push(cleanBullet(achievement));
      }
    } catch {}
    const dates = experience.start_date
      ? `${experience.start_date} – ${experience.is_current ? "Present" : experience.end_date ?? "Present"}`
      : "Dates to confirm";
    return {
      key: `${experience.company}|${experience.title}|${dates}`,
      title: experience.title,
      company: experience.company,
      location: experience.location,
      dates,
      bullets,
      note: null,
      summary: null,
      projects: experience.projects,
    };
  });
  return {
    sourceId: p.source_cv_id,
    sourceName: "Verified professional profile",
    sourceText: [p.summary, ...roles.flatMap((role) => [role.title, role.company, role.dates, role.summary ?? "", ...role.bullets, role.projects ?? ""])].join("\n"),
    name: p.full_name || "Candidate",
    headline: p.headline || "",
    contact,
    permit: p.work_authorisation,
    summary: p.summary?.replace(/\s+/g, " ").trim() ?? "",
    skillGroups: [...groups].map(([label, values]) => ({ label, values })),
    roles,
    certifications: profile.items.filter((item) => item.kind === "certification").map((item) => item.title),
    education: profile.items
      .filter((item) => item.kind === "education")
      .map((item) => ({ title: item.title, date: item.end_date, institution: item.subtitle })),
    languages: formatLanguageEntries(profile.languageEntries),
    wordCount: (p.summary ?? "").split(/\s+/).filter(Boolean).length,
    parsedFrom: "profile",
  };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})/);
  if (!match) return value;
  const index = Number(match[2]) - 1;
  return MONTH_NAMES[index] ? `${MONTH_NAMES[index]} ${match[1]}` : match[1];
}

function experienceDates(experience: Experience): string | null {
  const start = monthLabel(experience.start_date);
  if (!start) return null;
  const end = experience.is_current ? "Present" : monthLabel(experience.end_date) ?? "Present";
  return `${start} – ${end}`;
}

function roleDateValue(dates: string): number {
  const match = dates.match(/([A-Za-z]{3,9})\s+(\d{4})/);
  if (!match) return 0;
  const index = MONTH_NAMES.findIndex((month) => match[1].slice(0, 3).toLowerCase() === month.toLowerCase());
  return Number(match[2]) * 100 + (index >= 0 ? index + 1 : 0);
}

function achievementsFrom(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item).replace(/^\s*[-•]\s*/, "").replace(/\s+/g, " ").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function normaliseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function companyStem(value: string): string {
  return normaliseKey(value.replace(/\b(?:plc|ltd|limited|inc|ag|gmbh|sa|sarl)\b\.?/gi, " "));
}

function titleStem(value: string): string {
  return normaliseKey(value.replace(/\([^)]*\)/g, " ").replace(/\/.*$/, " "));
}

function experienceMatches(experience: Experience, role: MasterRole): boolean {
  if (experience.source_key && experience.source_key === role.key) return true;
  return (
    companyStem(experience.company) === companyStem(role.company) &&
    titleStem(experience.title) === titleStem(role.title)
  );
}

function roleFromExperience(experience: Experience, base?: MasterRole): MasterRole {
  const bullets = achievementsFrom(experience.achievements);
  return {
    key: base?.key ?? `profile|${experience.id}`,
    title: experience.title,
    company: experience.company,
    location: experience.location ?? base?.location ?? null,
    dates: experienceDates(experience) ?? base?.dates ?? "Dates to confirm",
    // An explicit empty achievements list means the user removed them. Do not
    // silently restore the original bullets from the upload.
    bullets,
    note: base?.note ?? null,
    summary: experience.summary ?? null,
    projects: experience.projects ?? null,
  };
}

/**
 * Applies the editable profile on top of the upload. Imported rows stay inert
 * until edited_at is set, so the original wording is retained. Soft-deleted
 * rows suppress the matching upload role, and manually added roles are appended.
 */
function applyProfileToMaster(master: MasterCv, profile: ProfileData): MasterCv {
  const deleted = profile.deletedExperiences;
  const isDeleted = (role: MasterRole) => deleted.some((experience) => experienceMatches(experience, role));
  const active = profile.experiences;
  const used = new Set<number>();

  const roles = master.roles
    .filter((role) => !isDeleted(role))
    .map((role) => {
      const experience = active.find((candidate) => experienceMatches(candidate, role));
      if (!experience) return role;
      used.add(experience.id);
      return experience.edited_at ? roleFromExperience(experience, role) : role;
    });

  const added: MasterRole[] = [];
  for (const experience of active) {
    if (!experience.edited_at || used.has(experience.id)) continue;
    added.push(roleFromExperience(experience));
  }
  if (added.length > 0) {
    // Keep an added role in chronological position instead of hiding it at the
    // bottom. Original upload order is untouched when nothing was added.
    roles.push(...added);
    roles.sort((a, b) => roleDateValue(b.dates) - roleDateValue(a.dates));
  }

  const skillGroups = master.skillGroups.map((group) => ({ ...group, values: [...group.values] }));
  const known = new Set(skillGroups.flatMap((group) => group.values.map(normaliseKey)));
  for (const skill of profile.skills) {
    const key = normaliseKey(skill.name);
    if (!key || known.has(key)) continue;
    const category = skill.category || "Additional skills";
    const group = skillGroups.find((item) => item.label === category);
    if (group) group.values.push(skill.name);
    else skillGroups.push({ label: category, values: [skill.name] });
    known.add(key);
  }

  const languages =
    profile.languageEntries.length > 0 && (hasSpecifiedLanguageLevels(profile.languageEntries) || !master.languages)
      ? formatLanguageEntries(profile.languageEntries)
      : master.languages;

  const effectiveText = [
    master.summary,
    ...roles.flatMap((role) => [
      role.title,
      role.company,
      role.location ?? "",
      role.dates,
      role.summary ?? "",
      ...role.bullets,
      role.projects ?? "",
    ]),
    ...skillGroups.flatMap((group) => [group.label, group.values.join(", ")]),
    ...master.certifications,
    ...master.education.flatMap((item) => [item.title, item.institution ?? "", item.date ?? ""]),
    languages,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ...master,
    roles,
    skillGroups,
    languages,
    sourceText: effectiveText,
    wordCount: effectiveText.split(/\s+/).filter(Boolean).length,
  };
}

export function parseMasterCv(
  text: string,
  profile: ProfileData,
  sourceId: string | null,
  sourceName: string,
): MasterCv {
  const raw = normalise(text);
  const lines = raw.split("\n").map((line) => line.trim());
  const summaryIndex = lines.findIndex((line) => line.toUpperCase() === "PROFESSIONAL SUMMARY");
  const header = summaryIndex > 0 ? lines.slice(0, summaryIndex).filter(Boolean) : [];
  const summaryLines = section(lines, "PROFESSIONAL SUMMARY");
  const summary = oneLine(summaryLines.join(" "));
  const skillGroups = parseSkillGroups(section(lines, "TECHNICAL SKILLS"), profile);
  const roles = parseRoles(section(lines, "PROFESSIONAL EXPERIENCE"), profile);
  const certifications = section(lines, "CERTIFICATIONS").map(cleanBullet).filter(Boolean);
  const education = parseEducation(section(lines, "EDUCATION"));
  const languages = oneLine(section(lines, "LANGUAGES").map(cleanBullet).join(" | "));
  const permitLine = header.find((line) => /permit|authoris|authoriz|visa|residency/i.test(line)) ?? null;
  const contactLines = header.filter((line) => line !== header[0] && line !== header[1] && line !== permitLine);
  const contactText = oneLine(contactLines.join(" ")).replace(/,(?=\S)/g, ", ");
  const contact = contactText.split(/\s*\|\s*/).map((part) => part.trim()).filter(Boolean);
  const p = profile.profile;
  if (p.email && !contact.some((part) => part.toLowerCase().includes(p.email!.toLowerCase()))) contact.push(p.email);
  if (p.phone && !contact.some((part) => part.includes(p.phone!))) contact.push(p.phone);
  if (p.linkedin && !contact.some((part) => part.toLowerCase().includes("linkedin"))) contact.push(p.linkedin);
  if (p.website && !contact.some((part) => part.includes(p.website!))) contact.push(p.website);

  const master: MasterCv = {
    sourceId,
    sourceName,
    sourceText: raw,
    name: header[0] || p.full_name || "Candidate",
    headline: header[1] || p.headline || "",
    contact: [...new Set(contact)],
    permit: permitLine || p.work_authorisation,
    summary,
    skillGroups,
    roles,
    certifications,
    education,
    languages,
    wordCount: raw.split(/\s+/).filter(Boolean).length,
    parsedFrom: "original",
  };

  if (master.roles.length === 0) {
    const fallback = fromProfile(profile);
    return {
      ...fallback,
      sourceId,
      sourceName,
      sourceText: raw,
      name: master.name,
      headline: master.headline,
      contact: master.contact.length ? master.contact : fallback.contact,
      permit: master.permit ?? fallback.permit,
      summary: master.summary || fallback.summary,
      skillGroups: master.skillGroups.length ? master.skillGroups : fallback.skillGroups,
      certifications: master.certifications.length ? master.certifications : fallback.certifications,
      education: master.education.length ? master.education : fallback.education,
      languages: master.languages || fallback.languages,
    };
  }
  return applyProfileToMaster(master, profile);
}

export async function loadMasterCv(profile: ProfileData = getProfileData()): Promise<MasterCv> {
  const sourceId = profile.profile.source_cv_id;
  if (sourceId) {
    const source = one<DocumentRow>(
      "SELECT id, file_name, relative_path, text_content FROM documents WHERE id = ? AND kind = 'original_cv' AND deleted_at IS NULL",
      [sourceId],
    );
    if (source) {
      // Re-extract from the uploaded file. text_content can be stale or lossy:
      // the current upload's stored text omitted a whole skills group and two
      // bullets that are present in the original PDF. The file is authoritative.
      try {
        const buffer = await readFile(path.join(UPLOAD_DIR, path.basename(source.relative_path)));
        const extracted = await extractText(buffer, "application/pdf", source.file_name);
        if (extracted.trim()) return parseMasterCv(extracted, profile, source.id, source.file_name);
      } catch {
        // Fall through to the stored extraction only when the file is unreadable.
      }
      if (source.text_content?.trim()) return parseMasterCv(source.text_content, profile, source.id, source.file_name);
    }
  }
  return fromProfile(profile);
}
