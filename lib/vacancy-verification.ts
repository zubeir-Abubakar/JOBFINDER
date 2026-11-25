import { one, run } from "./db";
import { isAggregatorUrl } from "./job-identity";
import { readLimitedText, safeFetch } from "./safe-http";

/**
 * Final vacancy verification.
 *
 * A stored listing is not proof that an employer is still accepting
 * applications. This module re-reads the application/listing page immediately
 * before document preparation and again before submission. It never invents an
 * expiry date: when the page provides no structured deadline, the result says
 * `unknown` and persists that fact.
 */

export type VacancyVerificationStatus = "open" | "closed" | "unverified";
export type VacancyCheckKind = "application" | "application_form" | "listing" | "employer";
export type VacancyCheck = {
  kind: VacancyCheckKind;
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  outcome: "open" | "closed" | "unavailable" | "not_available";
  detail: string;
  identityMatched: boolean;
};

/**
 * Route evidence is deliberately cumulative. A URL extracted from listing
 * metadata is only URL_RESOLVED; it becomes URL_REACHABLE, then identity and
 * open-vacancy verified only from the page actually read. Form support is
 * recorded separately because a reachable page can still be unsupported by the
 * local Playwright executor.
 */
export type ApplicationRouteStatus =
  | "URL_RESOLVED"
  | "URL_REACHABLE"
  | "EMPLOYER_IDENTITY_VERIFIED"
  | "VACANCY_OPEN_VERIFIED"
  | "APPLICATION_FORM_SUPPORTED"
  | "APPLICATION_ROUTE_UNRESOLVED";

export type ApplicationRouteVerification = {
  statuses: ApplicationRouteStatus[];
  finalStatus: ApplicationRouteStatus;
  urlResolved: boolean;
  urlReachable: boolean;
  employerIdentityVerified: boolean;
  vacancyOpenVerified: boolean;
  applicationFormSupported: boolean;
  finalUrl: string | null;
  finalHost: string | null;
  httpStatus: number | null;
  formEvidence: string[];
  reason: string;
};

export type VacancyVerification = {
  status: VacancyVerificationStatus;
  checkedAt: string;
  publishedAt: string | null;
  publicationStatus: "present" | "missing" | "unparseable";
  expiryAt: string | null;
  expiryStatus: "known" | "unknown";
  expirySource: "structured_data" | null;
  reason: string;
  checks: VacancyCheck[];
  route: ApplicationRouteVerification;
};

export type VacancyVerificationJob = {
  id?: string;
  title: string;
  company: string;
  url: string | null;
  application_url: string | null;
  description?: string | null;
  published_at?: string | null;
  company_domain?: string | null;
  source?: string | null;
  expiry_at?: string | null;
  ats_vendor?: string | null;
  url_confidence?: string | null;
  employer_url?: string | null;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CLOSED_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "applications closed", pattern: /\bapplications?\s+(?:are\s+)?(?:now\s+)?closed\b/i },
  { label: "no longer accepting applications", pattern: /\bno longer accepting applications\b/i },
  { label: "position filled", pattern: /\b(?:position|role|vacancy)\s+(?:has been\s+)?filled\b/i },
  { label: "job expired", pattern: /\b(?:job|vacancy|posting)\s+(?:has\s+)?expired\b/i },
  { label: "job removed", pattern: /\b(?:job|vacancy|posting)\s+(?:has been\s+)?(?:removed|withdrawn)\b/i },
  { label: "job not found", pattern: /\b(?:job|vacancy|posting)\s+(?:was\s+)?not found\b/i },
];

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function companyTokens(company: string): string[] {
  const suffix = /\b(?:ag|gmbh|sa|sarl|inc|ltd|limited|corp|corporation|group|schweiz|switzerland)\b/gi;
  return normalise(company.replace(suffix, " "))
    .split(" ")
    .filter((token) => token.length >= 3);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(Number(num)));
}

function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function structuredJobs(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record["@type"] === "JobPosting" || (Array.isArray(record["@type"]) && record["@type"].includes("JobPosting"))) {
      out.push(record);
    }
    for (const key of ["@graph", "itemListElement", "mainEntity", "item"]) visit(record[key]);
  };
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(match[1]));
    } catch {
      // A malformed block is ignored; another valid block may still describe the job.
    }
  }
  return out;
}

function structuredExpiry(html: string): string | null {
  for (const job of structuredJobs(html)) {
    for (const key of ["validThrough", "applicationDeadline", "expires"]) {
      const value = job[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  for (const match of html.matchAll(/(?:validThrough|applicationDeadline|application_deadline)["']?\s*[:=]\s*["']([^"']+)["']/gi)) {
    if (match[1]?.trim()) return match[1].trim();
  }
  return null;
}

function structuredIdentity(html: string): { titles: string[]; companies: string[] } {
  const titles: string[] = [];
  const companies: string[] = [];
  for (const job of structuredJobs(html)) {
    if (typeof job.title === "string") titles.push(job.title);
    const organization = job.hiringOrganization;
    if (organization && typeof organization === "object") {
      const name = (organization as Record<string, unknown>).name;
      if (typeof name === "string") companies.push(name);
    } else if (typeof organization === "string") {
      companies.push(organization);
    }
  }
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  if (titleTag) titles.push(decodeEntities(titleTag));
  return { titles, companies };
}

function identityMatches(html: string, job: VacancyVerificationJob): boolean {
  const text = normalise(visibleText(html));
  const title = normalise(job.title);
  if (title.length >= 5 && text.includes(title)) return true;
  const titleTokens = title.split(" ").filter((token) => token.length > 2);
  const titleHits = titleTokens.filter((token) => text.includes(token)).length;
  if (titleTokens.length > 0 && titleHits / titleTokens.length >= 0.6) return true;
  const company = companyTokens(job.company);
  return company.length > 0 && company.every((token) => text.includes(token));
}

function closedSignal(html: string): string | null {
  const text = visibleText(html);
  for (const item of CLOSED_PATTERNS) {
    const match = text.match(item.pattern);
    if (match) return match[0];
  }
  return null;
}

const KNOWN_APPLICATION_VENDORS = new Set([
  "greenhouse",
  "lever",
  "ashby",
  "workday",
  "smartrecruiters",
  "personio",
  "recruitee",
  "teamtailor",
  "bamboohr",
  "onlyfy",
  "prospective",
  "join",
]);

function applicationFormEvidence(html: string, vendor: string | null): string[] {
  const evidence: string[] = [];
  const form = /<form\b/i.test(html);
  const upload = /<input[^>]+type=["']file["']/i.test(html);
  const email = /<input[^>]+type=["']email["']|<input[^>]+name=["'][^"']*email/i.test(html);
  const embedded = /<iframe\b[^>]+src\s*=\s*["']https?:\/\//i.test(html);
  if (form) evidence.push("HTML form element");
  if (upload) evidence.push("CV/document upload control");
  if (email) evidence.push("email contact control");
  if (embedded) evidence.push("embedded third-party iframe (unsupported by the local executor)");
  if (form && vendor && KNOWN_APPLICATION_VENDORS.has(vendor)) evidence.push(`${vendor} application route`);
  return evidence;
}

/** Follow only an explicit apply link that the employer page itself publishes. */
function explicitApplyLink(html: string, base: string | null): string | null {
  if (!base) return null;
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    if (!href || href.startsWith("#")) continue;
    const label = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!/\b(apply(?: now)?|bewerben|jetzt bewerben|application form|online bewerben)\b/i.test(label)) continue;
    try {
      const url = new URL(href, base);
      const baseUrl = new URL(base);
      if (url.origin === baseUrl.origin && url.pathname === baseUrl.pathname) continue;
      if (!/^https?:$/.test(url.protocol) || isAggregatorUrl(url.href)) continue;
      return url.href;
    } catch {
      // A malformed explicit link is skipped; it is never guessed.
    }
  }
  return null;
}

function usableUrls(job: VacancyVerificationJob, employerUrl: string | null): Array<{ kind: VacancyCheckKind; url: string }> {
  const seen = new Set<string>();
  const entries: Array<{ kind: VacancyCheckKind; url: string }> = [];
  const add = (kind: VacancyCheckKind, raw: string | null | undefined) => {
    if (!raw) return;
    try {
      const parsed = new URL(raw);
      if (!/^https?:$/.test(parsed.protocol)) return;
      const normalisedUrl = parsed.href;
      if (seen.has(normalisedUrl)) return;
      seen.add(normalisedUrl);
      entries.push({ kind, url: normalisedUrl });
    } catch {
      // A malformed URL cannot be verified; the result remains unverified.
    }
  };
  add("application", job.application_url);
  add("listing", job.url);
  add("employer", employerUrl);
  return entries;
}

function configuredEmployerPage(job: VacancyVerificationJob): string | null {
  if (job.source?.startsWith("career:")) return job.application_url ?? job.url;
  const configured = (process.env.EMPLOYER_CAREER_PAGES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length === 0) return null;
  const company = companyTokens(job.company);
  const domain = (job.company_domain ?? "").toLowerCase().replace(/^www\./, "").replace(/\.unknown$/, "");
  for (const value of configured) {
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
      if (domain && host === domain) return value;
      const root = host.split(".")[0];
      if (company.some((token) => token === root || token.startsWith(root) || root.startsWith(token))) return value;
    } catch {
      // Ignore a malformed configured career page.
    }
  }
  return null;
}

async function checkPage(input: {
  kind: VacancyCheckKind;
  url: string;
  job: VacancyVerificationJob;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<{ check: VacancyCheck; html: string; expiry: string | null }> {
  try {
    const response = await input.fetchImpl(input.url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "AT-AI-Workforce/2.3 (vacancy verification)",
      },
      signal: AbortSignal.timeout(input.timeoutMs),
      cache: "no-store",
    });
    const html = response.ok ? await readLimitedText(response, 2_000_000) : "";
    if (response.status === 404 || response.status === 410) {
      return {
        check: {
          kind: input.kind,
          url: input.url,
          finalUrl: response.url || null,
          httpStatus: response.status,
          outcome: "closed",
          detail: `The page returned HTTP ${response.status}, so the listing is treated as removed.`,
          identityMatched: false,
        },
        html,
        expiry: null,
      };
    }
    if (!response.ok) {
      return {
        check: {
          kind: input.kind,
          url: input.url,
          finalUrl: response.url || null,
          httpStatus: response.status,
          outcome: "unavailable",
          detail: `The page returned HTTP ${response.status}; availability could not be verified.`,
          identityMatched: false,
        },
        html,
        expiry: null,
      };
    }
    const closed = closedSignal(html);
    const matched = identityMatches(html, input.job);
    const expiry = structuredExpiry(html);
    return {
      check: {
        kind: input.kind,
        url: input.url,
        finalUrl: response.url || null,
        httpStatus: response.status,
        outcome: closed ? "closed" : "open",
        detail: closed
          ? `The page states “${closed}”.`
          : matched
            ? "HTTP 200; the vacancy title or employer appears on the page."
            : "HTTP 200, but the vacancy title and employer were not found; the page may be a generic careers page.",
        identityMatched: matched,
      },
      html,
      expiry,
    };
  } catch (error) {
    return {
      check: {
        kind: input.kind,
        url: input.url,
        finalUrl: null,
        httpStatus: null,
        outcome: "unavailable",
        detail: `The page could not be read: ${error instanceof Error ? error.message : "unknown network error"}.`,
        identityMatched: false,
      },
      html: "",
      expiry: null,
    };
  }
}

export async function verifyVacancy(
  job: VacancyVerificationJob,
  options: {
    now?: Date;
    employerUrl?: string | null;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<VacancyVerification> {
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const fetchImpl = options.fetchImpl ?? ((url, init) => safeFetch(url, init));
  const employerUrl = options.employerUrl ?? configuredEmployerPage(job);
  const urls = usableUrls(job, employerUrl);
  const checks: VacancyCheck[] = [];
  let expiryAt: string | null = job.expiry_at?.trim() || null;
  let expirySource: "structured_data" | null = expiryAt ? "structured_data" : null;
  let closedFound = false;
  let openFound = false;
  let identitySeen = false;
  let applicationHtml = "";
  let applicationCheck = checks.find((check) => check.kind === "application") ?? null;

  for (const entry of urls) {
    const result = await checkPage({
      ...entry,
      job,
      fetchImpl,
      timeoutMs: options.timeoutMs ?? 20_000,
    });
    checks.push(result.check);
    if (entry.kind === "application") {
      applicationHtml = result.html;
      applicationCheck = result.check;
    }
    if (result.check.outcome === "closed") closedFound = true;
    if (result.check.outcome === "open" && result.check.identityMatched) openFound = true;
    if (result.check.identityMatched) identitySeen = true;
    if (!expiryAt && result.expiry) {
      expiryAt = result.expiry;
      expirySource = "structured_data";
    }
  }

  // Many employer pages present the form on a separate, explicitly linked URL.
  // Follow one such link only; no link is synthesised from a path pattern.
  let formCheck: VacancyCheck | null = null;
  if (applicationCheck?.httpStatus && applicationCheck.httpStatus >= 200 && applicationCheck.httpStatus < 400) {
    const linked = explicitApplyLink(applicationHtml, applicationCheck.finalUrl ?? applicationCheck.url);
    if (linked && linked !== applicationCheck.finalUrl && linked !== applicationCheck.url) {
      const form = await checkPage({
        kind: "application_form",
        url: linked,
        job,
        fetchImpl,
        timeoutMs: options.timeoutMs ?? 20_000,
      });
      checks.push(form.check);
      formCheck = form.check;
      if (form.html) applicationHtml = form.html;
      if (form.check.outcome === "closed") closedFound = true;
      if (form.check.identityMatched) identitySeen = true;
      if (!expiryAt && form.expiry) {
        expiryAt = form.expiry;
        expirySource = "structured_data";
      }
    }
  }

  if (employerUrl && !urls.some((entry) => entry.kind === "employer")) {
    checks.push({
      kind: "employer",
      url: employerUrl,
      finalUrl: null,
      httpStatus: null,
      outcome: "not_available",
      detail: "The employer career page URL was not a valid HTTP(S) address.",
      identityMatched: false,
    });
  }
  if (!employerUrl) {
    checks.push({
      kind: "employer",
      url: "",
      finalUrl: null,
      httpStatus: null,
      outcome: "not_available",
      detail: "No employer career-page URL was recorded for this vacancy; the application/listing page was checked instead.",
      identityMatched: false,
    });
  }

  const publishedAt = job.published_at?.trim() || null;
  const publishedTime = publishedAt ? Date.parse(publishedAt) : NaN;
  const publicationStatus: VacancyVerification["publicationStatus"] = !publishedAt
    ? "missing"
    : Number.isFinite(publishedTime)
      ? "present"
      : "unparseable";

  const expiryTime = expiryAt ? Date.parse(expiryAt) : NaN;
  const expiryPassed = Boolean(expiryAt && Number.isFinite(expiryTime) && expiryTime < now.getTime());

  let status: VacancyVerificationStatus;
  let reason: string;
  if (closedFound) {
    status = "closed";
    reason = "A checked page reports that the vacancy is closed, filled, removed or no longer accepting applications.";
  } else if (expiryPassed) {
    status = "closed";
    reason = `The recorded application expiry (${expiryAt}) has passed.`;
  } else if (!openFound || !identitySeen) {
    status = "unverified";
    reason = checks.length === 0
      ? "No usable application or listing URL was recorded, so the vacancy could not be verified."
      : "The listing did not return a page that could be matched to this employer and role. Submission is blocked until it can be verified.";
  } else if (publicationStatus !== "present") {
    status = "unverified";
    reason = "The application page is reachable, but the publication date is missing or invalid, so currentness cannot be verified.";
  } else {
    status = "open";
    reason = expiryAt
      ? `The listing is reachable and matched the role; the structured application expiry is ${expiryAt}.`
      : "The listing is reachable and matched the role. No application expiry was supplied, so the expiry is recorded as unknown.";
  }

  const applicationUrl = job.application_url?.trim() || null;
  const effectiveVendor = job.ats_vendor?.trim().toLowerCase() || null;
  const formEvidence = applicationHtml ? applicationFormEvidence(applicationHtml, effectiveVendor) : [];
  const urlResolved = Boolean(applicationUrl && !isAggregatorUrl(applicationUrl));
  const routeCheck = formCheck ?? applicationCheck;
  const urlReachable = Boolean(
    routeCheck?.httpStatus !== null &&
      routeCheck?.httpStatus !== undefined &&
      routeCheck.httpStatus >= 200 &&
      routeCheck.httpStatus < 400,
  );
  const employerIdentityVerified = checks.some(
    (check) => (check.kind === "application" || check.kind === "application_form" || check.kind === "employer") && check.identityMatched,
  );
  const vacancyOpenVerified = status === "open" && applicationCheck?.outcome === "open" && employerIdentityVerified;
  const embeddedIframe = formEvidence.some((item) => /embedded third-party iframe/i.test(item));
  const supportedFormEvidence = formEvidence.filter((item) => !/embedded third-party iframe/i.test(item));
  // A parent-page form may be a search/newsletter form. When the application is
  // embedded, do not claim support from unrelated parent HTML.
  const applicationFormSupported = urlReachable && supportedFormEvidence.length > 0 && !embeddedIframe;
  const routeStatuses: ApplicationRouteStatus[] = [];
  if (urlResolved) routeStatuses.push("URL_RESOLVED");
  if (urlResolved && urlReachable) routeStatuses.push("URL_REACHABLE");
  if (urlResolved && urlReachable && employerIdentityVerified) routeStatuses.push("EMPLOYER_IDENTITY_VERIFIED");
  if (vacancyOpenVerified) routeStatuses.push("VACANCY_OPEN_VERIFIED");
  if (vacancyOpenVerified && applicationFormSupported) routeStatuses.push("APPLICATION_FORM_SUPPORTED");
  const finalStatus = routeStatuses.at(-1) ?? "APPLICATION_ROUTE_UNRESOLVED";
  const finalUrl = routeCheck?.finalUrl ?? null;
  let finalHost: string | null = null;
  try {
    finalHost = finalUrl ? new URL(finalUrl).hostname.replace(/^www\./, "").toLowerCase() : null;
  } catch {
    finalHost = null;
  }
  const routeReason = !urlResolved
    ? "No non-aggregator employer/ATS application URL is recorded."
    : !urlReachable
      ? "The application route was resolved but did not return a reachable page."
      : !employerIdentityVerified
        ? "The application page was reachable but the employer and role could not be matched."
        : !vacancyOpenVerified
          ? "The employer and role were matched, but the vacancy is not verified open."
          : formEvidence.some((item) => /embedded third-party iframe/i.test(item))
            ? "The vacancy is open, but its application form is embedded in a third-party iframe the local executor does not enter."
            : !applicationFormSupported
              ? "The vacancy is open, but no supported application form was detected."
              : "The employer route, open vacancy and application form are verified.";

  return {
    status,
    checkedAt,
    publishedAt,
    publicationStatus,
    expiryAt,
    expiryStatus: expiryAt ? "known" : "unknown",
    expirySource,
    reason,
    checks,
    route: {
      statuses: routeStatuses.length > 0 ? routeStatuses : ["APPLICATION_ROUTE_UNRESOLVED"],
      finalStatus,
      urlResolved,
      urlReachable,
      employerIdentityVerified,
      vacancyOpenVerified,
      applicationFormSupported,
      finalUrl,
      finalHost,
      httpStatus: routeCheck?.httpStatus ?? null,
      formEvidence,
      reason: routeReason,
    },
  };
}

/** Persist only the verification fields; vacancy and application history stay intact. */
export function persistVacancyVerification(jobId: string, result: VacancyVerification): void {
  run(
    `UPDATE jobs SET vacancy_status = ?, vacancy_verified_at = ?, vacancy_verification = ?,
       expiry_at = ?, expiry_status = ? WHERE id = ?`,
    [
      result.status,
      result.checkedAt,
      JSON.stringify(result).slice(0, 24000),
      result.expiryAt,
      result.expiryStatus,
      jobId,
    ],
  );
}

export function vacancyVerificationForJob(jobId: string): VacancyVerification | null {
  const row = one<{ vacancy_verification: string | null }>(
    "SELECT vacancy_verification FROM jobs WHERE id = ?",
    [jobId],
  );
  if (!row?.vacancy_verification) return null;
  try {
    return JSON.parse(row.vacancy_verification) as VacancyVerification;
  } catch {
    return null;
  }
}

export async function verifyAndPersistVacancy(
  job: VacancyVerificationJob & { id: string },
  options: { now?: Date; employerUrl?: string | null; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<VacancyVerification> {
  const result = await verifyVacancy(job, options);
  persistVacancyVerification(job.id, result);
  return result;
}
