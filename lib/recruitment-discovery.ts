import crypto from "node:crypto";
import { all, nowIso, one, run } from "./db";
import { htmlToText } from "./scoring";
import { researchJobs } from "./jobs";
import { getSetting } from "./settings";
import { classifyVacancy } from "./vacancy-classification";
import {
  requestJson,
  requestText,
  type SourceAttemptDiagnostic,
  type SourceErrorCategory,
} from "./source-http";

/**
 * Vacancy discovery for the autonomous daily run.
 *
 * Three real, key-free connectors are used: the existing Arbeitnow feed, the
 * public Ashby posting API, and employer career pages that publish schema.org
 * JobPosting data. Nothing is invented: a posting is only stored when the
 * connector returned a real employer, title, description and URL.
 *
 * Cross-source duplicates are blocked on a normalised employer+title key, on the
 * source identifier, and on the application URL with tracking parameters
 * stripped. The same vacancy advertised on a board and on the employer's own
 * site therefore produces one record.
 */

export type DiscoveredJob = {
  source: string;
  sourcePlatform: string;
  externalId: string | null;
  title: string;
  company: string;
  companyDomain: string | null;
  location: string;
  remote: boolean;
  employmentType: string | null;
  salary: string | null;
  url: string;
  applicationUrl: string | null;
  description: string;
  publishedAt: string | null;
  raw?: unknown;
};

export type DiscoverySource = {
  key: string;
  label: string;
  fetched: number;
  inserted: number;
  error: string | null;
  requests: number;
  responses: number;
  fresh: number;
  relevant: number;
  duplicates: number;
  configured?: boolean;
  status?: "ok" | "empty" | "partial" | "failed" | "skipped";
  attempts?: number;
  durationMs?: number;
  errorCategory?: SourceErrorCategory | null;
};

/** Per-source contribution, persisted on the run and shown in the report/UI. */
export type SourceMetrics = {
  key: string;
  label: string;
  requests: number;
  responses: number;
  postings: number;
  fresh: number;
  relevant: number;
  duplicates: number;
  inserted: number;
  errors: number;
  eligible: number;
  qualified: number;
  attempts?: number;
  durationMs?: number;
  status?: string;
};

export type DiscoveryResult = {
  discovered: number;
  inserted: number;
  duplicates: number;
  filtered: number;
  jobIds: string[];
  sources: DiscoverySource[];
  warnings: string[];
  sourcesChecked?: number;
  sourcesSucceeded?: number;
  sourcesFailed?: number;
  sourcesPartial?: number;
  discoveryState?: "ok" | "empty" | "partial" | "failed" | "not_configured";
  allSourcesFailed?: boolean;
};

const QA_TITLE =
  /\b(qa|quality assurance|test(?:ing)? engineer|test automation|automation engineer|sdet|software (?:development )?engineer in test|software test|test lead|test manager|lead qa|qa lead|qa automation|qa engineer|test analyst|quality engineer)\b/i;

const SWISS_SIGNAL =
  /(switzerland|schweiz|suisse|svizzera|swiss|zurich|zürich|geneva|genève|geneve|lausanne|bern|basel|zug|luzern|lucerne|winterthur|st\.?\s*gallen|lugano|fribourg|vaud|ticino|neuch|bienne|olten|aarau|schaffhausen|sion|chur)/i;

const EUROPE_OPEN = /\b(eu\/efta|european union|europe|eea|emea|dach|worldwide|anywhere|global|international|remote)\b/i;

const PLACEHOLDER_COMPANY =
  /^(company\s+[a-z]|company\s+\d+|employer\s+[a-z]|example(\s+(company|employer|inc|ltd))?|sample(\s+company)?|test\s+company|acme(\s+corp(oration)?)?|placeholder)$/i;

export function normaliseText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Employer + role identity used to stop the same vacancy being stored twice. */
export function dedupeKeyFor(company: string, title: string): string {
  return crypto.createHash("sha1").update(`${normaliseText(company)}|${normaliseText(title)}`).digest("hex");
}

export function normaliseApplicationUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gh_src|lever-source|source|ref|referrer|trk|tracking)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
  } catch {
    return null;
  }
}

function companyDomain(company: string, url: string | null): string | null {
  if (url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      if (!/ashbyhq|greenhouse|lever|workday|linkedin|indeed|arbeitnow|jobup|jobs\.ch/i.test(host)) return host;
    } catch {
      // fall through
    }
  }
  const slug = normaliseText(company).replace(/\s+/g, "");
  return slug ? `${slug}.unknown` : null;
}

export function isQaTitle(title: string): boolean {
  return QA_TITLE.test(title);
}

function titleFiltered(title: string, company: string, location: string, description: string): string | null {
  // Classification reads the responsibilities, not just the title: a general
  // engineering or product role that mentions testing is rejected here.
  const classification = classifyVacancy({ title, company, location, description });
  if (!classification.isQa) return `Not a hands-on QA/SDET role (classified as ${classification.label})`;
  if (title.trim().length < 3) return "Missing a real job title";
  if (company.trim().length < 2 || PLACEHOLDER_COMPANY.test(company.trim())) return "Placeholder employer rejected";
  const swiss = SWISS_SIGNAL.test(location) || SWISS_SIGNAL.test(description.slice(0, 2000));
  if (!swiss && !EUROPE_OPEN.test(`${location} ${description.slice(0, 1200)}`)) return "Outside Switzerland and not remote";
  if (description.trim().length < 40) return "Missing the original vacancy description";
  return null;
}

function publishedWithinSevenDays(value: string | null): boolean {
  if (!value) return true;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return true;
  return Date.now() - time <= 7 * 86400_000;
}

export type DuplicateMatch = {
  id: string;
  rule: "source + external_id" | "normalised employer + title SHA-1" | "normalised application URL" | "case-insensitive employer + title";
};

/** Find the existing record for a listing without changing it. */
export function findDuplicateJob(job: DiscoveredJob): DuplicateMatch | null {
  if (job.externalId) {
    const sameSource = one<{ id: string }>("SELECT id FROM jobs WHERE source = ? AND external_id = ?", [job.source, job.externalId]);
    if (sameSource) return { id: sameSource.id, rule: "source + external_id" };
  }
  const dedupeKey = dedupeKeyFor(job.company, job.title);
  const keyMatch = one<{ id: string }>("SELECT id FROM jobs WHERE dedupe_key = ?", [dedupeKey]);
  if (keyMatch) return { id: keyMatch.id, rule: "normalised employer + title SHA-1" };

  const applicationUrl = normaliseApplicationUrl(job.applicationUrl);
  if (applicationUrl) {
    const rows = one<{ id: string }>(
      "SELECT id FROM jobs WHERE lower(replace(replace(coalesce(application_url, url), 'https://', ''), 'http://', '')) LIKE ?",
      [`%${applicationUrl.replace(/^https?:\/\//, "")}%`],
    );
    if (rows) return { id: rows.id, rule: "normalised application URL" };
  }

  const nearDuplicate = one<{ id: string }>(
    "SELECT id FROM jobs WHERE lower(trim(title)) = lower(trim(?)) AND lower(trim(company)) = lower(trim(?))",
    [job.title, job.company],
  );
  if (nearDuplicate) return { id: nearDuplicate.id, rule: "case-insensitive employer + title" };
  return null;
}

/** A duplicate is evidence that the original vacancy is still live. */
function touchJobSeen(id: string, source: string): void {
  run("UPDATE jobs SET last_seen_at = ?, last_seen_source = ? WHERE id = ?", [nowIso(), source, id]);
}

/** Returns the new row id, or null when the vacancy is a duplicate. */
export function insertDiscovered(job: DiscoveredJob, runId: string | null): string | null {
  const duplicate = findDuplicateJob(job);
  if (duplicate) {
    touchJobSeen(duplicate.id, job.source);
    return null;
  }

  const id = `job_${crypto.randomBytes(8).toString("hex")}`;
  const dedupeKey = dedupeKeyFor(job.company, job.title);
  const classification = classifyVacancy({
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description,
  });
  try {
    run(
      `INSERT INTO jobs (id, source, source_platform, external_id, title, company, company_domain, location, remote,
                         employment_type, salary, url, application_url, description, classification, requirements,
                         published_at, posted_at, discovered_at, status, dedupe_key, run_id, raw,
                         last_seen_at, last_seen_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`,
      [
        id,
        job.source,
        job.sourcePlatform,
        job.externalId,
        job.title.trim().slice(0, 300),
        job.company.trim().slice(0, 200),
        job.companyDomain,
        job.location.trim() || "Not specified",
        job.remote ? 1 : 0,
        job.employmentType,
        job.salary,
        job.url,
        job.applicationUrl ?? job.url,
        job.description.slice(0, 24000),
        JSON.stringify(classification).slice(0, 12000),
        JSON.stringify({ mandatory: classification.mandatory, preferences: classification.preferences }).slice(0, 8000),
        job.publishedAt,
        job.publishedAt,
        nowIso(),
        dedupeKey,
        runId,
        job.raw ? JSON.stringify(job.raw).slice(0, 20000) : null,
        nowIso(),
        job.source,
      ],
    );
  } catch (error) {
    // The unique dedupe index is the final guard if two connectors race.
    if (/unique/i.test(error instanceof Error ? error.message : "")) return null;
    throw error;
  }
  return id;
}

type AshbyPosting = {
  id?: string;
  title?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  department?: string;
  team?: string;
  employmentType?: string;
  isRemote?: boolean;
  workplaceType?: string;
  publishedAt?: string;
  applicationDeadline?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  isListed?: boolean;
  compensation?: { compensationTierSummary?: string };
};

export type RawDiscovery = {
  jobs: DiscoveredJob[];
  fetched: number;
  filtered: number;
  fresh: number;
  requests: number;
  responses: number;
  error: string | null;
  errorCategory: SourceErrorCategory | null;
  attempts: number;
  durationMs: number;
  diagnostics: SourceAttemptDiagnostic[];
  numPages?: number;
};

function logSourceDiagnostics(runId: string, source: string, diagnostics: SourceAttemptDiagnostic[]): void {
  for (const event of diagnostics) {
    if (event.retryDecision === "success") continue;
    const line = JSON.stringify({
      event: "job_source.attempt",
      runId,
      source,
      attempt: event.attempt,
      durationMs: event.durationMs,
      statusCode: event.statusCode,
      errorCategory: event.errorCategory,
      retryDecision: event.retryDecision,
      retryAfterMs: event.retryAfterMs,
    });
    if (event.retryDecision === "stop") console.warn(line);
    else console.info(line);
  }
}

function emptyRaw(): RawDiscovery {
  return {
    jobs: [],
    fetched: 0,
    filtered: 0,
    fresh: 0,
    requests: 0,
    responses: 0,
    error: null,
    errorCategory: null,
    attempts: 0,
    durationMs: 0,
    diagnostics: [],
    numPages: 1,
  };
}

/** "sumup" -> "Sumup", "any-botics" -> "Any Botics" for display only. */
function prettifySlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record.name, record.addressLocality, record.addressCountry].filter(Boolean).map(String).join(", ");
  }
  return "";
}

/** Public Ashby posting API: https://api.ashbyhq.com/posting-api/job-board/<org> */
export async function discoverFromAshby(boards: string[]): Promise<RawDiscovery> {
  const out: RawDiscovery = emptyRaw();
  if (boards.length === 0) return out;
  const source = one<{ enabled: number; url: string | null }>("SELECT enabled, url FROM job_sources WHERE key = 'ashby'");
  if (source && source.enabled !== 1) {
    out.error = "The Ashby connector is disabled in Job discovery → Sources.";
    return out;
  }
  const base = (source?.url ?? "https://api.ashbyhq.com/posting-api/job-board").replace(/\/+$/, "");

  for (const board of boards) {
    const slug = board.trim().replace(/^https?:\/\/jobs\.ashbyhq\.com\//i, "").replace(/\/+$/, "");
    if (!slug) continue;
    out.requests += 1;
    const endpoint = `${base}/${encodeURIComponent(slug)}?includeCompensation=true`;
    const freshBefore = out.fresh;
    const filteredBefore = out.filtered;
    let postingCount = 0;
    try {
      const request = await requestJson<{ jobs?: AshbyPosting[]; data?: { jobs?: AshbyPosting[] } }>(endpoint, {
        timeoutMs: 25_000,
        // Ashby's largest public boards exceed the shared 4 MB default. The
        // shared reader's hard ceiling remains 8 MB, so this raises only the
        // per-board budget and still bounds memory use.
        maxResponseBytes: 8 * 1024 * 1024,
        label: `Ashby board ${slug}`,
      });
      out.attempts += request.attempts;
      out.durationMs += request.durationMs;
      out.diagnostics.push(...request.diagnostics);
      if (!request.ok || !request.data) {
        out.error = request.error ?? `Ashby board ${slug} could not be read.`;
        out.errorCategory = request.errorCategory ?? "unknown";
        recordSourceCheck({
          key: "ashby",
          employer: slug,
          endpoint,
          method: "Public Ashby posting API",
          ok: false,
          postings: 0,
          fresh: 0,
          relevant: 0,
          error: out.error,
          errorCategory: out.errorCategory,
          statusCode: request.statusCode,
          attempts: request.attempts,
          durationMs: request.durationMs,
        });
        continue;
      }
      out.responses += 1;
      const postings = request.data.jobs ?? request.data.data?.jobs ?? [];
      postingCount = postings.length;
      out.fetched += postings.length;
      for (const posting of postings) {
        if (posting.isListed === false) {
          out.filtered += 1;
          continue;
        }
        const title = (posting.title ?? "").trim();
        const description = (posting.descriptionPlain ?? htmlToText(posting.descriptionHtml ?? "")).trim();
        const location =
          posting.location?.trim() ||
          (posting.secondaryLocations ?? []).map((item) => item.location ?? "").filter(Boolean).join(" / ") ||
          "Not specified";
        const remote = Boolean(posting.isRemote) || /remote/i.test(posting.workplaceType ?? "");
        const url = posting.applyUrl || posting.jobUrl || "";
        const company = prettifySlug(slug);
        const fresh = publishedWithinSevenDays(posting.publishedAt ?? null);
        if (fresh) out.fresh += 1;
        const reason = titleFiltered(title, company, location, description);
        if (reason) {
          out.filtered += 1;
          continue;
        }
        if (!fresh) {
          out.filtered += 1;
          continue;
        }
        out.jobs.push({
          source: "ashby",
          sourcePlatform: `Ashby · ${slug}`,
          externalId: posting.id ?? url ?? null,
          title,
          company,
          companyDomain: companyDomain(company, posting.jobUrl ?? url),
          location,
          remote,
          employmentType: posting.employmentType ?? null,
          salary: posting.compensation?.compensationTierSummary ?? null,
          url,
          applicationUrl: posting.applyUrl ?? posting.jobUrl ?? url,
          description,
          publishedAt: posting.publishedAt ?? null,
          raw: { board: slug, id: posting.id, department: posting.department, team: posting.team },
        });
      }
      recordSourceCheck({
        key: "ashby",
        employer: slug,
        endpoint,
        method: "Public Ashby posting API",
        ok: true,
        postings: postingCount,
        fresh: out.fresh - freshBefore,
        relevant: Math.max(0, postingCount - (out.filtered - filteredBefore)),
        error: null,
        errorCategory: null,
        statusCode: request.statusCode,
        attempts: request.attempts,
        durationMs: request.durationMs,
      });
    } catch (error) {
      out.error = error instanceof Error ? error.message : `Ashby board ${slug} could not be reached.`;
      out.errorCategory = "unknown";
      recordSourceCheck({
        key: "ashby",
        employer: slug,
        endpoint,
        method: "Public Ashby posting API",
        ok: false,
        postings: postingCount,
        fresh: out.fresh - freshBefore,
        relevant: 0,
        error: out.error,
        errorCategory: "unknown",
        statusCode: null,
        attempts: 0,
        durationMs: Date.now(),
      });
    }
  }
  return out;
}

type JsonLdNode = Record<string, unknown>;

function collectJobPostings(node: unknown, into: JsonLdNode[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectJobPostings(item, into);
    return;
  }
  if (typeof node !== "object") return;
  const record = node as JsonLdNode;
  if (record["@type"] === "JobPosting") into.push(record);
  if (record["@graph"]) collectJobPostings(record["@graph"], into);
  if (record.itemListElement) collectJobPostings(record.itemListElement, into);
}

/** Employer career pages that publish schema.org JobPosting JSON-LD. */
export async function discoverFromCareerPages(pages: string[]): Promise<RawDiscovery> {
  const out: RawDiscovery = emptyRaw();
  if (pages.length === 0) return out;
  const source = one<{ enabled: number }>("SELECT enabled FROM job_sources WHERE key = 'career_pages'");
  if (source && source.enabled !== 1) {
    out.error = "The employer career page connector is disabled in Job discovery → Sources.";
    return out;
  }

  for (const page of pages) {
    const pageUrl = page.trim();
    if (!/^https?:\/\//i.test(pageUrl)) continue;
    out.requests += 1;
    const freshBefore = out.fresh;
    const filteredBefore = out.filtered;
    let postingCount = 0;
    try {
      const request = await requestText(pageUrl, {
        timeoutMs: 20_000,
        label: new URL(pageUrl).hostname,
      });
      out.attempts += request.attempts;
      out.durationMs += request.durationMs;
      out.diagnostics.push(...request.diagnostics);
      if (!request.ok || request.data === null) {
        out.error = request.error ?? `${pageUrl} could not be read.`;
        out.errorCategory = request.errorCategory ?? "unknown";
        recordSourceCheck({
          key: `career:${new URL(pageUrl).hostname}`,
          employer: new URL(pageUrl).hostname,
          endpoint: pageUrl,
          method: "schema.org JobPosting on employer page",
          ok: false,
          postings: 0,
          fresh: 0,
          relevant: 0,
          error: out.error,
          errorCategory: out.errorCategory,
          statusCode: request.statusCode,
          attempts: request.attempts,
          durationMs: request.durationMs,
        });
        continue;
      }
      out.responses += 1;
      const html = request.data;
      const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      const postings: JsonLdNode[] = [];
      for (const block of blocks) {
        try {
          collectJobPostings(JSON.parse(block[1]), postings);
        } catch {
          // A malformed block is skipped; valid blocks on the same page still count.
        }
      }
      postingCount = postings.length;
      out.fetched += postings.length;
      const host = new URL(pageUrl).hostname.replace(/^www\./, "");
      for (const posting of postings) {
        const title = asText(posting.title);
        const description = htmlToText(asText(posting.description)).trim();
        const company = asText(posting.hiringOrganization) || host;
        const location = asText(posting.jobLocation) || (posting.applicantLocationRequirements ? asText(posting.applicantLocationRequirements) : "") || "Not specified";
        const remote = /remote|telecommute/i.test(`${asText(posting.jobLocationType)} ${description.slice(0, 400)}`);
        const url = asText(posting.url) || pageUrl;
        const fresh = publishedWithinSevenDays(asText(posting.datePosted) || null);
        if (fresh) out.fresh += 1;
        const reason = titleFiltered(title, company, location, description);
        if (reason) {
          out.filtered += 1;
          continue;
        }
        const validThrough = asText(posting.validThrough);
        if (validThrough && Date.parse(validThrough) < Date.now()) {
          out.filtered += 1;
          continue;
        }
        if (!fresh) {
          out.filtered += 1;
          continue;
        }
        out.jobs.push({
          source: `career:${host}`,
          sourcePlatform: `Employer careers · ${host}`,
          externalId: asText(posting.identifier) || url,
          title,
          company,
          companyDomain: host,
          location,
          remote,
          employmentType: Array.isArray(posting.employmentType) ? posting.employmentType.join(", ") : asText(posting.employmentType) || null,
          salary: asText(posting.baseSalary) || null,
          url,
          applicationUrl: url,
          description,
          publishedAt: asText(posting.datePosted) || null,
          raw: { page: pageUrl, identifier: asText(posting.identifier) },
        });
      }
      recordSourceCheck({
        key: `career:${host}`,
        employer: host,
        endpoint: pageUrl,
        method: "schema.org JobPosting on employer page",
        ok: true,
        postings: postingCount,
        fresh: out.fresh - freshBefore,
        relevant: Math.max(0, postingCount - (out.filtered - filteredBefore)),
        error: null,
        errorCategory: null,
        statusCode: request.statusCode,
        attempts: request.attempts,
        durationMs: request.durationMs,
      });
    } catch (error) {
      out.error = error instanceof Error ? error.message : `${pageUrl} could not be reached.`;
      out.errorCategory = "unknown";
    }
  }
  return out;
}

type GreenhouseJob = {
  id?: number | string;
  title?: string;
  updated_at?: string;
  first_published?: string;
  absolute_url?: string;
  location?: { name?: string };
  content?: string;
  company_name?: string;
};

/** Public Greenhouse job-board API: https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true */
export async function discoverFromGreenhouse(boards: string[]): Promise<RawDiscovery> {
  const out = emptyRaw();
  if (boards.length === 0) return out;
  const source = one<{ enabled: number }>("SELECT enabled FROM job_sources WHERE key = 'greenhouse'");
  if (source && source.enabled !== 1) {
    out.error = "The Greenhouse connector is disabled in Job discovery → Sources.";
    return out;
  }
  for (const board of boards) {
    const token = board
      .trim()
      .replace(/^https?:\/\/boards\.greenhouse\.io\//i, "")
      .replace(/\/+$/, "");
    if (!token) continue;
    out.requests += 1;
    const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
    const freshBefore = out.fresh;
    const filteredBefore = out.filtered;
    let postingCount = 0;
    try {
      const request = await requestJson<{ jobs?: GreenhouseJob[] }>(endpoint, {
        timeoutMs: 20_000,
        label: `Greenhouse board ${token}`,
      });
      out.attempts += request.attempts;
      out.durationMs += request.durationMs;
      out.diagnostics.push(...request.diagnostics);
      if (!request.ok || !request.data) {
        out.error = request.error ?? `Greenhouse board ${token} could not be read.`;
        out.errorCategory = request.errorCategory ?? "unknown";
        recordSourceCheck({
          key: "greenhouse",
          employer: token,
          endpoint,
          method: "Public Greenhouse job-board API",
          ok: false,
          postings: 0,
          fresh: 0,
          relevant: 0,
          error: out.error,
          errorCategory: out.errorCategory,
          statusCode: request.statusCode,
          attempts: request.attempts,
          durationMs: request.durationMs,
        });
        continue;
      }
      out.responses += 1;
      const postings = request.data.jobs ?? [];
      postingCount = postings.length;
      out.fetched += postings.length;
      const company = prettifySlug(token);
      for (const posting of postings) {
        const title = (posting.title ?? "").trim();
        const description = htmlToText(posting.content ?? "").trim();
        const location = posting.location?.name?.trim() || "Not specified";
        const posted = posting.first_published ?? posting.updated_at ?? null;
        const fresh = publishedWithinSevenDays(posted);
        if (fresh) out.fresh += 1;
        const employer = (posting.company_name ?? "").trim() || company;
        const reason = titleFiltered(title, employer, location, description);
        if (reason) {
          out.filtered += 1;
          continue;
        }
        if (!fresh) {
          out.filtered += 1;
          continue;
        }
        const url = posting.absolute_url ?? "";
        if (!url) {
          out.filtered += 1;
          continue;
        }
        out.jobs.push({
          source: `greenhouse:${token}`,
          sourcePlatform: `Greenhouse · ${token}`,
          externalId: posting.id ? String(posting.id) : url,
          title,
          company: employer,
          companyDomain: companyDomain(employer, url),
          location,
          remote: /remote/i.test(location) || /remote|anywhere|distributed/i.test(description.slice(0, 400)),
          employmentType: null,
          salary: null,
          url,
          applicationUrl: url,
          description,
          publishedAt: posted,
          raw: { board: token, id: posting.id },
        });
      }
      recordSourceCheck({
        key: "greenhouse",
        employer: token,
        endpoint,
        method: "Public Greenhouse job-board API",
        ok: true,
        postings: postingCount,
        fresh: out.fresh - freshBefore,
        relevant: Math.max(0, postingCount - (out.filtered - filteredBefore)),
        error: null,
        errorCategory: null,
        statusCode: request.statusCode,
        attempts: request.attempts,
        durationMs: request.durationMs,
      });
    } catch (error) {
      out.error = error instanceof Error ? error.message : `Greenhouse board ${token} could not be reached.`;
      out.errorCategory = "unknown";
      recordSourceCheck({
        key: "greenhouse",
        employer: token,
        endpoint,
        method: "Public Greenhouse job-board API",
        ok: false,
        postings: postingCount,
        fresh: out.fresh - freshBefore,
        relevant: 0,
        error: out.error,
        errorCategory: "unknown",
        statusCode: null,
        attempts: 0,
        durationMs: 0,
      });
    }
  }
  return out;
}

type LeverPosting = {
  id?: string;
  text?: string;
  createdAt?: number;
  hostedUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  description?: string;
  workplaceType?: string;
  categories?: { location?: string; commitment?: string; team?: string };
};

/** Public Lever postings API: https://api.lever.co/v0/postings/<site>?mode=json */
export async function discoverFromLever(sites: string[]): Promise<RawDiscovery> {
  const out = emptyRaw();
  if (sites.length === 0) return out;
  const source = one<{ enabled: number }>("SELECT enabled FROM job_sources WHERE key = 'lever'");
  if (source && source.enabled !== 1) {
    out.error = "The Lever connector is disabled in Job discovery → Sources.";
    return out;
  }
  for (const site of sites) {
    const slug = site.trim().replace(/^https?:\/\/jobs\.lever\.co\//i, "").replace(/\/+$/, "");
    if (!slug) continue;
    out.requests += 1;
    const endpoint = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
    const freshBefore = out.fresh;
    const filteredBefore = out.filtered;
    let postingCount = 0;
    try {
      const request = await requestJson<LeverPosting[]>(endpoint, {
        timeoutMs: 20_000,
        label: `Lever site ${slug}`,
      });
      out.attempts += request.attempts;
      out.durationMs += request.durationMs;
      out.diagnostics.push(...request.diagnostics);
      if (!request.ok || !request.data) {
        out.error = request.error ?? `Lever site ${slug} could not be read.`;
        out.errorCategory = request.errorCategory ?? "unknown";
        recordSourceCheck({
          key: "lever",
          employer: slug,
          endpoint,
          method: "Public Lever postings API",
          ok: false,
          postings: 0,
          fresh: 0,
          relevant: 0,
          error: out.error,
          errorCategory: out.errorCategory,
          statusCode: request.statusCode,
          attempts: request.attempts,
          durationMs: request.durationMs,
        });
        continue;
      }
      out.responses += 1;
      const postings = request.data;
      postingCount = postings.length;
      out.fetched += postings.length;
      const company = prettifySlug(slug);
      for (const posting of postings) {
        const title = (posting.text ?? "").trim();
        const description = (posting.descriptionPlain ?? htmlToText(posting.description ?? "")).trim();
        const location = posting.categories?.location?.trim() || "Not specified";
        const posted = posting.createdAt ? new Date(posting.createdAt).toISOString() : null;
        const fresh = publishedWithinSevenDays(posted);
        if (fresh) out.fresh += 1;
        const reason = titleFiltered(title, company, location, description);
        if (reason) {
          out.filtered += 1;
          continue;
        }
        if (!fresh) {
          out.filtered += 1;
          continue;
        }
        const url = posting.hostedUrl || posting.applyUrl || "";
        if (!url) {
          out.filtered += 1;
          continue;
        }
        out.jobs.push({
          source: `lever:${slug}`,
          sourcePlatform: `Lever · ${slug}`,
          externalId: posting.id ?? url,
          title,
          company,
          companyDomain: companyDomain(company, url),
          location,
          remote:
            /remote/i.test(posting.workplaceType ?? "") ||
            /remote|anywhere|distributed/i.test(`${location} ${description.slice(0, 400)}`),
          employmentType: posting.categories?.commitment ?? null,
          salary: null,
          url,
          applicationUrl: posting.applyUrl ?? url,
          description,
          publishedAt: posted,
          raw: { site: slug, id: posting.id, team: posting.categories?.team },
        });
      }
      recordSourceCheck({
        key: "lever",
        employer: slug,
        endpoint,
        method: "Public Lever postings API",
        ok: true,
        postings: postingCount,
        fresh: out.fresh - freshBefore,
        relevant: Math.max(0, postingCount - (out.filtered - filteredBefore)),
        error: null,
        errorCategory: null,
        statusCode: request.statusCode,
        attempts: request.attempts,
        durationMs: request.durationMs,
      });
    } catch (error) {
      out.error = error instanceof Error ? error.message : `Lever site ${slug} could not be reached.`;
      out.errorCategory = "unknown";
      recordSourceCheck({
        key: "lever",
        employer: slug,
        endpoint,
        method: "Public Lever postings API",
        ok: false,
        postings: postingCount,
        fresh: out.fresh - freshBefore,
        relevant: 0,
        error: out.error,
        errorCategory: "unknown",
        statusCode: null,
        attempts: 0,
        durationMs: 0,
      });
    }
  }
  return out;
}

export type SourceHealth = {
  source_key: string;
  employer: string | null;
  endpoint: string;
  method: string;
  ok: number;
  postings: number;
  fresh: number;
  relevant: number;
  error: string | null;
  error_category: string | null;
  status_code: number | null;
  last_attempts: number;
  last_duration_ms: number;
  last_checked_at: string;
  last_success_at: string | null;
};

/** Persist the real retrieval evidence for one connector/endpoint. */
export function recordSourceCheck(input: {
  key: string;
  employer: string | null;
  endpoint: string;
  method: string;
  ok: boolean;
  postings: number;
  fresh: number;
  relevant: number;
  error: string | null;
  errorCategory?: SourceErrorCategory | null;
  statusCode?: number | null;
  attempts?: number;
  durationMs?: number;
}): void {
  const at = nowIso();
  run(
    `INSERT INTO discovery_source_status
       (source_key, employer, endpoint, method, ok, postings, fresh, relevant, error, error_category, status_code, last_attempts, last_duration_ms, last_checked_at, last_success_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key, endpoint) DO UPDATE SET
       employer = excluded.employer, method = excluded.method, ok = excluded.ok,
       postings = excluded.postings, fresh = excluded.fresh, relevant = excluded.relevant,
       error = excluded.error, error_category = excluded.error_category, status_code = excluded.status_code,
       last_attempts = excluded.last_attempts, last_duration_ms = excluded.last_duration_ms,
       last_checked_at = excluded.last_checked_at,
       last_success_at = CASE WHEN excluded.ok = 1 THEN excluded.last_checked_at ELSE discovery_source_status.last_success_at END`,
    [
      input.key,
      input.employer,
      input.endpoint.slice(0, 500),
      input.method,
      input.ok ? 1 : 0,
      input.postings,
      input.fresh,
      input.relevant,
      input.error ? input.error.slice(0, 1000) : null,
      input.errorCategory ?? null,
      input.statusCode ?? null,
      Math.max(0, input.attempts ?? 0),
      Math.max(0, input.durationMs ?? 0),
      at,
      input.ok ? at : null,
    ],
  );
}

export function sourceHealth(): SourceHealth[] {
  return all<SourceHealth>("SELECT * FROM discovery_source_status ORDER BY source_key, employer");
}

/**
 * jobs.ch public search API. Verified 2026-11-18: HTTP 200 JSON, with a
 * schema.org JobPosting block on each detail page carrying the full description.
 * The query is explicit; no speculative board token is involved.
 */
type JobsChDocument = {
  job_id?: string;
  title?: string;
  company_name?: string;
  place?: string;
  publication_date?: string;
  preview?: string;
  language_skills?: Array<{ language?: string; level?: number }>;
  employment_type_ids?: string[];
  _links?: { detail_en?: { href?: string }; detail_de?: { href?: string } };
};

export async function discoverFromJobsCh(
  queries: string[],
  options: { page?: number; detailsPerQuery?: number } = {},
): Promise<RawDiscovery> {
  const out = emptyRaw();
  const page = Math.min(2, Math.max(1, Math.floor(options.page ?? 1)));
  const detailsPerQuery = Math.min(8, Math.max(0, Math.floor(options.detailsPerQuery ?? 8)));
  if (queries.length === 0) return out;
  const source = one<{ enabled: number }>("SELECT enabled FROM job_sources WHERE key = 'jobs_ch'");
  if (source && source.enabled !== 1) {
    out.error = "The jobs.ch connector is disabled in Job discovery → Sources.";
    return out;
  }

  const seenJobIds = new Set<string>();
  for (const rawQuery of queries) {
    const query = rawQuery.trim();
    if (!query) continue;
    // jobs.ch rejects rows > 20 with HTTP 422 (verified 2026-11-18).
    // The public response exposes current_page/num_pages; Phase 1 fetches only
    // one additional page and splits the existing detail budget across both.
    const endpoint = `https://www.jobs.ch/api/v1/public/search?query=${encodeURIComponent(query)}&rows=20&page=${page}`;
    out.requests += 1;
    const filteredBefore = out.filtered;
    const freshBefore = out.fresh;
    let postings = 0;
    try {
      const request = await requestJson<{ documents?: JobsChDocument[]; num_pages?: number }>(endpoint, {
        timeoutMs: 20_000,
        label: "jobs.ch",
      });
      out.attempts += request.attempts;
      out.durationMs += request.durationMs;
      out.diagnostics.push(...request.diagnostics);
      if (!request.ok || !request.data) {
        out.error = request.error ?? `jobs.ch query "${query}" could not be read.`;
        out.errorCategory = request.errorCategory ?? "unknown";
        recordSourceCheck({
          key: "jobs_ch",
          employer: "jobs.ch (aggregated Swiss employers)",
          endpoint,
          method: "Public search JSON + schema.org JobPosting detail",
          ok: false,
          postings: 0,
          fresh: 0,
          relevant: 0,
          error: out.error,
          errorCategory: out.errorCategory,
          statusCode: request.statusCode,
          attempts: request.attempts,
          durationMs: request.durationMs,
        });
        continue;
      }
      out.responses += 1;
      out.numPages = Math.max(out.numPages ?? 1, Math.min(2, Number(request.data.num_pages ?? 1) || 1));
      const documents = request.data.documents ?? [];
      postings = documents.length;
      out.fetched += documents.length;
      let detailBudget = detailsPerQuery;
      for (const document of documents) {
        // The same vacancy can match several queries; it is fetched and counted
        // once per run rather than being sent through detail retrieval twice.
        if (document.job_id && seenJobIds.has(document.job_id)) {
          out.filtered += 1;
          continue;
        }
        if (document.job_id) seenJobIds.add(document.job_id);
        const title = (document.title ?? "").trim();
        const preview = (document.preview ?? "").trim();
        const publishedAt = document.publication_date ?? null;
        const fresh = publishedWithinSevenDays(publishedAt);
        if (fresh) out.fresh += 1;
        const classification = classifyVacancy({
          title,
          company: document.company_name,
          location: document.place,
          description: preview,
        });
        if (!classification.isQa) {
          out.filtered += 1;
          continue;
        }
        if (!fresh) {
          out.filtered += 1;
          continue;
        }
        if (detailBudget <= 0) {
          out.filtered += 1;
          continue;
        }
        detailBudget -= 1;

        const detailUrl = document._links?.detail_en?.href ?? document._links?.detail_de?.href ?? null;
        let description = preview;
        let posting: JsonLdNode | null = null;
        if (detailUrl) {
          try {
            out.requests += 1;
            const detail = await requestText(detailUrl, { timeoutMs: 20_000, label: "jobs.ch detail" });
            out.attempts += detail.attempts;
            out.durationMs += detail.durationMs;
            out.diagnostics.push(...detail.diagnostics);
            if (detail.ok && detail.data !== null) {
              out.responses += 1;
              const html = detail.data;
              const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
              const parsed: JsonLdNode[] = [];
              for (const block of blocks) {
                try {
                  collectJobPostings(JSON.parse(block[1]), parsed);
                } catch {
                  // A malformed block is skipped; valid blocks still count.
                }
              }
              posting = parsed[0] ?? null;
              const fullDescription = posting ? htmlToText(asText(posting.description)).trim() : "";
              if (fullDescription.length > description.length) description = fullDescription;
            }
          } catch {
            // The search preview is still usable; the source check records the failure below.
          }
        }

        const reason = titleFiltered(title, document.company_name ?? "", document.place ?? "", description);
        if (reason) {
          out.filtered += 1;
          continue;
        }
        const location = (document.place ?? "").trim() || asText(posting?.jobLocation) || "Not specified";
        const url = asText(posting?.url) || detailUrl || "";
        if (!url) {
          out.filtered += 1;
          continue;
        }
        const employer = (document.company_name ?? "").trim();
        out.jobs.push({
          source: "jobs_ch",
          sourcePlatform: "jobs.ch · Swiss job board",
          externalId: document.job_id ?? url,
          title,
          company: employer || "Unknown employer",
          companyDomain: companyDomain(employer, url),
          location,
          remote: /remote|home[- ]office|telecommut/i.test(`${location} ${description.slice(0, 500)}`),
          employmentType: (document.employment_type_ids ?? []).join(", ") || null,
          salary: null,
          url,
          applicationUrl: url,
          description,
          publishedAt,
          raw: { job_id: document.job_id, query, page, publication_date: publishedAt, languages: document.language_skills },
        });
      }
      recordSourceCheck({
        key: "jobs_ch",
        employer: "jobs.ch (aggregated Swiss employers)",
        endpoint,
        method: "Public search JSON + schema.org JobPosting detail",
        ok: true,
        postings,
        fresh: out.fresh - freshBefore,
        relevant: Math.max(0, postings - (out.filtered - filteredBefore)),
        error: null,
        errorCategory: null,
        statusCode: request.statusCode,
        attempts: request.attempts,
        durationMs: request.durationMs,
      });
    } catch (error) {
      out.error = error instanceof Error ? error.message : `jobs.ch query "${query}" could not be reached.`;
      out.errorCategory = "unknown";
      recordSourceCheck({
        key: "jobs_ch",
        employer: "jobs.ch (aggregated Swiss employers)",
        endpoint,
        method: "Public search JSON + schema.org JobPosting detail",
        ok: false,
        postings,
        fresh: 0,
        relevant: 0,
        error: out.error,
        errorCategory: "unknown",
        statusCode: null,
        attempts: 0,
        durationMs: 0,
      });
    }
  }
  return out;
}

export function configuredJobsChQueries(): string[] {
  const fromSetting = getSetting<string[]>("jobs_ch_queries", []);
  const value =
    fromSetting.length > 0
      ? fromSetting
      : (process.env.JOBS_CH_QUERIES ?? "")
          .split("|")
          .map((item) => item.trim())
          .filter(Boolean);
  return [...new Set(value)];
}

export function configuredAshbyBoards(): string[] {
  const fromSetting = getSetting<string[]>("ashby_job_boards", []);
  const value = fromSetting.length > 0 ? fromSetting : (process.env.ASHBY_JOB_BOARDS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

export function configuredCareerPages(): string[] {
  const fromSetting = getSetting<string[]>("employer_career_pages", []);
  const value = fromSetting.length > 0 ? fromSetting : (process.env.EMPLOYER_CAREER_PAGES ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(value.filter((item) => /^https?:\/\//i.test(item)))];
}

export function configuredGreenhouseBoards(): string[] {
  const fromSetting = getSetting<string[]>("greenhouse_boards", []);
  const value = fromSetting.length > 0 ? fromSetting : (process.env.GREENHOUSE_BOARDS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(value)];
}

export function configuredLeverSites(): string[] {
  const fromSetting = getSetting<string[]>("lever_sites", []);
  const value = fromSetting.length > 0 ? fromSetting : (process.env.LEVER_SITES ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(value)];
}

/**
 * Runs every connector for one daily run. A source that fails is recorded and
 * the remaining sources still contribute; the run never reports a source as
 * searched when it errored.
 */
export async function discoverJobSources(options: {
  runId: string;
  pages?: number;
  ashbyBoards?: string[];
  careerPages?: string[];
  greenhouseBoards?: string[];
  leverSites?: string[];
  jobsChQueries?: string[];
}): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    discovered: 0,
    inserted: 0,
    duplicates: 0,
    filtered: 0,
    jobIds: [],
    sources: [],
    warnings: [],
  };
  const pages = Math.min(5, Math.max(1, options.pages ?? 2));

  const research = await researchJobs(pages, 40);
  logSourceDiagnostics(options.runId, "arbeitnow", research.diagnostics);
  result.inserted += research.inserted;
  result.duplicates += research.duplicates;
  result.filtered += research.filteredOut;
  for (const job of research.jobs) {
    run("UPDATE jobs SET run_id = ?, source_platform = COALESCE(source_platform, 'Arbeitnow') WHERE id = ?", [options.runId, job.id]);
    result.jobIds.push(job.id);
  }
  result.sources.push({
    key: "arbeitnow",
    label: "Arbeitnow job board",
    fetched: research.fetched,
    inserted: research.inserted,
    error: research.error ?? null,
    requests: research.requests,
    responses: research.responses,
    fresh: research.fresh,
    relevant: Math.max(0, research.fetched - research.filteredOut),
    duplicates: research.duplicates,
    configured: true,
    status: research.error ? (research.responses > 0 ? "partial" : "failed") : research.fetched === 0 ? "empty" : "ok",
    attempts: research.attempts,
    durationMs: research.durationMs,
    errorCategory: research.errorCategory ?? null,
  });
  if (research.error) result.warnings.push(`Arbeitnow: ${research.error}`);
  recordSourceCheck({
    key: "arbeitnow",
    employer: "Arbeitnow feed (aggregated employers)",
    endpoint: process.env.ARBEITNOW_API_URL ?? "https://www.arbeitnow.com/api/job-board-api",
    method: "Public job-board JSON feed",
    ok: !research.error,
    postings: research.fetched,
    fresh: research.fresh,
    relevant: Math.max(0, research.fetched - research.filteredOut),
    error: research.error ?? null,
    errorCategory: research.errorCategory ?? null,
    attempts: research.attempts,
    durationMs: research.durationMs,
  });

  const boards = options.ashbyBoards ?? configuredAshbyBoards();
  const ashby = await discoverFromAshby(boards);
  logSourceDiagnostics(options.runId, "ashby", ashby.diagnostics);
  let ashbyInserted = 0;
  let ashbyDuplicates = 0;
  for (const job of ashby.jobs) {
    const id = insertDiscovered(job, options.runId);
    if (id) {
      ashbyInserted += 1;
      result.jobIds.push(id);
    } else {
      ashbyDuplicates += 1;
    }
  }
  result.inserted += ashbyInserted;
  result.duplicates += ashbyDuplicates;
  result.filtered += ashby.filtered;
  result.sources.push({
    key: "ashby",
    label: `Ashby boards (${boards.length} configured)`,
    fetched: ashby.fetched,
    inserted: ashbyInserted,
    error: ashby.error,
    requests: ashby.requests,
    responses: ashby.responses,
    fresh: ashby.fresh,
    relevant: Math.max(0, ashby.fetched - ashby.filtered),
    duplicates: ashbyDuplicates,
    configured: boards.length > 0,
    status: boards.length === 0 ? "skipped" : ashby.responses === 0 ? "failed" : ashby.error ? "partial" : ashby.fetched === 0 ? "empty" : "ok",
    attempts: ashby.attempts,
    durationMs: ashby.durationMs,
    errorCategory: ashby.errorCategory,
  });
  if (ashby.error) result.warnings.push(`Ashby: ${ashby.error}`);

  const greenhouseBoards = options.greenhouseBoards ?? configuredGreenhouseBoards();
  const greenhouse = await discoverFromGreenhouse(greenhouseBoards);
  logSourceDiagnostics(options.runId, "greenhouse", greenhouse.diagnostics);
  let greenhouseInserted = 0;
  let greenhouseDuplicates = 0;
  for (const job of greenhouse.jobs) {
    const id = insertDiscovered(job, options.runId);
    if (id) {
      greenhouseInserted += 1;
      result.jobIds.push(id);
    } else {
      greenhouseDuplicates += 1;
    }
  }
  result.inserted += greenhouseInserted;
  result.duplicates += greenhouseDuplicates;
  result.filtered += greenhouse.filtered;
  result.sources.push({
    key: "greenhouse",
    label: `Greenhouse boards (${greenhouseBoards.length} configured)`,
    fetched: greenhouse.fetched,
    inserted: greenhouseInserted,
    error: greenhouse.error,
    requests: greenhouse.requests,
    responses: greenhouse.responses,
    fresh: greenhouse.fresh,
    relevant: Math.max(0, greenhouse.fetched - greenhouse.filtered),
    duplicates: greenhouseDuplicates,
    configured: greenhouseBoards.length > 0,
    status: greenhouseBoards.length === 0 ? "skipped" : greenhouse.responses === 0 ? "failed" : greenhouse.error ? "partial" : greenhouse.fetched === 0 ? "empty" : "ok",
    attempts: greenhouse.attempts,
    durationMs: greenhouse.durationMs,
    errorCategory: greenhouse.errorCategory,
  });
  if (greenhouse.error) result.warnings.push(`Greenhouse: ${greenhouse.error}`);

  const leverSites = options.leverSites ?? configuredLeverSites();
  const lever = await discoverFromLever(leverSites);
  logSourceDiagnostics(options.runId, "lever", lever.diagnostics);
  let leverInserted = 0;
  let leverDuplicates = 0;
  for (const job of lever.jobs) {
    const id = insertDiscovered(job, options.runId);
    if (id) {
      leverInserted += 1;
      result.jobIds.push(id);
    } else {
      leverDuplicates += 1;
    }
  }
  result.inserted += leverInserted;
  result.duplicates += leverDuplicates;
  result.filtered += lever.filtered;
  result.sources.push({
    key: "lever",
    label: `Lever sites (${leverSites.length} configured)`,
    fetched: lever.fetched,
    inserted: leverInserted,
    error: lever.error,
    requests: lever.requests,
    responses: lever.responses,
    fresh: lever.fresh,
    relevant: Math.max(0, lever.fetched - lever.filtered),
    duplicates: leverDuplicates,
    configured: leverSites.length > 0,
    status: leverSites.length === 0 ? "skipped" : lever.responses === 0 ? "failed" : lever.error ? "partial" : lever.fetched === 0 ? "empty" : "ok",
    attempts: lever.attempts,
    durationMs: lever.durationMs,
    errorCategory: lever.errorCategory,
  });
  if (lever.error) result.warnings.push(`Lever: ${lever.error}`);
  recordSourceCheck({
    key: "lever",
    employer: leverSites.join(", ") || null,
    endpoint: "https://api.lever.co/v0/postings",
    method: "Public Lever postings API",
    ok: !lever.error && lever.responses > 0,
    postings: lever.fetched,
    fresh: lever.fresh,
    relevant: Math.max(0, lever.fetched - lever.filtered),
    error: lever.error,
    errorCategory: lever.errorCategory,
    attempts: lever.attempts,
    durationMs: lever.durationMs,
  });

  const jobsChQueries = options.jobsChQueries ?? configuredJobsChQueries();
  const jobsChPageLimit = Math.min(2, Math.max(1, options.pages ?? 1));
  // Splitting the detail budget keeps a two-page run within the same maximum
  // number of full-detail fetches as the previous single-page connector.
  const jobsChDetailsPerQuery = jobsChPageLimit > 1 ? 4 : 8;
  const jobsCh = await discoverFromJobsCh(jobsChQueries, { page: 1, detailsPerQuery: jobsChDetailsPerQuery });
  if (jobsChPageLimit > 1 && (jobsCh.numPages ?? 1) > 1 && !jobsCh.error) {
    const secondPage = await discoverFromJobsCh(jobsChQueries, { page: 2, detailsPerQuery: jobsChDetailsPerQuery });
    jobsCh.jobs.push(...secondPage.jobs);
    jobsCh.fetched += secondPage.fetched;
    jobsCh.filtered += secondPage.filtered;
    jobsCh.fresh += secondPage.fresh;
    jobsCh.requests += secondPage.requests;
    jobsCh.responses += secondPage.responses;
    jobsCh.attempts += secondPage.attempts;
    jobsCh.durationMs += secondPage.durationMs;
    jobsCh.diagnostics.push(...secondPage.diagnostics);
    jobsCh.error = jobsCh.error ?? secondPage.error;
    jobsCh.errorCategory = jobsCh.errorCategory ?? secondPage.errorCategory;
  }
  logSourceDiagnostics(options.runId, "jobs_ch", jobsCh.diagnostics);
  let jobsChInserted = 0;
  let jobsChDuplicates = 0;
  for (const job of jobsCh.jobs) {
    const id = insertDiscovered(job, options.runId);
    if (id) {
      jobsChInserted += 1;
      result.jobIds.push(id);
    } else {
      jobsChDuplicates += 1;
    }
  }
  result.inserted += jobsChInserted;
  result.duplicates += jobsChDuplicates;
  result.filtered += jobsCh.filtered;
  result.sources.push({
    key: "jobs_ch",
    label: `jobs.ch (${jobsChQueries.length} verified queries, up to ${jobsChPageLimit} page${jobsChPageLimit === 1 ? "" : "s"})`,
    fetched: jobsCh.fetched,
    inserted: jobsChInserted,
    error: jobsCh.error,
    requests: jobsCh.requests,
    responses: jobsCh.responses,
    fresh: jobsCh.fresh,
    relevant: Math.max(0, jobsCh.fetched - jobsCh.filtered),
    duplicates: jobsChDuplicates,
    configured: jobsChQueries.length > 0,
    status: jobsChQueries.length === 0 ? "skipped" : jobsCh.responses === 0 ? "failed" : jobsCh.error ? "partial" : jobsCh.fetched === 0 ? "empty" : "ok",
    attempts: jobsCh.attempts,
    durationMs: jobsCh.durationMs,
    errorCategory: jobsCh.errorCategory,
  });
  if (jobsCh.error) result.warnings.push(`jobs.ch: ${jobsCh.error}`);

  const pagesConfig = options.careerPages ?? configuredCareerPages();
  const careers = await discoverFromCareerPages(pagesConfig);
  logSourceDiagnostics(options.runId, "career_pages", careers.diagnostics);
  let careerInserted = 0;
  let careerDuplicates = 0;
  for (const job of careers.jobs) {
    const id = insertDiscovered(job, options.runId);
    if (id) {
      careerInserted += 1;
      result.jobIds.push(id);
    } else {
      careerDuplicates += 1;
    }
  }
  result.inserted += careerInserted;
  result.duplicates += careerDuplicates;
  result.filtered += careers.filtered;
  result.sources.push({
    key: "career_pages",
    label: `Employer career pages (${pagesConfig.length} configured)`,
    fetched: careers.fetched,
    inserted: careerInserted,
    error: careers.error,
    requests: careers.requests,
    responses: careers.responses,
    fresh: careers.fresh,
    relevant: Math.max(0, careers.fetched - careers.filtered),
    duplicates: careerDuplicates,
    configured: pagesConfig.length > 0,
    status: pagesConfig.length === 0 ? "skipped" : careers.responses === 0 ? "failed" : careers.error ? "partial" : careers.fetched === 0 ? "empty" : "ok",
    attempts: careers.attempts,
    durationMs: careers.durationMs,
    errorCategory: careers.errorCategory,
  });
  if (careers.error) result.warnings.push(`Employer pages: ${careers.error}`);
  recordSourceCheck({
    key: "career_pages",
    employer: pagesConfig.map((page) => {
      try {
        return new URL(page).hostname;
      } catch {
        return page;
      }
    }).join(", ") || null,
    endpoint: "https://employer-careers (configured pages)",
    method: "schema.org JobPosting on employer pages",
    ok: !careers.error && careers.responses > 0,
    postings: careers.fetched,
    fresh: careers.fresh,
    relevant: Math.max(0, careers.fetched - careers.filtered),
    error: careers.error,
    errorCategory: careers.errorCategory,
    attempts: careers.attempts,
    durationMs: careers.durationMs,
  });

  const checked = result.sources.filter((source) => (source.requests ?? 0) > 0);
  const succeeded = checked.filter((source) => (source.responses ?? 0) > 0);
  const failed = checked.filter((source) => (source.responses ?? 0) === 0);
  const partial = succeeded.filter((source) => Boolean(source.error));
  result.sourcesChecked = checked.length;
  result.sourcesSucceeded = succeeded.length;
  result.sourcesFailed = failed.length;
  result.sourcesPartial = partial.length;
  result.allSourcesFailed = checked.length > 0 && succeeded.length === 0;
  result.discoveryState =
    checked.length === 0
      ? "not_configured"
      : succeeded.length === 0
        ? "failed"
        : partial.length > 0 || failed.length > 0
          ? "partial"
          : result.inserted === 0
            ? "empty"
            : "ok";
  if (result.allSourcesFailed) {
    result.warnings.push(
      `All ${checked.length} configured source(s) failed. No discovery success is claimed and no vacancy was invented.`,
    );
  } else if (checked.length === 0) {
    result.warnings.push("No job source is configured. Discovery did not run.");
  }
  result.discovered = result.inserted;
  return result;
}
