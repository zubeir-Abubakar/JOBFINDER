/**
 * Controlled end-to-end verification run.
 *
 * Forces dry-run and disables submission in this process only (no persisted
 * setting is changed), so packages can traverse the real gates while no
 * employer request is made. Discovery executes once for this manual run; the
 * scheduled 12:00 occurrence is not touched or replayed.
 */
export {};

process.env.RECRUITMENT_DRY_RUN = "true";
process.env.RECRUITMENT_SUBMISSION_ENABLED = "false";
process.env.RECRUITMENT_SCHEDULER = "false";

const { createRecruitmentRun, executeRun } = await import("../lib/recruitment-run.ts");
const { all, closeDb } = await import("../lib/db.ts");

const created = createRecruitmentRun({ trigger: "manual", now: new Date() });
const outcome = await executeRun(created.run.id, { pageBudget: 2, now: new Date() });

const states = all<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM recruitment_queue GROUP BY state");
console.log(
  JSON.stringify(
    {
      runId: created.run.id,
      status: outcome.status,
      discovered: outcome.discovered,
      qualified: outcome.qualified,
      prepared: outcome.prepared,
      submitted: outcome.submitted,
      simulated: outcome.simulated,
      intervention: outcome.intervention,
      warnings: outcome.warnings,
      failures: outcome.failures,
      queue: states,
    },
    null,
    2,
  ),
);
closeDb();
