import { canonicalUrl, isAggregatorUrl } from "./job-identity";

/**
 * Resolve an employer's own email application channel.
 *
 * Some vacancies have no web form at all: the employer publishes a contact
 * address ("send your CV to …"). A job-board quick-apply page is not the
 * employer, but the email address on the employer's own vacancy page is a real
 * application destination. It is recorded as a human handoff: this deployment
 * never sends email applications automatically.
 *
 * The crawl is deliberately bounded: listing -> employer site -> careers page
 * -> up to three matching vacancy pages. No search engine, no guessing of
 * domains, no URLs invented from a company name.
 */

const USER_AGENT = "AT-AI-Workforce/1.0 (candidate application destination resolution)";
const SOCIAL_OR_BOARD =
  /(^|\.)(linkedin|facebook|xing|twitter|x|instagram|youtube|tiktok|glassdoor|indeed|jobscout24|jobup|jobs\.ch|jobcloud|google|apple|apps\.apple)\./i;

function companyTokens(company: string): string[] {
  return company
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !["the", "and", "for", "ag", "sa", "gmbh", "ltd"].includes(token));
}

export type EmailEvidence = {
  email: string;
  method: "joomla_hidden_mail" | "mailto" | "plain";
  pageUrl: string;
};

export type EmailDestinationResolution = {
  ok: boolean;
  email: string | null;
  employerSite: string | null;
  employerVacancyUrl: string | null;
  employerHost: string | null;
  reason: string;
  evidence: Record<string, unknown>;
};

function hostOf(raw: string | null | undefined): string | null {
  try {
    return new URL(raw ?? "").hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function sameEmployerHost(candidate: string, employerHost: string): boolean {
  const host = hostOf(candidate);
  if (!host) return false;
  return host === employerHost || host.endsWith(`.${employerHost}`);
}

function extractLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) && links.length < 400) {
    const url = canonicalUrl(new URL(match[1].replace(/&amp;/g, "&"), baseUrl).toString());
    if (!url) continue;
    const text = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    links.push({ url, text });
  }
  return links;
}

function decodeBase64(value: string): string {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Joomla hides contact addresses in `<joomla-hidden-mail>`; the first/last
 * attributes are the base64 local part and domain. Plain mailto and plain-text
 * addresses are accepted too. Every candidate must belong to the employer host.
 */
export function extractVerifiedEmployerEmail(
  html: string,
  employerHost: string,
  pageUrl: string,
): EmailEvidence | null {
  const found: Array<{ email: string; method: EmailEvidence["method"] }> = [];
  const hidden = /<joomla-hidden-mail\b[^>]*\bfirst="([^"]+)"[^>]*\blast="([^"]+)"[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hidden.exec(html))) {
    const email = `${decodeBase64(match[1]).trim()}@${decodeBase64(match[2]).trim()}`;
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) found.push({ email, method: "joomla_hidden_mail" });
  }
  const mailto = /href\s*=\s*["']mailto:([^"'?]+)/gi;
  while ((match = mailto.exec(html))) found.push({ email: match[1].trim(), method: "mailto" });
  const plain = /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi;
  while ((match = plain.exec(html)) && found.length < 20) found.push({ email: match[1], method: "plain" });

  for (const candidate of found) {
    const email = candidate.email.replace(/^mailto:/i, "").trim();
    const domain = email.split("@")[1]?.toLowerCase().replace(/^www\./, "") ?? "";
    if (!domain) continue;
    if (domain !== employerHost && !domain.endsWith(`.${employerHost}`)) continue;
    if (SOCIAL_OR_BOARD.test(domain)) continue;
    return { email, method: candidate.method, pageUrl };
  }
  return null;
}

async function fetchText(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; html: string; finalUrl: string }> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    });
    const html = response.ok ? (await response.text().catch(() => "")).slice(0, 2_000_000) : "";
    return { ok: response.ok, status: response.status, html, finalUrl: response.url || url };
  } catch {
    return { ok: false, status: 0, html: "", finalUrl: url };
  }
}

function significantTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9äöü]+/i)
    .filter((token) => token.length >= 3 && !["the", "and", "for", "with", "job", "role"].includes(token))
    .slice(0, 5);
}

function looksLikeVacancyLink(link: { url: string; text: string }, title: string): boolean {
  const haystack = `${link.url} ${link.text}`.toLowerCase();
  const tokens = significantTokens(title);
  if (tokens.length === 0) return false;
  return tokens.every((token) => haystack.includes(token));
}

/**
 * Bounded resolution from a listing page to a verified employer email.
 * Returns `ok:false` with a reason at every dead end; never invents an address.
 */
export async function resolveEmployerEmailDestination(input: {
  listingUrl: string;
  title: string;
  company: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<EmailDestinationResolution> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = Math.min(20_000, Math.max(3_000, input.timeoutMs ?? 10_000));
  const evidence: Record<string, unknown> = { listingUrl: input.listingUrl, pagesChecked: [] as string[] };
  const pagesChecked = evidence.pagesChecked as string[];
  const listing = await fetchText(input.listingUrl, fetchImpl, timeoutMs);
  pagesChecked.push(input.listingUrl);
  if (!listing.ok) {
    return {
      ok: false,
      email: null,
      employerSite: null,
      employerVacancyUrl: null,
      employerHost: null,
      reason: `The listing page could not be read (HTTP ${listing.status || "network error"}).`,
      evidence,
    };
  }
  const listingHost = hostOf(input.listingUrl) ?? "";
  const links = extractLinks(listing.html, listing.finalUrl);
  // Next.js/JSON payloads escape URLs (https:\/\/…), so the company's website
  // link is often not an <a href> in the server HTML. Collect those too.
  const rawUrls = [...listing.html.matchAll(/https?:\\?\/\\?\/[^\s"'<>\\]+/g)]
    .map((match) => canonicalUrl(match[0].replace(/\\\//g, "/")))
    .filter((url): url is string => Boolean(url))
    .map((url) => ({ url, text: "" }));
  const allLinks = [...links, ...rawUrls];
  const tokens = companyTokens(input.company);
  // Board navigation often links to the operator's own blog or affiliate page.
  // Prefer a link whose host or anchor text matches the hiring company, and
  // never accept a social/board/operator host as the employer website.
  const external = allLinks
    .filter((link) => {
      const host = hostOf(link.url);
      return Boolean(host) && host !== listingHost && !isAggregatorUrl(link.url) && !SOCIAL_OR_BOARD.test(host!);
    })
    .map((link) => {
      const host = hostOf(link.url) ?? "";
      const haystack = `${host} ${link.text}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { ...link, score };
    })
    .sort((left, right) => right.score - left.score);
  const employerSite = external[0]?.url ?? null;
  evidence.employerSiteCandidates = external.slice(0, 5).map((link) => ({ url: link.url, score: link.score }));
  if (!employerSite) {
    return {
      ok: false,
      email: null,
      employerSite: null,
      employerVacancyUrl: null,
      employerHost: null,
      reason: "The listing does not publish an employer website link.",
      evidence,
    };
  }
  const employerHost = hostOf(employerSite);
  if (!employerHost) {
    return { ok: false, email: null, employerSite, employerVacancyUrl: null, employerHost: null, reason: "The employer website has no usable host.", evidence };
  }
  evidence.employerSite = employerSite;
  evidence.employerHost = employerHost;

  const home = await fetchText(employerSite, fetchImpl, timeoutMs);
  pagesChecked.push(employerSite);
  if (!home.ok) {
    return { ok: false, email: null, employerSite, employerVacancyUrl: null, employerHost, reason: `The employer website could not be read (HTTP ${home.status || "network error"}).`, evidence };
  }

  const homeLinks = extractLinks(home.html, home.finalUrl);
  const vacancyCandidates: string[] = [];
  for (const link of homeLinks) {
    if (!sameEmployerHost(link.url, employerHost)) continue;
    if (looksLikeVacancyLink(link, input.title)) vacancyCandidates.push(link.url);
  }
  const careersLinks = homeLinks
    .filter((link) => sameEmployerHost(link.url, employerHost) && /career|jobs|vacanc|stellen|offene/i.test(`${link.url} ${link.text}`))
    .map((link) => link.url)
    .slice(0, 3);

  for (const careersUrl of careersLinks) {
    const careers = await fetchText(careersUrl, fetchImpl, timeoutMs);
    pagesChecked.push(careersUrl);
    if (!careers.ok) continue;
    for (const link of extractLinks(careers.html, careers.finalUrl)) {
      if (!sameEmployerHost(link.url, employerHost)) continue;
      if (looksLikeVacancyLink(link, input.title)) vacancyCandidates.push(link.url);
    }
  }

  const uniqueCandidates = [...new Set(vacancyCandidates)].filter((url) => !pagesChecked.includes(url)).slice(0, 3);
  evidence.vacancyCandidates = uniqueCandidates;

  const pagesToInspect = uniqueCandidates.length > 0 ? uniqueCandidates : careersLinks.slice(0, 2);
  for (const pageUrl of pagesToInspect) {
    const page = await fetchText(pageUrl, fetchImpl, timeoutMs);
    pagesChecked.push(pageUrl);
    if (!page.ok) continue;
    const email = extractVerifiedEmployerEmail(page.html, employerHost, page.finalUrl);
    if (email) {
      evidence.emailMethod = email.method;
      evidence.emailDomain = email.email.split("@")[1] ?? null;
      return {
        ok: true,
        email: email.email,
        employerSite,
        employerVacancyUrl: uniqueCandidates.includes(pageUrl) ? page.finalUrl : null,
        employerHost,
        reason: `The employer's own page publishes ${email.email} as the application contact (${email.method}).`,
        evidence,
      };
    }
  }

  // Last resort: the employer home page itself.
  const homeEmail = extractVerifiedEmployerEmail(home.html, employerHost, home.finalUrl);
  if (homeEmail) {
    evidence.emailMethod = homeEmail.method;
    return {
      ok: true,
      email: homeEmail.email,
      employerSite,
      employerVacancyUrl: null,
      employerHost,
      reason: `The employer's site publishes ${homeEmail.email} as the application contact (${homeEmail.method}).`,
      evidence,
    };
  }

  return {
    ok: false,
    email: null,
    employerSite,
    employerVacancyUrl: null,
    employerHost,
    reason: "No employer-owned email address was published on the pages checked.",
    evidence,
  };
}
