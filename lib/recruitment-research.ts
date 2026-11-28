import { researchForAgent, type ReachRunner, type ReachSource } from "./agent-reach";
import { isAggregatorUrl } from "./job-identity";

/**
 * Bridge between Agent Reach and recruitment research.
 *
 * This module is deliberately read-only. It can retrieve evidence for a vacancy
 * that the existing connectors already discovered, but it has no path to
 * insert a job, change a score, mark eligibility, cross the 85% threshold or
 * reach the submission transport. Research evidence is an input to the existing
 * verification gate, never a substitute for it.
 */

export type VacancyResearchEvidence = {
  ok: boolean;
  /** The listing the evidence came from. */
  sourceUrl: string;
  /** The employer page when one was independently known; never an aggregator. */
  employerUrl: string | null;
  channel: string | null;
  backend: string | null;
  retrievedAt: string;
  title: string | null;
  text: string;
  truncated: boolean;
  closedSignal: string | null;
  identityMentioned: boolean;
  injectionSignals: string[];
  reason: string | null;
};

const CLOSED_PATTERNS: RegExp[] = [
  /\bapplications?\s+(?:are\s+)?(?:now\s+)?closed\b/i,
  /\bno longer accepting applications\b/i,
  /\b(?:position|role|vacancy)\s+(?:has been\s+)?filled\b/i,
  /\b(?:job|vacancy|posting)\s+(?:has\s+)?expired\b/i,
  /\b(?:job|vacancy|posting)\s+(?:has been\s+)?(?:removed|withdrawn)\b/i,
];

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Retrieve public evidence about one already-discovered vacancy.
 *
 * `sourceUrl` is the URL the vacancy was actually found at. `employerUrl` is a
 * separately established employer/ATS address. An aggregator is never promoted
 * to `employerUrl`; when only an aggregator is known the evidence says so and
 * the caller must keep treating the employer route as unresolved.
 */
export async function researchVacancyEvidence(
  input: { sourceUrl: string; employerUrl?: string | null; title: string; company: string },
  options: { runner?: ReachRunner; now?: Date; timeoutMs?: number } = {},
): Promise<VacancyResearchEvidence> {
  const retrievedAt = (options.now ?? new Date()).toISOString();
  const sourceUrl = httpUrl(input.sourceUrl);
  const candidateEmployer = input.employerUrl ? httpUrl(input.employerUrl) : null;
  const employerUrl =
    candidateEmployer && !isAggregatorUrl(candidateEmployer) && candidateEmployer !== sourceUrl
      ? candidateEmployer
      : null;
  const readUrl = employerUrl ?? sourceUrl;

  if (!readUrl) {
    return {
      ok: false,
      sourceUrl: input.sourceUrl,
      employerUrl,
      channel: null,
      backend: null,
      retrievedAt,
      title: null,
      text: "",
      truncated: false,
      closedSignal: null,
      identityMentioned: false,
      injectionSignals: [],
      reason: "No public http(s) vacancy URL is recorded, so no research evidence could be retrieved.",
    };
  }

  const result = await researchForAgent("research", { channel: "web_read", url: readUrl }, {
    runner: options.runner,
    now: options.now,
    timeoutMs: options.timeoutMs,
  });

  if (!result.ok) {
    return {
      ok: false,
      sourceUrl: input.sourceUrl,
      employerUrl,
      channel: result.channel,
      backend: null,
      retrievedAt,
      title: null,
      text: "",
      truncated: false,
      closedSignal: null,
      identityMentioned: false,
      injectionSignals: [],
      reason: result.error?.message ?? "The research request failed.",
    };
  }

  const source: ReachSource | undefined = result.sources[0];
  const text = source?.content ?? "";
  const haystack = normalise(text);
  const closedSignal = CLOSED_PATTERNS.map((pattern) => text.match(pattern)?.[0]).find(Boolean) ?? null;
  const title = normalise(input.title);
  const titleTokens = title.split(" ").filter((token) => token.length > 2);
  const titleHit = title.length >= 5 && haystack.includes(title);
  const titleRatio = titleTokens.length > 0 ? titleTokens.filter((token) => haystack.includes(token)).length / titleTokens.length : 0;
  const companyTokens = normalise(input.company)
    .replace(/\b(?:ag|gmbh|sa|sarl|inc|ltd|limited|corp|corporation|group|schweiz|switzerland)\b/g, " ")
    .split(" ")
    .filter((token) => token.length >= 3);

  return {
    ok: Boolean(source),
    sourceUrl: input.sourceUrl,
    employerUrl,
    channel: source?.channel ?? result.channel,
    backend: source?.backend ?? null,
    retrievedAt: source?.retrievedAt ?? retrievedAt,
    title: source?.title ?? null,
    text,
    truncated: source?.truncated ?? false,
    closedSignal,
    identityMentioned: titleHit || titleRatio >= 0.6 || (companyTokens.length > 0 && companyTokens.every((token) => haystack.includes(token))),
    injectionSignals: source?.injectionSignals ?? [],
    reason: source ? null : "The page returned no readable content; the vacancy remains unverified.",
  };
}
