import { nowIso, one, run } from "./db";
import { getSetting, setSetting } from "./settings";
import { effectiveMinMatchScore } from "./scoring";
import { zonedParts, zonedTimeToUtc } from "./recruitment-schedule";
import { audit } from "./audit";

/**
 * Standing authorisation for autonomous recruitment.
 *
 * The owner authorises the operating policy once in settings. From then on an
 * application that passes every check is submitted without another approval.
 * Approval mode is no longer a per-application gate; it is retained as a legacy
 * read-only value so older rows remain understandable. The effective limit is
 * always read from persisted settings, so an existing owner's cap is never
 * silently raised or lowered.
 */

export const DEFAULT_MAX_SUBMISSIONS_PER_DAY = 5;
export const MAX_SUBMISSIONS_PER_DAY_LIMIT = 10;
export const FRESHNESS_DAYS = 7;
export const RECRUITMENT_POLICY_ENGINE = "standing-authorisation-v1";

export type RecruitmentPolicy = {
  autonomousSubmission: boolean;
  minMatchScore: number;
  maxSubmissionsPerDay: number;
  freshnessDays: number;
  verifiedOpenOnly: boolean;
  blockDuplicates: boolean;
  requirePerApplicationApproval: boolean;
  activatedAt: string | null;
  active: boolean;
  engine: string;
};

export type AuthorisedAnswers = Record<string, string>;

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

export function getRecruitmentPolicy(): RecruitmentPolicy {
  const activatedAtRaw = getSetting<string | null>("standing_authorisation_activated_at", null);
  const activatedAt = typeof activatedAtRaw === "string" && activatedAtRaw.trim() ? activatedAtRaw : null;
  const autonomousSubmission = getSetting<boolean>("autonomous_submission", true) === true;
  return {
    autonomousSubmission,
    minMatchScore: effectiveMinMatchScore(getSetting<number>("min_match_score", 85)),
    maxSubmissionsPerDay: positiveInt(
      getSetting<number>("max_applications_per_day", DEFAULT_MAX_SUBMISSIONS_PER_DAY),
      DEFAULT_MAX_SUBMISSIONS_PER_DAY,
      MAX_SUBMISSIONS_PER_DAY_LIMIT,
    ),
    freshnessDays: FRESHNESS_DAYS,
    verifiedOpenOnly: true,
    blockDuplicates: true,
    // Per-application approval is deliberately retired. Only the owner-level
    // automatic-submission switch and the eligibility checks can stop a send.
    requirePerApplicationApproval: false,
    activatedAt,
    active: autonomousSubmission,
    engine: RECRUITMENT_POLICY_ENGINE,
  };
}

/** The explicit owner activation, not merely the default policy values. */
export function standingAuthorisationActive(): boolean {
  return getRecruitmentPolicy().active;
}

export function activateStandingAuthorisation(userId?: string): string {
  const at = nowIso();
  setSetting("standing_authorisation_activated_at", at);
  setSetting("autonomous_submission", true);
  setSetting("approval_mode", false);
  audit({
    action: "recruitment.standing_authorisation_activated",
    entity: "settings",
    detail: "The owner activated automatic submission for straightforward qualifying applications.",
    userId: userId ?? null,
  });
  return at;
}

export function pauseStandingAuthorisation(userId?: string): void {
  setSetting("autonomous_submission", false);
  setSetting("approval_mode", false);
  audit({
    action: "recruitment.standing_authorisation_paused",
    entity: "settings",
    detail: "Automatic submission was paused; no application will be sent until it is resumed.",
    userId: userId ?? null,
  });
}

/** Re-enables automatic submission without restoring a per-application gate. */
export function resumeStandingAuthorisation(userId?: string): string {
  const at = nowIso();
  if (!getSetting<string | null>("standing_authorisation_activated_at", null)) {
    setSetting("standing_authorisation_activated_at", at);
  }
  setSetting("autonomous_submission", true);
  setSetting("approval_mode", false);
  audit({
    action: "recruitment.standing_authorisation_resumed",
    entity: "settings",
    detail: "Automatic submission resumed. Eligible applications will be submitted without per-application approval.",
    userId: userId ?? null,
  });
  return at;
}

/** Owner-editable policy. The threshold floor and the hard daily cap are enforced here. */
export function saveRecruitmentPolicy(input: {
  autonomousSubmission: boolean;
  minMatchScore: unknown;
  maxSubmissionsPerDay: unknown;
  userId?: string;
}): RecruitmentPolicy {
  const minScore = Math.min(100, effectiveMinMatchScore(input.minMatchScore));
  const maxPerDay = positiveInt(input.maxSubmissionsPerDay, DEFAULT_MAX_SUBMISSIONS_PER_DAY, MAX_SUBMISSIONS_PER_DAY_LIMIT);
  setSetting("autonomous_submission", input.autonomousSubmission);
  // Per-application approval is retired. Pausing automatic submission is the
  // owner-level control; it never silently re-enables a per-application gate.
  setSetting("approval_mode", false);
  setSetting("min_match_score", minScore);
  setSetting("max_applications_per_day", maxPerDay);
  setSetting("duplicate_detection", true);
  audit({
    action: "recruitment.policy_updated",
    entity: "settings",
    detail: `Automatic submission ${input.autonomousSubmission ? "on" : "off"}; threshold ${minScore}%; cap ${maxPerDay}/day; freshness ${FRESHNESS_DAYS} days.`,
    userId: input.userId ?? null,
  });
  return getRecruitmentPolicy();
}

export function authorisedAnswers(): AuthorisedAnswers {
  const raw = getSetting<Record<string, unknown>>("authorised_answers", {});
  if (!raw || typeof raw !== "object") return {};
  const out: AuthorisedAnswers = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim()) out[key.trim().toLowerCase()] = value.trim();
  }
  return out;
}

/** Start of the Europe/Zurich calendar day containing `now`, as a UTC instant. */
export function startOfRecruitmentDay(now: Date = new Date()): Date {
  const parts = zonedParts(now);
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0);
}

export type DailySubmissionUsage = {
  dayStart: string;
  verified: number;
  remaining: number;
  limit: number;
};

/**
 * Verified submissions in the current Zurich day, excluding the current job.
 * A blocked, simulated or unverified attempt does not consume the quota; only
 * employer-verified delivery does.
 */
export function dailySubmissionUsage(now: Date = new Date(), excludeJobId?: string): DailySubmissionUsage {
  const policy = getRecruitmentPolicy();
  const start = startOfRecruitmentDay(now).toISOString();
  const row = one<{ c: number }>(
    `SELECT COUNT(DISTINCT job_id) AS c FROM submission_attempts
     WHERE status = 'verified' AND attempted_at >= ? AND job_id != ?`,
    [start, excludeJobId ?? ""],
  );
  const verified = Number(row?.c ?? 0);
  return {
    dayStart: start,
    verified,
    remaining: Math.max(0, policy.maxSubmissionsPerDay - verified),
    limit: policy.maxSubmissionsPerDay,
  };
}

export function recordPolicySimulation(input: {
  applicationId: string;
  jobId: string;
  reason: string;
  at?: string;
}): void {
  run(
    "UPDATE applications SET submission_status = 'simulated', last_update = ? WHERE id = ?",
    [input.at ?? nowIso(), input.applicationId],
  );
  audit({
    action: "recruitment.submission_simulated",
    entity: "application",
    entityId: input.applicationId,
    detail: `${input.reason} (job ${input.jobId})`,
  });
}
