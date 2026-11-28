import { all, nowIso, one, run } from "./db";
import {
  classifyDestination,
  employerUrlProvenance,
  resolveJobsChEmployerUrl,
  type EmployerUrlProvenance,
  type LinkResolution,
} from "./employer-links";
import { isAggregatorUrl } from "./job-identity";

export type EmailDestinationInput = {
  email: string;
  employerVacancyUrl: string | null;
  employerSite: string | null;
  reason: string;
  evidence: Record<string, unknown>;
  verifiedAt?: string;
};

/**
 * Persist a verified employer email application destination. No web form is
 * invented: `application_url` stays NULL, `url_confidence` becomes `email`, and
 * the queue treats the vacancy as a human email handoff.
 */
/** Clears a previously stored email destination when fresh evidence rejects it. */
export function clearEmployerEmailDestination(jobId: string, reason: string): void {
  const job = one<{
    application_email: string | null;
    url_confidence: string | null;
    application_url: string | null;
    ats_vendor: string | null;
  }>("SELECT application_email, url_confidence, application_url, ats_vendor FROM jobs WHERE id = ?", [jobId]);
  if (!job?.application_email) return;
  // A verified web destination survives the email cleanup; only a vacancy with
  // no web form returns to `unresolved`.
  const restored = job.application_url ? (job.ats_vendor ? "ats" : "direct") : "unresolved";
  run(
    `UPDATE jobs SET application_email = NULL, application_email_source = NULL, application_email_verified_at = NULL,
       url_confidence = ?, url_provenance = ? WHERE id = ?`,
    [restored, JSON.stringify({ version: 1, resolver: "employer_email", method: "unresolved", reason, resolvedAt: nowIso() }), jobId],
  );
}

export function persistEmployerEmailDestination(
  jobId: string,
  input: EmailDestinationInput,
): { stored: boolean } {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return { stored: false };
  const verifiedAt = input.verifiedAt ?? nowIso();
  const provenance = {
    version: 1,
    resolver: "employer_email",
    method: "verified_employer_page",
    employerUrl: input.employerVacancyUrl ?? input.employerSite,
    applicationEmail: email,
    confidence: "email",
    reason: input.reason,
    evidence: input.evidence,
    resolvedAt: verifiedAt,
  };
  run(
    `UPDATE jobs SET application_email = ?, application_email_source = 'verified_employer_page',
       application_email_verified_at = ?, employer_url = COALESCE(?, employer_url),
       url_confidence = CASE
         WHEN application_url IS NOT NULL AND url_confidence IN ('direct','ats') THEN url_confidence
         ELSE 'email'
       END,
       url_provenance = ?, last_verified_at = ?
     WHERE id = ?`,
    [
      email,
      verifiedAt,
      input.employerVacancyUrl ?? input.employerSite,
      JSON.stringify(provenance).slice(0, 12000),
      verifiedAt,
      jobId,
    ],
  );
  return { stored: true };
}

/**
 * Persist the evidence behind a jobs.ch employer-link resolution.
 *
 * A resolved employer/ATS URL replaces the aggregator placeholder. An
 * unresolved result records why it failed but never overwrites an already
 * verified employer URL.
 */
export function persistEmployerUrlProvenance(
  jobId: string,
  provenance: EmployerUrlProvenance,
): { stored: boolean; resolved: boolean } {
  const job = one<{
    employer_key: string | null;
    application_url: string | null;
    url_confidence: string | null;
  }>("SELECT employer_key, application_url, url_confidence FROM jobs WHERE id = ?", [jobId]);
  if (!job) return { stored: false, resolved: false };

  const employerUrl = provenance.employerUrl;
  const resolved =
    Boolean(employerUrl) &&
    (provenance.confidence === "direct" || provenance.confidence === "ats") &&
    !isAggregatorUrl(employerUrl);
  const serialised = JSON.stringify(provenance).slice(0, 12000);

  if (resolved && employerUrl) {
    const canonicalKey = provenance.requisitionId
      ? `req:${job.employer_key ?? "unknown"}:${provenance.requisitionId.toLowerCase()}`
      : `url:${employerUrl}`;
    run(
      `UPDATE jobs SET application_url = ?, employer_url = ?, ats_vendor = ?, requisition_id = ?,
         url_confidence = ?, canonical_key = ?, url_provenance = ?, first_verified_at = COALESCE(first_verified_at, ?),
         last_verified_at = ?
       WHERE id = ?`,
      [
        employerUrl,
        employerUrl,
        provenance.atsVendor,
        provenance.requisitionId,
        provenance.confidence,
        canonicalKey,
        serialised,
        provenance.resolvedAt,
        provenance.resolvedAt,
        jobId,
      ],
    );
    return { stored: true, resolved: true };
  }

  const existingIsEmployer =
    Boolean(job.application_url) &&
    !isAggregatorUrl(job.application_url) &&
    (job.url_confidence === "direct" || job.url_confidence === "ats");
  if (existingIsEmployer) {
    // Keep the previously verified destination; record the failed refresh
    // separately so it cannot silently degrade a good link.
    run("UPDATE jobs SET url_provenance = ? WHERE id = ?", [serialised, jobId]);
    return { stored: true, resolved: false };
  }

  run(
    `UPDATE jobs SET application_url = NULL, employer_url = NULL, ats_vendor = NULL, requisition_id = NULL,
       url_confidence = 'unresolved', url_provenance = ?
     WHERE id = ?`,
    [serialised, jobId],
  );
  return { stored: true, resolved: false };
}

export type StoredJobsChResolutionSummary = {
  checked: number;
  resolved: number;
  unresolved: number;
  errors: Array<{ id: string; url: string; error: string }>;
};

/**
 * Resolve existing jobs.ch rows that still carry an aggregator or unresolved
 * application URL. This is an explicit backfill; normal discovery resolves new
 * listings as they arrive.
 */
export async function resolveStoredJobsChUrls(options: {
  limit?: number;
  delayMs?: number;
  resolve?: (url: string) => Promise<LinkResolution>;
} = {}): Promise<StoredJobsChResolutionSummary> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const resolver = options.resolve ?? ((url: string) => resolveJobsChEmployerUrl(url));
  const rows = all<{ id: string; url: string | null; application_url: string | null; url_confidence: string | null }>(
    `SELECT id, url, application_url, url_confidence FROM jobs
     WHERE source = 'jobs_ch'
       AND url LIKE '%jobs.ch%'
       AND (
         application_url IS NULL
         OR application_url LIKE '%jobs.ch%'
         OR url_confidence IS NULL
         OR url_confidence IN ('aggregator','unresolved','missing')
       )
     ORDER BY discovered_at DESC
     LIMIT ?`,
    [limit],
  );
  const summary: StoredJobsChResolutionSummary = { checked: 0, resolved: 0, unresolved: 0, errors: [] };
  for (const row of rows) {
    if (!row.url) continue;
    summary.checked += 1;
    try {
      const resolution = await resolver(row.url);
      const result = persistEmployerUrlProvenance(row.id, employerUrlProvenance(resolution));
      if (result.resolved) summary.resolved += 1;
      else summary.unresolved += 1;
    } catch (error) {
      summary.errors.push({
        id: row.id,
        url: row.url,
        error: error instanceof Error ? error.message : "resolution failed",
      });
    }
    if (options.delayMs && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }
  return summary;
}

/**
 * Recompute the direct/ATS classification of already resolved jobs.ch URLs. This
 * is pure: it never contacts an employer. It exists because adding a supported
 * ATS host should not require re-fetching every stored listing.
 */
export function reclassifyStoredEmployerUrls(): { checked: number; updated: number } {
  const rows = all<{
    id: string;
    application_url: string;
    url_confidence: string | null;
    ats_vendor: string | null;
    url_provenance: string | null;
  }>(
    `SELECT id, application_url, url_confidence, ats_vendor, url_provenance
     FROM jobs WHERE source = 'jobs_ch' AND application_url IS NOT NULL`,
  );
  let updated = 0;
  for (const row of rows) {
    if (isAggregatorUrl(row.application_url)) continue;
    const classified = classifyDestination(row.application_url);
    if (classified.confidence !== "direct" && classified.confidence !== "ats") continue;
    let provenance: Record<string, unknown> | null = null;
    try {
      provenance = row.url_provenance ? (JSON.parse(row.url_provenance) as Record<string, unknown>) : null;
    } catch {
      provenance = null;
    }
    const nextProvenance = provenance
      ? JSON.stringify({
          ...provenance,
          applicationUrl: row.application_url,
          employerUrl: row.application_url,
          confidence: classified.confidence,
          atsVendor: classified.atsVendor,
          reason: classified.reason,
        }).slice(0, 12000)
      : null;
    if (
      row.url_confidence === classified.confidence &&
      row.ats_vendor === classified.atsVendor &&
      (!nextProvenance || nextProvenance === row.url_provenance)
    ) {
      continue;
    }
    run("UPDATE jobs SET url_confidence = ?, ats_vendor = ?, url_provenance = COALESCE(?, url_provenance) WHERE id = ?", [
      classified.confidence,
      classified.atsVendor,
      nextProvenance,
      row.id,
    ]);
    updated += 1;
  }
  return { checked: rows.length, updated };
}

/** Mark a failed refresh without erasing the original resolution evidence. */
export function recordResolutionRefreshError(jobId: string, reason: string): void {
  run("UPDATE jobs SET url_provenance = ? WHERE id = ?", [
    JSON.stringify({ version: 1, resolver: "jobs_ch", resolvedAt: nowIso(), error: reason }).slice(0, 12000),
    jobId,
  ]);
}
