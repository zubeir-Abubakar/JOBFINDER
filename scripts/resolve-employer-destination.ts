/**
 * Resolve an employer destination for a listing that has no web form.
 *
 *   npx tsx scripts/resolve-employer-destination.ts <jobId>
 *
 * Reads the listing, the employer's own site and its careers/vacancy page(s),
 * accepts only an employer-domain email address, persists the verified result,
 * and re-syncs the queue. It never writes an application, loads a candidate
 * form or submits anything.
 */
export {};

process.env.RECRUITMENT_SCHEDULER = "false";

const { closeDb, one } = await import("../lib/db.ts");
const { resolveEmployerEmailDestination } = await import("../lib/employer-contact.ts");
const { clearEmployerEmailDestination, persistEmployerEmailDestination } = await import("../lib/jobs-ch-resolution.ts");
const { syncQualifiedQueue } = await import("../lib/recruitment-queue.ts");

const jobId = process.argv[2] ?? "job_20686837e535dbaa"; // Telecom26 Test Engineer
const force = process.argv.includes("--force");
const job = one<{
  id: string;
  title: string;
  company: string;
  url: string | null;
  eligibility: string | null;
  qualified: number;
}>("SELECT id, title, company, url, eligibility, qualified FROM jobs WHERE id = ?", [jobId]);
if (!job?.url) throw new Error(`No listing URL for ${jobId}`);
if (!force && (job.eligibility !== "eligible" || Number(job.qualified) !== 1)) {
  // Resolution does network work and stores an address. It is only meaningful
  // for a vacancy that can actually enter the pipeline; an ineligible one is
  // retried automatically only after it becomes eligible again.
  console.log(
    JSON.stringify(
      {
        job: { id: job.id, title: job.title, company: job.company },
        skipped: true,
        reason: `Not eligible/qualified (eligibility=${job.eligibility ?? "null"}, qualified=${job.qualified}); use --force to inspect anyway.`,
      },
      null,
      2,
    ),
  );
  closeDb();
  process.exit(0);
}

const resolution = await resolveEmployerEmailDestination({
  listingUrl: job.url,
  title: job.title,
  company: job.company,
});

let stored = false;
if (!resolution.ok) {
  // A previous email destination is not kept when fresh evidence cannot
  // reproduce it; the vacancy returns to the unresolved queue.
  clearEmployerEmailDestination(jobId, resolution.reason);
}
if (resolution.ok && resolution.email) {
  stored = persistEmployerEmailDestination(jobId, {
    email: resolution.email,
    employerVacancyUrl: resolution.employerVacancyUrl,
    employerSite: resolution.employerSite,
    reason: resolution.reason,
    evidence: resolution.evidence,
  }).stored;
  syncQualifiedQueue({ actor: "employer-email-resolution" });
}

const queue = one<{ state: string; reason: string | null }>(
  "SELECT state, reason FROM recruitment_queue WHERE job_id = ?",
  [jobId],
);
const row = one<{ application_email: string | null; url_confidence: string | null; application_url: string | null }>(
  "SELECT application_email, url_confidence, application_url FROM jobs WHERE id = ?",
  [jobId],
);

console.log(
  JSON.stringify(
    {
      job: { id: job.id, title: job.title, company: job.company, listingUrl: job.url },
      resolution,
      stored,
      jobDestination: row,
      queue,
    },
    null,
    2,
  ),
);
closeDb();
