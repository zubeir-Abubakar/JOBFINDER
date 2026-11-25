import {
  atsVendorForUrl,
  canonicalUrl,
  hostOf,
  isAggregatorUrl,
  requisitionFromUrl,
  type UrlConfidence,
} from "./job-identity";

/**
 * Employer URL resolution.
 *
 * A listing URL is not necessarily an application destination. This module
 * follows a bounded number of redirects from the listing/aggregator page to the
 * employer or ATS page, can inspect the listing HTML for an explicit employer
 * application link, validates the final host, and records how confident the
 * result is. It never invents a destination: an unresolved link stays
 * unresolved, and callers must not auto-submit on `aggregator`/`unresolved`.
 *
 * Network access is injected so the resolution rules are testable without
 * contacting an employer.
 */

export type ResolutionMethod = "direct" | "redirect" | "embedded_link" | "unresolved";

export type LinkResolution = {
  requestedUrl: string;
  finalUrl: string | null;
  employerUrl: string | null;
  atsVendor: string | null;
  requisitionId: string | null;
  confidence: UrlConfidence;
  reason: string;
  hops: number;
  httpStatus: number | null;
  method: ResolutionMethod;
};

export type EmployerUrlProvenance = {
  version: 1;
  resolver: "jobs_ch";
  method: ResolutionMethod;
  requestedUrl: string;
  finalUrl: string | null;
  employerUrl: string | null;
  applicationUrl: string | null;
  confidence: UrlConfidence;
  atsVendor: string | null;
  requisitionId: string | null;
  reason: string;
  hops: number;
  httpStatus: number | null;
  resolvedAt: string;
};

export type ResolveOptions = {
  fetchImpl?: typeof fetch;
  maxHops?: number;
  timeoutMs?: number;
  /** Read the listing HTML for an explicit employer application link. */
  inspectLinks?: boolean;
};

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const APPLY_HINT = /\b(apply|application|bewerb\w*|postul\w*|candidat\w*|solicitud|jetzt bewerben|zur bewerbung)\b/i;

const NON_EMPLOYER_HOST =
  /(^|\.)(facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|pinterest\.com|google\.[a-z.]+|apple\.com|microsoft\.com|amazon\.[a-z.]+)$/i;

/**
 * jobs.ch renders "Easy apply" with JavaScript. Its public detail page carries a
 * stable vacancy id, and the equivalent application-redirect route is the same
 * destination the button uses. That route can still end on a jobs.ch-hosted
 * quick-apply form, which is not an employer-controlled application endpoint.
 */
function jobsChApplicationRedirect(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "jobs.ch") return null;
    const match = parsed.pathname.match(/^\/(?:en|de|fr)\/(?:vacancies|stellenangebote|offres-emplois)\/detail\/([0-9a-f-]{20,})\/?$/i);
    return match ? `https://www.jobs.ch/en/vacancies/application-redirect/${match[1]}/` : null;
  } catch {
    return null;
  }
}

function isJobsChQuickApply(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "").toLowerCase() === "jobs.ch" && /^\/(?:en|de|fr)\/application\/create\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function decodeJsString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
  }
}

/**
 * jobs.ch exposes the employer destination in its React Query hydration state,
 * even when the server response is a 200 application page rather than a 302.
 * Only `applicationOptions.externalUrl` is accepted; the vacancy's own
 * `externalUrl` is empty for jobs.ch-hosted quick apply.
 */
export function extractApplicationOptionsUrl(html: string): string | null {
  const match = html.match(/"applicationOptions"\s*:\s*\{[\s\S]{0,3000}?"externalUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  if (!match) return null;
  const decoded = decodeJsString(match[1]).trim();
  return /^https?:\/\//i.test(decoded) ? decoded : null;
}

function jobsChQuickApplyHtml(html: string): boolean {
  return /"isApplicationMethodOnline"\s*:\s*true/i.test(html) && /"applicationOptions"\s*:/i.test(html);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .trim();
}

function attribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function textOf(html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

/**
 * Extract plausible employer application links from a listing page. The result
 * is ordered by explicit apply wording, never by a guessed employer name.
 * Links are still passed through the normal redirect/host classification.
 */
export function extractApplicationLinks(html: string, baseUrl: string): string[] {
  const base = canonicalUrl(baseUrl);
  if (!base) return [];
  const baseHost = hostOf(base);
  const found: Array<{ url: string; score: number }> = [];
  const seen = new Set<string>();
  const add = (rawHref: string | null, label: string, attributes: string) => {
    if (!rawHref) return;
    let parsed: URL;
    try {
      parsed = new URL(rawHref, base);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    const canonical = canonicalUrl(parsed.toString());
    if (!canonical || canonical === base || seen.has(canonical)) return;
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (NON_EMPLOYER_HOST.test(host)) return;
    const path = parsed.pathname.toLowerCase();
    // A same-site ordinary vacancy link is navigation, not an application
    // destination. Apply/Bewerben paths remain candidates and are followed.
    if (isAggregatorUrl(canonical) && host === baseHost && !APPLY_HINT.test(path)) return;
    const haystack = `${label} ${attributes} ${path}`;
    if (!APPLY_HINT.test(haystack) && !/\b(job|vacanc|stelle|offre)\b/i.test(path)) return;
    let score = 0;
    if (APPLY_HINT.test(label)) score += 8;
    if (APPLY_HINT.test(attributes)) score += 4;
    if (APPLY_HINT.test(path)) score += 6;
    if (host !== baseHost) score += 2;
    seen.add(canonical);
    found.push({ url: canonical, score });
  };

  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    add(attribute(match[1], "href"), textOf(match[2]), match[1]);
  }
  const controlPattern = /<(?:form|button)\b([^>]*)>/gi;
  for (const match of html.matchAll(controlPattern)) {
    add(attribute(match[1], "action"), "", match[1]);
    add(attribute(match[1], "formaction"), "", match[1]);
  }
  const applicationOptionsUrl = extractApplicationOptionsUrl(html);
  if (applicationOptionsUrl) add(applicationOptionsUrl, "apply", "application");
  // Some listing pages expose the application destination only as JSON-LD.
  // Only externally hosted URLs are considered; the posting's own URL is not
  // an application endpoint.
  const jsonUrlPattern = /"url"\s*:\s*"((?:https?:\\?\/\\?\/)[^"]+)"/gi;
  for (const match of html.matchAll(jsonUrlPattern)) {
    const raw = match[1].replace(/\\\//g, "/");
    let host = "";
    try {
      host = new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    if (host !== baseHost && !isAggregatorUrl(raw)) add(raw, "apply", "application");
  }
  return found
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((entry) => entry.url);
}

export function classifyDestination(url: string | null | undefined): { confidence: UrlConfidence; atsVendor: string | null; reason: string } {
  if (!url) return { confidence: "missing", atsVendor: null, reason: "No application URL was published." };
  if (isAggregatorUrl(url)) {
    return { confidence: "aggregator", atsVendor: null, reason: "The URL is a job-board listing, not an employer application endpoint." };
  }
  const vendor = atsVendorForUrl(url);
  if (vendor) return { confidence: "ats", atsVendor: vendor, reason: `Hosted on the supported ${vendor} ATS.` };
  return { confidence: "direct", atsVendor: null, reason: "The URL host is the employer's own domain." };
}

/**
 * Resolve a candidate application URL without leaving the permitted web.
 * Only http(s) is followed; at most `maxHops` redirects/links; the final URL is
 * validated and classified. A CAPTCHA, 401/403 or a network error is
 * `unresolved`, never treated as a verified destination.
 */
export async function resolveEmployerUrl(startUrl: string | null | undefined, options: ResolveOptions = {}): Promise<LinkResolution> {
  const fetcher = options.fetchImpl ?? fetch;
  const maxHops = Math.min(6, Math.max(1, options.maxHops ?? 4));
  const base: LinkResolution = {
    requestedUrl: startUrl ?? "",
    finalUrl: null,
    employerUrl: null,
    atsVendor: null,
    requisitionId: null,
    confidence: "missing",
    reason: "No application URL was published.",
    hops: 0,
    httpStatus: null,
    method: "unresolved",
  };
  if (!startUrl) return base;
  const initial = canonicalUrl(startUrl);
  if (!initial) return { ...base, confidence: "unresolved", reason: "The URL is not a valid http(s) address." };

  let current = initial;
  let method: ResolutionMethod = "direct";
  const seen = new Set<string>([initial]);
  for (let hop = 0; hop <= maxHops; hop += 1) {
    if (isJobsChQuickApply(current)) {
      return {
        ...base,
        finalUrl: current,
        confidence: "unresolved",
        reason: "jobs.ch hosts this quick-apply form itself; no employer-controlled application URL is published.",
        hops: hop,
        method: "unresolved",
      };
    }
    if (isAggregatorUrl(current)) {
      if (method === "direct") method = "unresolved";
      // Still on the aggregator: request the page and look for a redirect or an
      // explicit employer application link. The aggregator itself is never
      // treated as the employer destination.
      let response: Response;
      try {
        response = await fetcher(current, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
          headers: { "user-agent": "AT-AI-Workforce/1.0 (candidate application link resolution)" },
        });
      } catch (error) {
        return {
          ...base,
          finalUrl: current,
          confidence: "unresolved",
          reason: `The listing page could not be read: ${error instanceof Error ? error.message : "network error"}`,
          hops: hop,
          method: "unresolved",
        };
      }
      const location = response.headers.get("location");
      if (REDIRECT_STATUS.has(response.status) && location) {
        const next = canonicalUrl(new URL(location, current).toString());
        if (!next) return { ...base, finalUrl: current, confidence: "unresolved", reason: "A redirect pointed at an unusable URL.", hops: hop, method: "unresolved" };
        if (!seen.has(next)) {
          seen.add(next);
          current = next;
          method = "redirect";
          continue;
        }
      }
      if (options.inspectLinks && response.status >= 200 && response.status < 300) {
        const html = (await response.text().catch(() => "")).slice(0, 2_000_000);
        if (jobsChQuickApplyHtml(html)) {
          return {
            ...base,
            finalUrl: current,
            confidence: "unresolved",
            reason: "jobs.ch hosts this quick-apply form itself; no employer-controlled application URL is published.",
            hops: hop,
            httpStatus: response.status,
            method: "unresolved",
          };
        }
        const next = extractApplicationLinks(html, current).find((link) => !seen.has(link));
        if (next) {
          seen.add(next);
          current = next;
          method = "embedded_link";
          continue;
        }
      }
      // No static link: use the public application-redirect route that the
      // JavaScript "Easy apply" control navigates to. It will resolve to the
      // employer/ATS for external vacancies, or remain unresolved for jobs.ch's
      // own quick-apply form.
      const applicationRedirect = jobsChApplicationRedirect(current);
      if (applicationRedirect && !seen.has(applicationRedirect)) {
        seen.add(applicationRedirect);
        current = applicationRedirect;
        method = "redirect";
        continue;
      }
      return {
        ...base,
        finalUrl: current,
        confidence: "unresolved",
        reason: options.inspectLinks
          ? "The listing page did not redirect and no employer application link was found."
          : "The listing page did not redirect to an employer application endpoint.",
        hops: hop,
        httpStatus: response.status,
        method: "unresolved",
      };
    }
    const classified = classifyDestination(current);
    return {
      ...base,
      finalUrl: current,
      employerUrl: current,
      atsVendor: classified.atsVendor,
      requisitionId: requisitionFromUrl(current),
      confidence: classified.confidence,
      reason: classified.reason,
      hops: hop,
      httpStatus: null,
      method,
    };
  }
  return {
    ...base,
    finalUrl: current,
    confidence: "unresolved",
    reason: `No employer destination was reached within ${maxHops} redirect(s); last host ${hostOf(current) ?? "unknown"}.`,
    hops: maxHops,
    method: "unresolved",
  };
}

/** Resolve a jobs.ch detail page, including its explicit employer apply link. */
export function resolveJobsChEmployerUrl(
  startUrl: string | null | undefined,
  options: ResolveOptions = {},
): Promise<LinkResolution> {
  return resolveEmployerUrl(startUrl, { ...options, inspectLinks: true });
}

/** Persistable evidence for how an employer application URL was obtained. */
export function employerUrlProvenance(
  resolution: LinkResolution,
  resolvedAt = new Date().toISOString(),
): EmployerUrlProvenance {
  return {
    version: 1,
    resolver: "jobs_ch",
    method: resolution.method,
    requestedUrl: resolution.requestedUrl,
    finalUrl: resolution.finalUrl,
    employerUrl: resolution.employerUrl,
    applicationUrl: resolution.employerUrl,
    confidence: resolution.confidence,
    atsVendor: resolution.atsVendor,
    requisitionId: resolution.requisitionId,
    reason: resolution.reason,
    hops: resolution.hops,
    httpStatus: resolution.httpStatus,
    resolvedAt,
  };
}

/** Only a direct employer or supported ATS destination may auto-submit. */
export function canAutoSubmitResolved(resolution: Pick<LinkResolution, "confidence" | "employerUrl">): boolean {
  return (resolution.confidence === "direct" || resolution.confidence === "ats") && Boolean(resolution.employerUrl);
}
