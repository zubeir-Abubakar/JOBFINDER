import crypto from "node:crypto";

/**
 * Canonical vacancy identity.
 *
 * This module is deliberately pure: it never touches the database or the
 * network. Discovery writers and the registry backfill share it, so a row
 * created by any adapter is identified by the same rules.
 *
 * Precedence (highest confidence first):
 *   1. employer requisition id
 *   2. canonical employer vacancy URL
 *   3. source + stable source identifier
 *   4. normalised employer + title + location hash
 *
 * A fuzzy match is never produced here: a low-confidence ANSI could merge two
 * genuine requisitions, so the caller must decide explicitly.
 */

export type VacancyLifecycleStatus = "new" | "verified_open" | "closed" | "verification_unknown";

export type QualificationStatus = "pending" | "qualified" | "needs_review" | "ineligible" | "below_threshold";

export type UrlConfidence = "direct" | "ats" | "aggregator" | "missing" | "unresolved";

const ATS_HOSTS: Array<{ vendor: string; pattern: RegExp }> = [
  { vendor: "greenhouse", pattern: /(^|\.)(greenhouse\.io|boards\.greenhouse\.io)$/i },
  { vendor: "lever", pattern: /(^|\.)(lever\.co|jobs\.lever\.co)$/i },
  { vendor: "ashby", pattern: /(^|\.)(ashbyhq\.com|jobs\.ashbyhq\.com)$/i },
  { vendor: "workday", pattern: /(^|\.)(myworkdayjobs\.com|workday\.com)$/i },
  { vendor: "smartrecruiters", pattern: /(^|\.)smartrecruiters\.com$/i },
  { vendor: "personio", pattern: /(^|\.)(jobs\.personio\.com|jobs\.personio\.de|personio\.de)$/i },
  { vendor: "recruitee", pattern: /(^|\.)recruitee\.com$/i },
  { vendor: "teamtailor", pattern: /(^|\.)teamtailor\.com$/i },
  { vendor: "bamboohr", pattern: /(^|\.)bamboohr\.com$/i },
  { vendor: "onlyfy", pattern: /(^|\.)onlyfy\.jobs$/i },
  { vendor: "prospective", pattern: /(^|\.)prospective\.ch$/i },
  { vendor: "join", pattern: /(^|\.)join\.com$/i },
];

const AGGREGATOR_HOST =
  /(^|\.)(jobs\.ch|jobup\.ch|jobscout24\.ch|indeed\.[a-z.]+|linkedin\.com|arbeitnow\.com|glassdoor\.[a-z.]+|stepstone\.[a-z.]+|xing\.com|monster\.[a-z.]+|stellenmarkt\.ch)$/i;

const TRACKING_PARAMS = /^(utm_|gh_src|lever-source|source|ref|referrer|trk|tracking|fbclid|gclid)/i;

const COMPANY_SUFFIX = /\b(?:ag|gmbh|sa|sarl|sàrl|inc|ltd|limited|corp|corporation|group|holding|schweiz|switzerland|suisse)\b/gi;

/** Lower-case employer identity without legal suffixes or punctuation. */
export function normaliseEmployerKey(company: string): string {
  return company
    .toLowerCase()
    .replace(COMPANY_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lower-case, tracking-free URL identity. Returns null for unusable values. */
export function canonicalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin.toLowerCase()}${path}${url.search}`;
  } catch {
    return null;
  }
}

export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isAggregatorUrl(value: string | null | undefined): boolean {
  const host = hostOf(value);
  return Boolean(host && AGGREGATOR_HOST.test(host));
}

export function atsVendorForUrl(value: string | null | undefined): string | null {
  const host = hostOf(value);
  if (!host) return null;
  for (const entry of ATS_HOSTS) {
    if (entry.pattern.test(host)) return entry.vendor;
  }
  return null;
}

/** Employer requisition id from the URL, when the ATS publishes one. */
export function requisitionFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    for (const key of ["gh_jid", "jobId", "job_id", "postingId", "posting_id", "requisitionId", "requisition_id", "id"]) {
      const found = url.searchParams.get(key);
      if (found && /^[A-Za-z0-9_-]{2,64}$/.test(found)) return found;
    }
    // Require an id-like segment: a generic word such as "detail" in
    // /vacancies/detail/<id> must never become a requisition id.
    const pathMatch = url.pathname.match(/\/(?:jobs|postings|positions|vacancies)\/([A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)(?:\/|$)/i);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

export type VacancyIdentityInput = {
  source: string | null | undefined;
  externalId: string | null | undefined;
  company: string;
  title: string;
  location: string | null | undefined;
  listingUrl: string | null | undefined;
  applicationUrl: string | null | undefined;
  requisitionId?: string | null;
};

export type VacancyIdentity = {
  employerKey: string;
  canonicalKey: string;
  duplicateGroup: string;
  requisitionId: string | null;
  atsVendor: string | null;
  urlConfidence: UrlConfidence;
  /** Employer-direct URL, only when the evidence supports it. */
  employerUrl: string | null;
  /** What may be stored as the application destination (never an aggregator). */
  applicationUrl: string | null;
};

function digest(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

export function vacancyIdentity(input: VacancyIdentityInput): VacancyIdentity {
  const employerKey = normaliseEmployerKey(input.company) || "unknown";
  const titleKey = input.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const locationKey = (input.location ?? "")
    .toLowerCase()
    .replace(/\b(switzerland|schweiz|suisse|swiss|remote|hybrid|on site|onsite)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const duplicateGroup = `grp:${digest(`${employerKey}|${titleKey}|${locationKey}`)}`;

  const candidate = canonicalUrl(input.applicationUrl) ?? null;
  const atsVendor = atsVendorForUrl(input.applicationUrl) ?? atsVendorForUrl(input.listingUrl);
  let urlConfidence: UrlConfidence;
  if (!candidate) {
    urlConfidence = "missing";
  } else if (isAggregatorUrl(candidate)) {
    urlConfidence = "aggregator";
  } else if (atsVendor) {
    urlConfidence = "ats";
  } else {
    urlConfidence = "direct";
  }
  const employerUrl = urlConfidence === "direct" || urlConfidence === "ats" ? candidate : null;
  const requisitionId = (input.requisitionId ?? "").trim() || requisitionFromUrl(candidate);

  let canonicalKey: string;
  if (requisitionId) {
    canonicalKey = `req:${employerKey}:${requisitionId.toLowerCase()}`;
  } else if (employerUrl) {
    canonicalKey = `url:${employerUrl}`;
  } else if (input.source && input.externalId) {
    canonicalKey = `src:${input.source.toLowerCase()}:${input.externalId.toLowerCase()}`;
  } else {
    canonicalKey = `id:${digest(`${employerKey}|${titleKey}|${locationKey}`)}`;
  }

  return {
    employerKey,
    canonicalKey,
    duplicateGroup,
    requisitionId,
    atsVendor,
    urlConfidence,
    employerUrl,
    // An aggregator detail page is not an employer application endpoint. It is
    // never copied into the application URL field; the original source URL stays
    // in `url` and the vacancy is explicitly unresolved.
    applicationUrl: employerUrl,
  };
}

/**
 * Qualification status is internal. It is never an employer decision: an
 * employer rejection requires separate employer evidence on the application.
 */
export function qualificationStatusFor(input: {
  eligible: string | null | undefined;
  score: number | null | undefined;
  threshold: number;
  qualified: boolean;
  hardBlocker?: boolean;
}): QualificationStatus {
  if (input.qualified) return "qualified";
  if (input.eligible === "ineligible") return "ineligible";
  if (input.eligible === "needs_review") return "needs_review";
  if (input.hardBlocker) return "ineligible";
  if (typeof input.score === "number" && input.score < input.threshold) return "below_threshold";
  return "pending";
}

/** Maps a legacy row to a lifecycle value without inventing an employer action. */
export function lifecycleForLegacyStatus(status: string, verifiedAt: string | null | undefined): VacancyLifecycleStatus {
  if (verifiedAt) return "verified_open";
  if (status === "applied" || status === "shortlisted" || status === "documents") return "verified_open";
  return "verification_unknown";
}
