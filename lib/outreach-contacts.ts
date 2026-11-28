import { nowIso, one, run } from "./db.ts";
import { sha256 } from "./security.ts";

/**
 * Hiring-manager and recruiter discovery.
 *
 * Evidence is recorded before a contact can be used. This module never guesses
 * an address from a naming convention: an email must appear in the employer's
 * vacancy text, a public employer page, or real correspondence in the connected
 * mailbox. A generic company inbox is ranked below a named person.
 */

export type ContactSourceKind = "vacancy" | "public_page" | "gmail";
export type ContactVerification = "verified" | "rejected" | "unavailable";

export type ContactCandidate = {
  name: string;
  title: string | null;
  company: string;
  email: string | null;
  sourceUrl: string | null;
  sourceKind: ContactSourceKind;
  discoveryMethod: string;
  evidence: Record<string, unknown>;
  confidence: number;
  priority: number;
  verificationStatus: ContactVerification;
};

export type StoredContact = ContactCandidate & {
  id: string;
  jobId: string;
  emailDomain: string | null;
};

type JobContactContext = {
  id: string;
  title: string;
  company: string;
  description: string | null;
  url: string | null;
  application_url: string | null;
  employer_url: string | null;
  application_email: string | null;
  application_email_source?: string | null;
  application_email_verified_at?: string | null;
};

const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|proton|protonmail|gmx|bluewin|sunrise|hispeed)\./i;
const TITLE_WORDS =
  /\b(hiring manager|talent acquisition|talent partner|recruit(er|ment)?|head of|director|manager|lead|qa|quality|engineering|people)\b/i;
const NAME_PATTERN = /\b([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){1,3})\b/u;

function hostOf(raw: string | null | undefined): string | null {
  try {
    return new URL(raw ?? "").hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export function employerDomain(job: Pick<JobContactContext, "application_email" | "employer_url" | "application_url" | "url">): string | null {
  if (job.application_email?.includes("@")) return job.application_email.split("@")[1]?.toLowerCase() ?? null;
  return hostOf(job.employer_url) ?? hostOf(job.application_url) ?? null;
}

function addressDomain(email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase().replace(/^www\./, "") ?? "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) && !FREE_MAIL.test(domain) ? domain : null;
}

function sameDomain(email: string, employerHost: string | null): boolean {
  const domain = addressDomain(email);
  if (!domain || !employerHost) return false;
  return domain === employerHost || domain.endsWith(`.${employerHost}`);
}

function rankFor(title: string | null, name: string, sourceKind: ContactSourceKind): number {
  const text = `${title ?? ""} ${name}`.toLowerCase();
  if (/hiring manager/.test(text)) return 1;
  if (/talent acquisition|talent partner/.test(text)) return 2;
  if (/recruit/.test(text)) return 3;
  if (/head of|director|manager|lead|qa|quality|engineering/.test(text)) return 5;
  if (/team|recruitment contact|careers/.test(text)) return 8;
  return sourceKind === "gmail" ? 4 : 6;
}

function nameFromSender(sender: string): { name: string | null; email: string | null } {
  const email = sender.match(/<([^>]+)>/)?.[1]?.trim() ?? (sender.includes("@") ? sender.trim() : null);
  const display = sender.replace(/<[^>]+>/g, "").replace(/"/g, "").trim();
  return {
    email,
    name: NAME_PATTERN.test(display) ? display.match(NAME_PATTERN)![0] : null,
  };
}

function descriptionContexts(description: string, email: string): string[] {
  const at = description.toLowerCase().indexOf(email.toLowerCase());
  if (at < 0) return [];
  const start = Math.max(0, at - 220);
  return [description.slice(start, Math.min(description.length, at + email.length + 220))];
}

/** Explicitly published contact details in the vacancy description. */
export function contactsFromVacancy(
  job: Pick<JobContactContext, "id" | "title" | "company" | "description" | "url" | "application_url" | "employer_url" | "application_email">,
): ContactCandidate[] {
  const description = job.description ?? "";
  const domain = employerDomain(job);
  if (!description || !domain) return [];
  const seen = new Set<string>();
  const contacts: ContactCandidate[] = [];
  for (const match of description.matchAll(/\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi)) {
    const email = match[1].toLowerCase();
    if (seen.has(email) || !sameDomain(email, domain)) continue;
    seen.add(email);
    const context = descriptionContexts(description, email).join(" ");
    const name = context.match(NAME_PATTERN)?.[1] ?? "Recruitment contact";
    const titleMatch = context.match(/\b(Talent Acquisition(?: Specialist| Partner)?|Hiring Manager|Recruiter|Head of [A-Z][\p{L} ]{2,40}|QA Manager|Engineering Manager)\b/u);
    contacts.push({
      name,
      title: titleMatch?.[1] ?? null,
      company: job.company,
      email,
      sourceUrl: job.url ?? job.application_url ?? null,
      sourceKind: "vacancy",
      discoveryMethod: "explicit_address_in_vacancy",
      evidence: { field: "description", email, context: context.slice(0, 600) },
      confidence: name === "Recruitment contact" ? 65 : 92,
      priority: rankFor(titleMatch?.[1] ?? null, name, "vacancy"),
      verificationStatus: "verified",
    });
  }
  return contacts;
}

/**
 * A verified, employer-published application inbox is a legitimate official
 * recruitment contact when no named person is published. It is labelled as a
 * team inbox so it can never be presented as a named hiring manager.
 */
export function contactsFromVerifiedApplicationInbox(job: JobContactContext): ContactCandidate[] {
  const email = job.application_email?.trim().toLowerCase();
  if (!email || !job.application_email_verified_at) return [];
  // The employer's own host is authoritative here. Deriving the expected domain
  // from the address itself would accept any unrelated domain as "employer
  // associated", which is exactly the guess this module must refuse.
  const employerHost = hostOf(job.employer_url) ?? hostOf(job.application_url) ?? hostOf(job.url);
  if (!employerHost || !sameDomain(email, employerHost)) return [];
  return [
    {
      name: "Recruitment team",
      title: "Official recruitment contact",
      company: job.company,
      email,
      sourceUrl: job.employer_url ?? job.url ?? null,
      sourceKind: "public_page",
      discoveryMethod: "verified_application_inbox",
      evidence: {
        field: "application_email",
        email,
        source: job.application_email_source ?? "employer_page",
        verifiedAt: job.application_email_verified_at,
        note: "Published by the employer as the application address. This is a team inbox, not a named individual.",
      },
      confidence: 85,
      priority: 8,
      verificationStatus: "verified",
    },
  ];
}

type JsonLdPerson = {
  "@type"?: string | string[];
  name?: string;
  jobTitle?: string;
  email?: string;
  worksFor?: { name?: string } | string;
};

function flattenJsonLd(value: unknown): JsonLdPerson[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown> & JsonLdPerson;
  const graph = Array.isArray(record["@graph"]) ? record["@graph"].flatMap(flattenJsonLd) : [];
  const person = record["@type"] === "Person" || (Array.isArray(record["@type"]) && record["@type"].includes("Person")) ? [record] : [];
  return [...person, ...graph];
}

/** Parse explicitly published person data from one public employer page. */
export function contactsFromPublicPage(input: {
  html: string;
  pageUrl: string;
  employerHost: string;
  company: string;
}): ContactCandidate[] {
  const contacts: ContactCandidate[] = [];
  const seen = new Set<string>();
  for (const match of input.html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      for (const person of flattenJsonLd(parsed)) {
        const email = person.email?.trim().toLowerCase();
        if (!person.name || !email || seen.has(email) || !sameDomain(email, input.employerHost)) continue;
        seen.add(email);
        contacts.push({
          name: person.name,
          title: person.jobTitle ?? null,
          company: input.company,
          email,
          sourceUrl: input.pageUrl,
          sourceKind: "public_page",
          discoveryMethod: "schema_org_person",
          evidence: { pageUrl: input.pageUrl, person: { name: person.name, jobTitle: person.jobTitle ?? null, email } },
          confidence: 95,
          priority: rankFor(person.jobTitle ?? null, person.name, "public_page"),
          verificationStatus: "verified",
        });
      }
    } catch {
      // Invalid JSON-LD is ignored; it is not evidence.
    }
  }
  for (const match of input.html.matchAll(/<a\b[^>]*href=["']mailto:([^"'?]+)[^>]*>([\s\S]*?)<\/a>/gi)) {
    const email = match[1].trim().toLowerCase();
    if (seen.has(email) || !sameDomain(email, input.employerHost)) continue;
    seen.add(email);
    const anchor = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const nearbyStart = Math.max(0, (match.index ?? 0) - 260);
    const nearby = input.html.slice(nearbyStart, (match.index ?? 0) + 500).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const name = NAME_PATTERN.test(anchor) ? anchor.match(NAME_PATTERN)![0] : nearby.match(NAME_PATTERN)?.[1];
    if (!name) continue;
    const title = nearby.match(/\b(Talent Acquisition(?: Specialist| Partner)?|Hiring Manager|Recruiter|Head of [A-Z][\p{L} ]{2,40}|QA Manager|Engineering Manager)\b/u)?.[1] ?? null;
    contacts.push({
      name,
      title,
      company: input.company,
      email,
      sourceUrl: input.pageUrl,
      sourceKind: "public_page",
      discoveryMethod: "published_mailto_with_person",
      evidence: { pageUrl: input.pageUrl, email, nearby: nearby.slice(0, 600) },
      confidence: 88,
      priority: rankFor(title, name, "public_page"),
      verificationStatus: "verified",
    });
  }
  return contacts;
}

/** Existing mailbox correspondence is legitimate evidence of a person's address. */
export function contactsFromGmail(jobId: string, employerHost: string | null, company: string): ContactCandidate[] {
  if (!employerHost) return [];
  const rows = one<{ rows: string }>(
    `SELECT COALESCE(json_group_array(json_object('id', id, 'sender', sender, 'subject', subject)), '[]') AS rows
     FROM (SELECT id, sender, subject FROM email_messages
           WHERE application_id IN (SELECT id FROM applications WHERE job_id = ?)
              OR lower(sender) LIKE '%@' || lower(?) || '%'
           ORDER BY received_at DESC LIMIT 30)`,
    [jobId, employerHost],
  );
  let messages: Array<{ id: string; sender: string | null; subject: string }> = [];
  try {
    messages = JSON.parse(rows?.rows ?? "[]") as typeof messages;
  } catch {
    messages = [];
  }
  const contacts: ContactCandidate[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (!message.sender) continue;
    const parsed = nameFromSender(message.sender);
    if (!parsed.email || !parsed.name || seen.has(parsed.email.toLowerCase()) || !sameDomain(parsed.email, employerHost)) continue;
    seen.add(parsed.email.toLowerCase());
    contacts.push({
      name: parsed.name,
      title: null,
      company,
      email: parsed.email.toLowerCase(),
      sourceUrl: `gmail://message/${message.id}`,
      sourceKind: "gmail",
      discoveryMethod: "existing_correspondence",
      evidence: { messageId: message.id, sender: message.sender, subject: message.subject },
      confidence: 90,
      priority: rankFor(null, parsed.name, "gmail"),
      verificationStatus: "verified",
    });
  }
  return contacts;
}

export async function contactsFromPublicPages(input: {
  pages: string[];
  employerHost: string;
  company: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ContactCandidate[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const contacts: ContactCandidate[] = [];
  for (const pageUrl of [...new Set(input.pages)].slice(0, 4)) {
    if (hostOf(pageUrl) !== input.employerHost && !hostOf(pageUrl)?.endsWith(`.${input.employerHost}`)) continue;
    try {
      const response = await fetchImpl(pageUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
        headers: { accept: "text/html", "user-agent": "AT-AI-Workforce/1.0 (public recruitment contact discovery)" },
      });
      if (!response.ok) continue;
      const html = (await response.text()).slice(0, 1_000_000);
      contacts.push(...contactsFromPublicPage({ html, pageUrl: response.url || pageUrl, employerHost: input.employerHost, company: input.company }));
    } catch {
      // A failed public page is not evidence and does not stop other sources.
    }
  }
  return contacts;
}

export function rankContacts<T extends Pick<ContactCandidate, "priority" | "confidence" | "email">>(contacts: T[]): T[] {
  return [...contacts].sort((a, b) => a.priority - b.priority || b.confidence - a.confidence || (a.email ?? "").localeCompare(b.email ?? ""));
}

function persist(jobId: string, contact: ContactCandidate, employerHost: string | null, now: string): void {
  const email = contact.email?.toLowerCase() ?? null;
  if (contact.verificationStatus === "verified" && (!email || !sameDomain(email, employerHost))) return;
  const id = `contact_${sha256(`${jobId}|${email ?? contact.name}|${contact.sourceUrl ?? ""}`).slice(0, 24)}`;
  const existing = one<{ id: string; priority: number; confidence: number }>(
    "SELECT id, priority, confidence FROM outreach_contacts WHERE job_id = ? AND email IS ? LIMIT 1",
    [jobId, email],
  );
  if (existing) {
    if (contact.priority < existing.priority || contact.confidence > existing.confidence) {
      run(
        `UPDATE outreach_contacts SET name = ?, title = ?, email_domain = ?, source_url = ?, source_kind = ?,
           discovery_method = ?, evidence = ?, confidence = ?, priority = ?, verification_status = ?, updated_at = ?
         WHERE id = ?`,
        [contact.name, contact.title, email ? addressDomain(email) : null, contact.sourceUrl, contact.sourceKind,
          contact.discoveryMethod, JSON.stringify(contact.evidence).slice(0, 8000), contact.confidence,
          contact.priority, contact.verificationStatus, now, existing.id],
      );
    }
    return;
  }
  run(
    `INSERT INTO outreach_contacts
       (id, job_id, name, title, company, email, email_domain, source_url, source_kind, discovery_method, evidence,
        confidence, priority, verification_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, jobId, contact.name, contact.title, contact.company, email, email ? addressDomain(email) : null,
      contact.sourceUrl, contact.sourceKind, contact.discoveryMethod, JSON.stringify(contact.evidence).slice(0, 8000),
      contact.confidence, contact.priority, contact.verificationStatus, now, now],
  );
}

export function verifiedContactsForJob(jobId: string): StoredContact[] {
  const rows = one<{ rows: string }>(
    `SELECT COALESCE(json_group_array(json_object(
       'id', id, 'job_id', job_id, 'name', name, 'title', title, 'company', company, 'email', email,
       'email_domain', email_domain, 'source_url', source_url, 'source_kind', source_kind,
       'discovery_method', discovery_method, 'evidence', json(evidence), 'confidence', confidence,
       'priority', priority, 'verification_status', verification_status)), '[]') AS rows
     FROM (SELECT * FROM outreach_contacts WHERE job_id = ? AND verification_status = 'verified' AND email IS NOT NULL
           ORDER BY priority, confidence DESC)`,
    [jobId],
  );
  try {
    return (JSON.parse(rows?.rows ?? "[]") as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      jobId: String(row.job_id),
      name: String(row.name),
      title: (row.title as string | null) ?? null,
      company: String(row.company),
      email: String(row.email),
      emailDomain: (row.email_domain as string | null) ?? null,
      sourceUrl: (row.source_url as string | null) ?? null,
      sourceKind: row.source_kind as ContactSourceKind,
      discoveryMethod: String(row.discovery_method),
      evidence: (row.evidence as Record<string, unknown>) ?? {},
      confidence: Number(row.confidence),
      priority: Number(row.priority),
      verificationStatus: "verified",
    }));
  } catch {
    return [];
  }
}

export async function discoverOutreachContacts(
  jobId: string,
  options: { publicPages?: string[]; fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<{ contacts: StoredContact[]; unavailable: boolean; reason: string }> {
  const job = one<JobContactContext>(
    `SELECT id, title, company, description, url, application_url, employer_url, application_email,
            application_email_source, application_email_verified_at
     FROM jobs WHERE id = ?`,
    [jobId],
  );
  if (!job) return { contacts: [], unavailable: true, reason: "The vacancy does not exist." };
  const domain = employerDomain(job);
  const now = (options.now ?? new Date()).toISOString();
  const candidates: ContactCandidate[] = [
    ...contactsFromVacancy(job),
    ...contactsFromVerifiedApplicationInbox(job),
    ...contactsFromGmail(job.id, domain, job.company),
  ];
  if (domain && options.publicPages?.length) {
    candidates.push(
      ...(await contactsFromPublicPages({
        pages: options.publicPages,
        employerHost: domain,
        company: job.company,
        fetchImpl: options.fetchImpl,
      })),
    );
  }

  const seen = new Set<string>();
  for (const candidate of rankContacts(candidates)) {
    const key = candidate.email?.toLowerCase() ?? `${candidate.sourceKind}|${candidate.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    persist(job.id, candidate, domain, now);
  }

  const contacts = verifiedContactsForJob(job.id);
  if (contacts.length === 0) {
    persist(
      job.id,
      {
        name: "No verified contact",
        title: null,
        company: job.company,
        email: null,
        sourceUrl: null,
        sourceKind: "vacancy",
        discoveryMethod: "bounded_search_exhausted",
        evidence: { reason: "No explicitly published, employer-associated address was found." },
        confidence: 0,
        priority: 99,
        verificationStatus: "unavailable",
      },
      domain,
      now,
    );
    return {
      contacts: [],
      unavailable: true,
      reason: "No explicitly published or previously observed employer-associated address was found. No address was guessed.",
    };
  }
  return { contacts, unavailable: false, reason: `Found ${contacts.length} verified contact(s).` };
}
