import { all, nowIso, one, run, v } from "./db";
import { randomId } from "./security";
import { htmlToText } from "./scoring";

export type JobRow = {
  id: string;
  source: string;
  external_id: string | null;
  title: string;
  company: string;
  location: string | null;
  remote: number;
  employment_type: string | null;
  salary: string | null;
  url: string | null;
  description: string | null;
  language_text: string | null;
  posted_at: string | null;
  discovered_at: string;
  status: string;
  match_score: number | null;
  match_flag: string | null;
  analysis: string | null;
  ai_note: string | null;
  duplicate_of: string | null;
  raw: string | null;
};

const QA_TITLE = /\b(qa|quality assurance|test(ing)? engineer|test automation|sdet|software test|test lead|test manager|automation engineer)\b/i;
const SWISS = /(switzerland|schweiz|suisse|svizzera|zurich|zürich|geneva|genève|geneve|lausanne|bern|basel|zug|luzern|lucerne|winterthur|st\.? gallen|lugano|fribourg|vaud|ticino|neuch)/i;

type ArbeitnowJob = {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags?: string[];
  job_types?: string[];
  location: string;
  created_at: number;
};

export type ResearchResult = {
  fetched: number;
  inserted: number;
  duplicates: number;
  filteredOut: number;
  pages: number;
  jobs: Array<{ id: string; title: string; company: string; location: string | null; remote: boolean }>;
  rejectionReasons: Record<string, number>;
  rejectedSamples: Array<{ title: string; company: string; reason: string }>;
  sourceNote: string;
  error?: string;
};

const PLACEHOLDER_COMPANY = /^(company\s+[a-z]|company\s+\d+|employer\s+[a-z]|example(\s+(company|employer|inc|ltd))?|sample(\s+company)?|test\s+company|acme(\s+corp(oration)?)?|placeholder)$/i;
const PLACEHOLDER_TEXT = /\b(lorem ipsum|dummy (job|vacancy)|sample vacancy|example vacancy|placeholder vacancy)\b/i;

/** Every record must be traceable to a real employer posting before it is stored. */
export function vacancyValidationError(input: {
  title: string;
  company: string;
  location: string | null;
  url: string | null;
  description: string | null;
}): string | null {
  if (input.title.trim().length < 3) return "Missing a real job title";
  if (input.company.trim().length < 2) return "Missing a real employer name";
  if (PLACEHOLDER_COMPANY.test(input.company.trim())) return "Placeholder employer rejected";
  if (!input.location?.trim()) return "Missing a traceable location";
  if (!input.url) return "Missing the original source URL";
  try {
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol)) return "Source URL is not HTTP(S)";
  } catch {
    return "Invalid source URL";
  }
  if (!input.description || input.description.trim().length < 40) return "Missing the original vacancy description";
  if (PLACEHOLDER_TEXT.test(input.description)) return "Placeholder text rejected";
  return null;
}

/**
 * Fetches the keyless Arbeitnow job board API and keeps only QA/testing roles that
 * are Swiss or remote. Deduplicates on the source slug and on title+company.
 */
export async function researchJobs(pages = 2, maxInserts = 40): Promise<ResearchResult> {
  const result: ResearchResult = {
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    filteredOut: 0,
    pages: 0,
    jobs: [],
    rejectionReasons: {},
    rejectedSamples: [],
    sourceNote: "Source: Arbeitnow public job board API — link back to Arbeitnow.com required.",
  };

  const reject = (title: string, company: string, reason: string) => {
    result.filteredOut += 1;
    result.rejectionReasons[reason] = (result.rejectionReasons[reason] ?? 0) + 1;
    if (result.rejectedSamples.length < 5) result.rejectedSamples.push({ title, company, reason });
  };

  const source = one<{ enabled: number; url: string; last_run_at: string | null }>(
    "SELECT enabled, url, last_run_at FROM job_sources WHERE key = 'arbeitnow'",
  );
  if (!source || !source.enabled) {
    result.error = "The Arbeitnow source is disabled. Enable it under Job discovery → Sources.";
    return result;
  }
  const baseUrl = source.url || "https://www.arbeitnow.com/api/job-board-api";

  for (let page = 1; page <= pages; page += 1) {
    let payload: { data?: ArbeitnowJob[] };
    try {
      const response = await fetch(`${baseUrl}?page=${page}`, {
        headers: { Accept: "application/json", "User-Agent": "AT-AI-Workforce/1.0 (personal job search)" },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Job source responded ${response.status}`);
      payload = (await response.json()) as { data?: ArbeitnowJob[] };
    } catch (error) {
      result.error = error instanceof Error ? error.message : "Job source could not be reached.";
      break;
    }
    const batch = payload.data ?? [];
    result.pages += 1;
    result.fetched += batch.length;

    for (const item of batch) {
      if (result.inserted >= maxInserts) break;
      const location = item.location ?? "";
      const remote = Boolean(item.remote);
      const isSwiss = SWISS.test(location) || SWISS.test(item.title) || SWISS.test(item.description?.slice(0, 1500) ?? "");
      const titleOk = QA_TITLE.test(item.title);
      if (!titleOk) {
        reject(item.title, item.company_name, "Not a QA/testing title");
        continue;
      }
      if (!isSwiss && !remote) {
        reject(item.title, item.company_name, "Outside Switzerland and not remote");
        continue;
      }
      const invalid = vacancyValidationError({
        title: item.title ?? "",
        company: item.company_name ?? "",
        location,
        url: item.url,
        description: htmlToText(item.description ?? ""),
      });
      if (invalid) {
        reject(item.title, item.company_name, invalid);
        continue;
      }

      const existing = one<{ id: string }>("SELECT id FROM jobs WHERE source = 'arbeitnow' AND external_id = ?", [item.slug]);
      if (existing) {
        result.duplicates += 1;
        continue;
      }
      const nearDuplicate = one<{ id: string }>(
        "SELECT id FROM jobs WHERE lower(trim(title)) = lower(trim(?)) AND lower(trim(company)) = lower(trim(?))",
        [item.title, item.company_name],
      );
      if (nearDuplicate) {
        result.duplicates += 1;
        continue;
      }

      const id = `job_${randomId()}`;
      const plain = htmlToText(item.description ?? "");
      run(
        `INSERT INTO jobs (id, source, external_id, title, company, location, remote, employment_type, salary, url, description, posted_at, discovered_at, status, raw)
         VALUES (?, 'arbeitnow', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'new', ?)`,
        [
          id,
          item.slug,
          item.title.trim(),
          item.company_name.trim(),
          location || "Not specified",
          v(remote),
          (item.job_types ?? []).join(", ") || null,
          item.url,
          plain.slice(0, 24000),
          item.created_at ? new Date(item.created_at * 1000).toISOString() : null,
          nowIso(),
          JSON.stringify(item).slice(0, 20000),
        ],
      );
      result.inserted += 1;
      result.jobs.push({ id, title: item.title, company: item.company_name, location: location || null, remote });
    }
  }

  run("UPDATE job_sources SET last_run_at = ? WHERE key = 'arbeitnow'", [nowIso()]);
  return result;
}

export function listJobs(options: {
  limit?: number;
  status?: string;
  minScore?: number;
  search?: string;
  location?: string;
  flag?: string;
  remote?: string;
  company?: string;
  source?: string;
  sort?: string;
  analysed?: string;
} = {}): JobRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.status && options.status !== "all") {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.minScore && options.minScore > 0) {
    clauses.push("match_score >= ?");
    params.push(options.minScore);
  }
  if (options.flag && options.flag !== "all") {
    clauses.push("match_flag = ?");
    params.push(options.flag);
  }
  if (options.search) {
    clauses.push("(title LIKE ? OR company LIKE ? OR description LIKE ?)");
    const needle = `%${options.search}%`;
    params.push(needle, needle, needle);
  }
  if (options.location) {
    clauses.push("location LIKE ?");
    params.push(`%${options.location}%`);
  }
  if (options.company) {
    clauses.push("company LIKE ?");
    params.push(`%${options.company}%`);
  }
  if (options.source && options.source !== "all") {
    clauses.push("source = ?");
    params.push(options.source);
  }
  if (options.remote === "remote") clauses.push("remote = 1");
  if (options.remote === "onsite") clauses.push("remote = 0");
  if (options.analysed === "1") clauses.push("match_score IS NOT NULL");
  if (options.analysed === "0") clauses.push("match_score IS NULL");

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const order =
    options.sort === "oldest"
      ? "discovered_at ASC"
      : options.sort === "score"
        ? "match_score DESC NULLS LAST, discovered_at DESC"
        : options.sort === "title"
          ? "title ASC"
          : "discovered_at DESC";
  return all<JobRow>(`SELECT * FROM jobs ${where} ORDER BY ${order} LIMIT ?`, [...params, options.limit ?? 200]);
}

export function jobById(id: string): JobRow | null {
  return one<JobRow>("SELECT * FROM jobs WHERE id = ?", [id]);
}

export function jobCounts() {
  return {
    total: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c ?? 0,
    analysed: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_score IS NOT NULL")?.c ?? 0,
    suitable: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_flag IN ('strong','possible')")?.c ?? 0,
    strong: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_flag = 'strong'")?.c ?? 0,
    newToday:
      one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE date(discovered_at) = date('now')")?.c ?? 0,
  };
}

export function jobPipeline() {
  return {
    new: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE status = 'new'")?.c ?? 0,
    analysing: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE status = 'analysing'")?.c ?? 0,
    shortlisted: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE status = 'shortlisted'")?.c ?? 0,
    documents: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE status = 'documents'")?.c ?? 0,
    awaiting: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'awaiting_approval'")?.c ?? 0,
    submitted: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status IN ('submitted','acknowledged')")?.c ?? 0,
    interview: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status IN ('interview_invited','interview_completed','offer_received')")?.c ?? 0,
    rejected: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'rejected'")?.c ?? 0,
  };
}
