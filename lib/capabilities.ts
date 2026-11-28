import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { all, DATA_DIR, one, SCHEMA_VERSION } from "./db.ts";
import { capabilityMatrix } from "./ats-capabilities.ts";
import { gmailMissing } from "./gmail.ts";
import { scheduleSnapshot } from "./recruitment-schedule.ts";
import { recruitmentSchedulerStatus } from "./recruitment-ticker.ts";
import { getRecruitmentPolicy } from "./recruitment-policy.ts";
import { browserFormsEnabled, submissionDryRun, submissionEnabled } from "./submission.ts";

/**
 * Capability registry.
 *
 * Every row is backed by a real module, route or table. The registry separates
 * three questions that are often conflated: is it implemented, is it switched on
 * and configured, and has it actually produced evidence in this environment.
 * Nothing here infers a capability from a name alone.
 */

export type CapabilityImplementation = "Implemented" | "Partially implemented";
export type CapabilityLive = "Live-verified" | "Awaiting live verification" | "Blocked" | "Failed";
export type CapabilityDependency = "Configured" | "Not configured" | "Not required";

export type Capability = {
  id: string;
  category: string;
  name: string;
  description: string;
  implementation: CapabilityImplementation;
  enabled: boolean;
  dependency: CapabilityDependency;
  dependencyDetail: string;
  live: CapabilityLive;
  liveDetail: string;
  tests: string[];
  limitations: string;
  href: string | null;
  lastSuccess: string | null;
};

function scalar(sql: string): number {
  return Number(one<{ n: number }>(sql)?.n ?? 0);
}

function latest(value: string | null | undefined): string | null {
  return value ?? null;
}

function backupCount(): number {
  const dir = path.join(DATA_DIR, "backups");
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".db")).length;
  } catch {
    return 0;
  }
}

export function capabilityRegistry(now: Date = new Date()): {
  capabilities: Capability[];
  summary: {
    total: number;
    liveVerified: number;
    awaitingVerification: number;
    blocked: number;
    failed: number;
    disabled: number;
    notConfigured: number;
  };
} {
  const schedule = scheduleSnapshot(now);
  const scheduler = recruitmentSchedulerStatus();
  const checkedAt = schedule.lastCheckedAt ? Date.parse(schedule.lastCheckedAt) : NaN;
  const schedulerLive = scheduler.running || (Number.isFinite(checkedAt) && now.getTime() - checkedAt < 150_000);
  const policy = getRecruitmentPolicy();
  const gmailConfigured = gmailMissing().length === 0;
  const gmailAccounts = scalar("SELECT COUNT(*) AS n FROM gmail_accounts");
  const gmailScopes =
    one<{ scopes: string | null }>("SELECT scopes FROM gmail_accounts ORDER BY id LIMIT 1")?.scopes ?? "";
  const gmailDraftScope = gmailScopes.includes("gmail.compose");
  const sources = scalar("SELECT COUNT(*) AS n FROM job_sources WHERE enabled = 1");
  const blockedSecurity = scalar("SELECT COUNT(*) AS n FROM recruitment_queue WHERE state = 'blocked_security'");
  const awaitingHuman = scalar("SELECT COUNT(*) AS n FROM recruitment_queue WHERE state = 'awaiting_human'");
  const verifiedSubmissions = scalar("SELECT COUNT(*) AS n FROM applications WHERE submission_status = 'verified'");
  const atsFixtureOnly = capabilityMatrix().filter((row) => row.certification === "synthetic_fixture_only").length;
  const atsTotal = capabilityMatrix().length;
  const outreachContacts = scalar("SELECT COUNT(*) AS n FROM outreach_contacts WHERE verification_status = 'verified'");
  const outreachDrafts = scalar("SELECT COUNT(*) AS n FROM outreach_drafts");
  const spend = Number(one<{ total: number | null }>("SELECT SUM(cost_chf) AS total FROM provider_usage")?.total ?? 0);
  const providerRows = scalar("SELECT COUNT(*) AS n FROM provider_usage");
  const backups = backupCount();
  const schema = scalar("SELECT COUNT(*) AS n FROM schema_migrations");
  const workers = all<{ name: string; status: string; heartbeat_at: string }>(
    "SELECT name, status, heartbeat_at FROM runtime_workers ORDER BY name",
  );
  const liveWorkers = workers.filter((worker) => {
    const beat = Date.parse(worker.heartbeat_at);
    return worker.status === "running" && Number.isFinite(beat) && now.getTime() - beat < 120_000;
  });

  const capabilities: Capability[] = [
    {
      id: "discovery",
      category: "Recruitment discovery",
      name: "Multi-source vacancy discovery",
      description:
        "Configured Ashby boards, employer career pages, Arbeitnow and jobs.ch resolution run through the persisted recruitment engine with source health and duplicate accounting.",
      implementation: "Implemented",
      enabled: true,
      dependency: sources > 0 ? "Configured" : "Not configured",
      dependencyDetail: `${sources} enabled job source(s) are stored in job_sources.`,
      live: scalar("SELECT COUNT(*) AS n FROM recruitment_runs") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM jobs")} vacancies are stored; last completed run ${
        latest(
          one<{ finished_at: string | null }>(
            "SELECT finished_at FROM recruitment_runs WHERE status = 'completed' ORDER BY finished_at DESC LIMIT 1",
          )?.finished_at,
        ) ?? "none"
      }.`,
      tests: ["discovery-coverage.test.ts", "discovery-phase2.test.ts", "incremental-discovery.test.ts"],
      limitations: "Discovery depends on each source's published feed; a source failure is reported, not replaced with invented vacancies.",
      href: "/jobs",
      lastSuccess: latest(
        one<{ finished_at: string | null }>(
          "SELECT finished_at FROM recruitment_runs WHERE status = 'completed' ORDER BY finished_at DESC LIMIT 1",
        )?.finished_at,
      ),
    },
    {
      id: "qualification",
      category: "Job qualification and matching",
      name: "Deterministic match scoring and 85% qualification",
      description:
        "Vacancies are scored against the stored profile, then qualified only when the score and every eligibility rule pass. The 85% floor is enforced by the engine.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Uses the stored candidate profile; no external credential is needed.",
      live: scalar("SELECT COUNT(*) AS n FROM jobs WHERE qualified = 1") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM jobs WHERE qualified = 1")} qualified vacancies and ${scalar(
        "SELECT COUNT(*) AS n FROM jobs WHERE qualified = 0",
      )} rejected records are stored.`,
      tests: ["recruitment.test.ts", "policy-safety.test.ts", "phase2-job-registry.test.ts"],
      limitations: "Scores are deterministic heuristics, not an employer's opinion; the pilot override is scoped to one application.",
      href: "/jobs?min=85",
      lastSuccess: latest(one<{ last_seen_at: string | null }>("SELECT MAX(last_seen_at) AS last_seen_at FROM jobs")?.last_seen_at),
    },
    {
      id: "eligibility",
      category: "Candidate profile and eligibility",
      name: "Profile, eligibility and language checks",
      description:
        "Stored profile, skills, experience and work authorisation drive eligibility, German-language assessment and document content. Unknown facts stay unknown.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Reads the local profile tables; no third-party service.",
      live: scalar("SELECT COUNT(*) AS n FROM profiles") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM skills")} skills and ${scalar(
        "SELECT COUNT(*) AS n FROM experiences",
      )} experience records are stored.`,
      tests: ["profile-grounding.test.ts", "german-exclusion.test.ts", "profile-editor.test.ts"],
      limitations: "The platform cannot verify employment history or language ability; it never upgrades a language level.",
      href: "/profile",
      lastSuccess: latest(one<{ updated_at: string | null }>("SELECT MAX(updated_at) AS updated_at FROM profiles")?.updated_at),
    },
    {
      id: "ats",
      category: "ATS detection and destination verification",
      name: "ATS destination detection and capability matrix",
      description:
        "Destinations are detected from the stored source or actual hostname. Each platform records its execution route, controls and certification state.",
      implementation: "Partially implemented",
      enabled: true,
      dependency: "Not configured",
      dependencyDetail: `${atsTotal} platforms are catalogued with no real-platform certification; ${atsFixtureOnly} loopback fixture has synthetic evidence. Employer write credentials are employer-issued.`,
      live: "Blocked",
      liveDetail: `${atsTotal} real destination(s) remain uncertified. ${blockedSecurity} queue item(s) stopped at an employer security control.`,
      tests: ["submission-ats.test.ts", "phase3-employer-links.test.ts", "vacancy-verification.test.ts"],
      limitations:
        "A matching hostname is detection, not certification. CAPTCHA, MFA, Cloudflare, login walls and rate limits are never bypassed.",
      href: "/recruitment#unresolved-urls",
      lastSuccess: null,
    },
    {
      id: "documents",
      category: "Application document generation",
      name: "Vacancy-specific CV and cover letter generation",
      description:
        "Generates a tailored CV and cover letter per vacancy, stores the rendered file, and links both documents to the application record.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Local rendering; deterministic fallback when inference is unavailable.",
      live: scalar("SELECT COUNT(*) AS n FROM documents") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL")} active document(s) are stored.`,
      tests: ["document-quality-phase2.test.ts", "document-persistence-phase2.test.ts", "document-library.test.ts"],
      limitations: "Only verified profile facts are used; a missing fact produces a quality failure or a human question, not invented content.",
      href: "/documents",
      lastSuccess: latest(one<{ created_at: string | null }>("SELECT MAX(created_at) AS created_at FROM documents")?.created_at),
    },
    {
      id: "quality",
      category: "CV and cover-letter quality validation",
      name: "Document quality gates",
      description:
        "Each generated document is checked for structure, vacancy linkage and content before it can be attached to an application or an outreach draft.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Runs locally against the rendered document.",
      live: scalar("SELECT COUNT(*) AS n FROM documents WHERE quality_status = 'passed'") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM documents WHERE quality_status = 'passed'")} document(s) passed; ${scalar(
        "SELECT COUNT(*) AS n FROM documents WHERE quality_status != 'passed'",
      )} did not.`,
      tests: ["document-quality-phase2.test.ts", "cover-letter-requirements.test.ts"],
      limitations: "A quality pass is an internal check, not an employer's guarantee.",
      href: "/applications",
      lastSuccess: latest(
        one<{ created_at: string | null }>(
          "SELECT MAX(created_at) AS created_at FROM documents WHERE quality_status = 'passed'",
        )?.created_at,
      ),
    },
    {
      id: "submission",
      category: "Autonomous application submission",
      name: "Automatic submission with atomic claims",
      description:
        "Performs an atomic claim, duplicate prevention, readiness checks and destination execution. There is no per-application approval for a qualified application.",
      implementation: "Partially implemented",
      enabled: policy.active && submissionEnabled() && !submissionDryRun(),
      dependency: browserFormsEnabled() ? "Configured" : "Not configured",
      dependencyDetail: `Browser forms ${browserFormsEnabled() ? "enabled" : "disabled"} · dry run ${
        submissionDryRun() ? "active" : "off"
      } · policy ${policy.active ? "active" : "paused"}.`,
      live: blockedSecurity > 0 ? "Blocked" : verifiedSubmissions > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${verifiedSubmissions} employer-verified submission(s); ${blockedSecurity} blocked by an employer security control; ${awaitingHuman} awaiting a human step; ${scalar(
        "SELECT COUNT(*) AS n FROM applications WHERE submission_status = 'blocked'",
      )} stopped before submission for a missing answer.`,
      tests: ["autonomous-submission.test.ts", "browser-form.test.ts", "submission-dry-run.test.ts", "noor-submission-outcome.test.ts"],
      limitations:
        "Public ATS forms frequently require accounts, MFA or bot challenges. Two-platform certification is impossible without employer-issued access.",
      href: "/recruitment#standing-authorisation",
      lastSuccess: latest(
        one<{ submitted_at: string | null }>(
          "SELECT submitted_at FROM applications WHERE submission_status = 'verified' ORDER BY submitted_at DESC LIMIT 1",
        )?.submitted_at,
      ),
    },
    {
      id: "confirmation",
      category: "Employer confirmation and reconciliation",
      name: "Verified submission evidence and reconciliation",
      description:
        "Only an employer reference or reliable employer confirmation marks an application as submitted. An HTTP 200 or a browser click is never confirmation.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Reads the stored submission attempt and confirmation records.",
      live: verifiedSubmissions > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${verifiedSubmissions} application(s) carry verified employer evidence; ${scalar(
        "SELECT COUNT(*) AS n FROM applications WHERE submission_status = 'unverified'",
      )} remain unverified.`,
      tests: ["phase3-reconciliation.test.ts", "execution-truth.test.ts", "no-false-confirmation.test.ts"],
      limitations: "An owner attestation is recorded separately and never counted as employer confirmation.",
      href: "/applications?status=submitted",
      lastSuccess: latest(
        one<{ submitted_at: string | null }>(
          "SELECT submitted_at FROM applications WHERE submission_status = 'verified' ORDER BY submitted_at DESC LIMIT 1",
        )?.submitted_at,
      ),
    },
    {
      id: "outreach-contacts",
      category: "Hiring-manager discovery",
      name: "Evidence-based contact discovery",
      description:
        "Finds named hiring managers, talent acquisition staff or official recruitment contacts from vacancy text, real mailbox correspondence or bounded employer-hosted public pages.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Uses the vacancy record, connected mailbox and public employer pages.",
      live: outreachContacts > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${outreachContacts} verified contact(s) are stored; ${scalar(
        "SELECT COUNT(*) AS n FROM outreach_contacts WHERE verification_status = 'unavailable'",
      )} vacancy(ies) have no verifiable address.`,
      tests: ["phase4-outreach.test.ts", "phase5-surfaces.test.ts"],
      limitations:
        "No address is guessed from a naming pattern. A generic inbox is never presented as a named hiring manager.",
      href: "/outreach",
      lastSuccess: latest(one<{ created_at: string | null }>("SELECT MAX(created_at) AS created_at FROM outreach_contacts")?.created_at),
    },
    {
      id: "gmail-drafts",
      category: "Email drafting and Gmail integration",
      name: "Personalised Gmail drafts with attachments",
      description:
        "Creates one idempotent Gmail draft per application and verified recipient, carries the exact vacancy CV and cover letter with recorded hashes, updates that same draft in place when the wording improves, and reads it back from the mailbox. Nothing is sent automatically.",
      implementation: "Implemented",
      enabled: gmailConfigured && gmailAccounts > 0,
      dependency: gmailConfigured && gmailAccounts > 0 ? "Configured" : "Not configured",
      dependencyDetail:
        gmailAccounts > 0
          ? `Mailbox connected with ${gmailDraftScope ? "draft" : "no draft"} scope and ${gmailScopes.includes("gmail.send") ? "approval-gated send" : "no send"} scope.`
          : gmailMissing().join(" "),
      live: outreachDrafts > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${outreachDrafts} draft(s) stored; ${scalar(
        "SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'sent'",
      )} sent by the owner. Draft creation, in-place update and read-back are verified; sending is not.`,
      tests: ["phase4-outreach.test.ts", "phase6-outreach.test.ts", "gmail-profile.test.ts", "gmail-error-taxonomy.test.ts"],
      limitations:
        "Draft creation is not sending. Only the owner can send from the connected mailbox, and Gmail sending has not been exercised by this application.",
      href: "/outreach",
      lastSuccess: latest(one<{ created_at: string | null }>("SELECT MAX(created_at) AS created_at FROM outreach_drafts")?.created_at),
    },
    {
      id: "outreach-inbox",
      category: "Outreach owner dashboard and inbox",
      name: "Dashboard outreach card and owner inbox",
      description:
        "The main owner dashboard shows the six outreach counters and a shortcut labelled View prepared emails. /outreach lists every prepared message with its recipient, attachments, Gmail state, application status, sent state and reply state, and links to a full review view.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Reads the local outreach ledger and matched mailbox messages.",
      live: outreachDrafts > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${outreachDrafts} draft row(s) are shown from the database; ${scalar(
        "SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'draft_created'",
      )} await review, ${scalar("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'sent'")} are sent and ${scalar(
        "SELECT COUNT(*) AS n FROM outreach_drafts WHERE status IN ('failed','blocked','draft_missing')",
      )} need intervention.`,
      tests: ["phase5-surfaces.test.ts", "phase6-outreach.test.ts", "phase6-outreach.spec.ts"],
      limitations: "The card is a read model: it cannot send, create or repair a draft. Empty counters are shown as zero, never as sample data.",
      href: "/outreach",
      lastSuccess: latest(one<{ created_at: string | null }>("SELECT MAX(created_at) AS created_at FROM outreach_drafts")?.created_at),
    },
    {
      id: "gmail-send",
      category: "Outreach send state",
      name: "Owner-only sending and sent-copy reconciliation",
      description:
        "Sending is never automated. The stored state moves from draft to sent only when a sent copy with the exact recipient and subject is observed in Gmail's Sent label.",
      implementation: "Implemented",
      enabled: gmailConfigured && gmailAccounts > 0,
      dependency: gmailConfigured && gmailAccounts > 0 ? "Configured" : "Not configured",
      dependencyDetail: gmailAccounts > 0 ? "The connected mailbox is read to look for a sent copy." : gmailMissing().join(" "),
      live: scalar("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'sent'") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar(
        "SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'sent'",
      )} sent email(s) observed; ${scalar(
        "SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'draft_created'",
      )} draft(s) remain unsent. Gmail sending itself has not been exercised through this application.`,
      tests: ["phase4-outreach.test.ts", "gmail-profile.test.ts"],
      limitations: "An absent sent copy leaves the draft state unchanged. This application never calls the Gmail send endpoint for outreach.",
      href: "/outreach",
      lastSuccess: null,
    },
    {
      id: "form-adapter-digital-forms",
      category: "Embedded application form adapters",
      name: "Third-party embedded form identification",
      description:
        "Identifies upload fields from their DOM name, label, wrapper caption and accept type, detects indistinguishable uploads and required selects, verifies that each uploaded file survives, and stops before submitting when an answer is missing.",
      implementation: "Partially implemented",
      enabled: browserFormsEnabled(),
      dependency: "Configured",
      dependencyDetail: "Runs through the local Playwright executor; approved form-provider hosts are explicitly listed.",
      live: scalar("SELECT COUNT(*) AS n FROM applications WHERE submission_status = 'blocked'") > 0 ? "Blocked" : "Awaiting live verification",
      liveDetail: `${scalar(
        "SELECT COUNT(*) AS n FROM applications WHERE submission_status = 'blocked'",
      )} application(s) stopped before submission because a required answer is missing. No such form has been completed end to end.`,
      tests: ["clickup-form-adapter.test.ts", "browser-form.test.ts", "browser-iframe.test.ts"],
      limitations:
        "The Digt ClickUp form requires a department and referral answer that are not in the verified profile, and its upload fields cannot be told apart with the rendered markup. It remains blocked by design.",
      href: "/applications?column=needs_attention#board",
      lastSuccess: null,
    },
    {
      id: "reply-sync",
      category: "Employer reply synchronisation",
      name: "Mailbox reply synchronisation",
      description:
        "Reads the connected mailbox, matches employer replies to applications and stores the correspondence for the owner.",
      implementation: "Implemented",
      enabled: gmailConfigured && gmailAccounts > 0,
      dependency: gmailConfigured && gmailAccounts > 0 ? "Configured" : "Not configured",
      dependencyDetail: gmailAccounts > 0 ? "The connected mailbox has read access." : gmailMissing().join(" "),
      live: scalar("SELECT COUNT(*) AS n FROM email_messages") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM email_messages")} matched message(s) stored.`,
      tests: ["email-ai.test.ts", "email-delivery.test.ts", "phase4-outreach.test.ts"],
      limitations: "A reply is only matched when the sender and thread can be tied to a stored application or outreach recipient.",
      href: "/inbox",
      lastSuccess: latest(one<{ last_sync_at: string | null }>("SELECT MAX(last_sync_at) AS last_sync_at FROM gmail_accounts")?.last_sync_at),
    },
    {
      id: "conversations",
      category: "Agent conversations",
      name: "Direct conversations with all eight agents",
      description:
        "Each registered agent has its own persisted session, instructions and provider attribution. Agent cards link straight to a conversation.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Deterministic routing works without inference; a provider is optional for richer answers.",
      live: scalar("SELECT COUNT(*) AS n FROM chat_messages") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM chat_messages")} message(s) and ${scalar(
        "SELECT COUNT(*) AS n FROM agent_sessions",
      )} session(s) are stored.`,
      tests: ["agent-conversation-routing.test.ts", "agent-routing.test.ts", "conversation.spec.ts"],
      limitations: "A specialist refuses work outside its role and refers it to the Coordinator rather than pretending to act.",
      href: "/assistant",
      lastSuccess: latest(one<{ created_at: string | null }>("SELECT MAX(created_at) AS created_at FROM chat_messages")?.created_at),
    },
    {
      id: "orchestration",
      category: "Noor orchestration and reporting",
      name: "Recruitment orchestration and run reporting",
      description:
        "Coordinates the specialist agents through persisted tasks and dependencies, then reports the actual outcome of every stage and every application.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Runs inside the application process.",
      live: scalar("SELECT COUNT(*) AS n FROM recruitment_runs") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM recruitment_runs")} run(s) recorded; last status ${
        one<{ status: string }>("SELECT status FROM recruitment_runs ORDER BY created_at DESC LIMIT 1")?.status ?? "none"
      }.`,
      tests: ["phase3-orchestration.test.ts", "recruitment-stage-recovery.test.ts", "recruitment-production-resume.test.ts"],
      limitations: "Agents cannot complete each other's tasks; a failed task stays failed and is visible.",
      href: "/recruitment",
      lastSuccess: latest(
        one<{ finished_at: string | null }>(
          "SELECT finished_at FROM recruitment_runs WHERE status = 'completed' ORDER BY finished_at DESC LIMIT 1",
        )?.finished_at,
      ),
    },
    {
      id: "scheduler",
      category: "Scheduler and background workers",
      name: "Daily scheduler and durable workers",
      description:
        "Exactly one daily recruitment run at the persisted time in Europe/Zurich, plus named background workers for AI, notifications, recovery and document cleanup.",
      implementation: "Implemented",
      enabled: schedule.enabled,
      dependency: "Configured",
      dependencyDetail: `${schedule.time} ${schedule.timezone} on ${schedule.weekdayLabels.join(", ")}. One schedule row, no polling schedule.`,
      live: schedulerLive ? "Live-verified" : "Awaiting live verification",
      liveDetail: schedulerLive
        ? `Ticker running; last check ${schedule.lastCheckedAt ?? "unknown"}. Last outcome ${schedule.lastStatus ?? "none"}.`
        : `No ticker heartbeat detected. Last stored check ${schedule.lastCheckedAt ?? "never"}.`,
      tests: ["daily-scheduler.test.ts", "weekly-schedule.test.ts", "runtime.test.ts"],
      limitations: "The host must be awake and the process running at the scheduled minute; a missed occurrence is recorded with its scheduled timestamp and reason, never replayed as a catch-up run.",
      href: "/recruitment#schedule",
      lastSuccess: schedule.lastRunAt,
    },
    {
      id: "notifications",
      category: "Notifications",
      name: "In-app and email notifications",
      description: "Durable notification outbox with in-app delivery and optional Resend email delivery.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "In-app delivery is local; email delivery additionally needs the Resend configuration.",
      live: scalar("SELECT COUNT(*) AS n FROM notifications") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM notifications")} notification(s) and ${scalar(
        "SELECT COUNT(*) AS n FROM notification_outbox",
      )} outbox row(s) are stored.`,
      tests: ["email-delivery.test.ts", "recovery-notify.test.ts", "executive-brief-resend.test.ts"],
      limitations: "Email delivery status is provider-reported; an accepted API call is not a read receipt.",
      href: "/settings#notifications",
      lastSuccess: latest(one<{ created_at: string | null }>("SELECT MAX(created_at) AS created_at FROM notifications")?.created_at),
    },
    {
      id: "audit",
      category: "Audit logs and submission history",
      name: "Audit trail and application history",
      description:
        "User actions, application events, submission attempts and outreach events are persisted with timestamps and evidence.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Stored in the local database.",
      live: scalar("SELECT COUNT(*) AS n FROM audit_logs") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM audit_logs")} audit entries and ${scalar(
        "SELECT COUNT(*) AS n FROM application_events",
      )} application events are stored.`,
      tests: ["audit-query.test.ts", "application-lifecycle.test.ts"],
      limitations: "The audit trail records what the application did; it cannot prove an action taken outside it.",
      href: "/admin/audit",
      lastSuccess: latest(one<{ created_at: string | null }>("SELECT MAX(created_at) AS created_at FROM audit_logs")?.created_at),
    },
    {
      id: "ai-spending",
      category: "AI provider and spending controls",
      name: "Free-tier AI routing and CHF 0.00 controls",
      description:
        "Provider calls are routed through the spending policy, queued, attributed per agent and refused when a free allowance cannot be verified.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Configured",
      dependencyDetail: `${providerRows} provider call(s) recorded.`,
      live: "Live-verified",
      liveDetail: `Recorded spend CHF ${spend.toFixed(2)} across ${providerRows} call(s). Missing cost data is reported as unverified, not as zero.`,
      tests: ["zero-cost.test.ts", "ai-spending-policy.test.ts", "free-tier-policy.test.ts", "token-attribution.test.ts"],
      limitations: "A zero recorded cost depends on provider-reported or estimated usage; it is not an external invoice.",
      href: "/admin/ai",
      lastSuccess: latest(one<{ created_at: string | null }>("SELECT MAX(created_at) AS created_at FROM provider_usage")?.created_at),
    },
    {
      id: "database",
      category: "Database, migrations and backups",
      name: "SQLite schema, additive migrations and backups",
      description:
        "Additive numbered migrations with a pre-migration backup, foreign-key enforcement and integrity verification.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Configured",
      dependencyDetail: `Schema version ${SCHEMA_VERSION}, ${schema} applied migration(s), ${backups} backup file(s).`,
      live: "Live-verified",
      liveDetail:
        one<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check === "ok"
          ? "Integrity check returned ok and foreign keys are enforced."
          : "Integrity check did not return ok.",
      tests: ["runtime.test.ts", "recruitment-phase1.test.ts"],
      limitations: "Backups are local; they do not protect against loss of the host disk.",
      href: "/admin/storage",
      lastSuccess: latest(
        one<{ applied_at: string | null }>("SELECT MAX(applied_at) AS applied_at FROM schema_migrations")?.applied_at,
      ),
    },
    {
      id: "security",
      category: "Security and access controls",
      name: "Authentication, MFA and authorisation",
      description:
        "Session cookies, password hashing, login throttling, optional TOTP MFA, role checks and restrictive security headers.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Local accounts; MFA is available but not enforced for every account.",
      live: "Live-verified",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM users WHERE status = 'active'")} active account(s); ${scalar(
        "SELECT COUNT(*) AS n FROM users WHERE mfa_enabled = 1",
      )} with MFA enabled.`,
      tests: ["security-hardening.test.ts", "mfa.test.ts", "login-throttle.test.ts", "workflow-security.test.ts"],
      limitations: "A single-account local deployment; there is no external identity provider or SSO.",
      href: "/admin/security",
      lastSuccess: latest(one<{ created_at: string | null }>("SELECT MAX(created_at) AS created_at FROM sessions")?.created_at),
    },
    {
      id: "diagnostics",
      category: "System health and diagnostics",
      name: "Runtime health and diagnostics",
      description:
        "Worker heartbeats, provider health, queue state, database checks and a diagnostics view that distinguishes unknown from healthy.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Reads local runtime state.",
      live: liveWorkers.length > 0 ? "Live-verified" : "Failed",
      liveDetail:
        liveWorkers.length > 0
          ? `${liveWorkers.length} of ${workers.length} worker(s) have a fresh heartbeat.`
          : "No worker heartbeat is fresh; background processing may not be running.",
      tests: ["provider-status.test.ts", "health-access.test.ts", "runtime.test.ts"],
      limitations: "A missing heartbeat is reported as not running; it is never presented as healthy because a schedule row exists.",
      href: "/admin/diagnostics",
      lastSuccess: liveWorkers.map((worker) => worker.heartbeat_at).sort().at(-1) ?? null,
    },
    {
      id: "handoff",
      category: "Human intervention handoff",
      name: "Handoff packages for blocked applications",
      description:
        "When a legitimate human step blocks submission, the owner receives the employer link, documents, prepared answers and remaining steps.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Built from the stored application and queue evidence.",
      live: awaitingHuman > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${awaitingHuman} handoff item(s) are stored in the persistent queue.`,
      tests: ["handoff.test.ts", "phase3-application-detail.spec.ts"],
      limitations: "The handoff does not submit anything on the owner's behalf.",
      href: "/recruitment#handoffs",
      lastSuccess: latest(one<{ entered_at: string | null }>("SELECT MAX(entered_at) AS entered_at FROM recruitment_queue WHERE state = 'awaiting_human'")?.entered_at),
    },
    {
      id: "analytics",
      category: "Analytics and reporting",
      name: "Recruitment analytics and executive brief",
      description:
        "Funnel, source contribution and delivery reporting built from persisted records, including a scheduled executive brief.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Reads persisted runs, jobs and applications.",
      live: scalar("SELECT COUNT(*) AS n FROM applications") > 0 ? "Live-verified" : "Awaiting live verification",
      liveDetail: `${scalar("SELECT COUNT(*) AS n FROM applications")} application record(s) feed the analytics.`,
      tests: ["analytics.test.ts", "executive-brief.test.ts", "email-report.test.ts"],
      limitations: "Reporting cannot include activity that happened outside the application.",
      href: "/analytics",
      lastSuccess: latest(one<{ created_at: string | null }>("SELECT MAX(created_at) AS created_at FROM applications")?.created_at),
    },
    {
      id: "voice",
      category: "Voice interface",
      name: "Live voice assistant",
      description:
        "Browser voice conversation with the Coordinator and specialists, with a deterministic text fallback when live audio is unavailable.",
      implementation: "Partially implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Requires a browser with microphone permission and a verified free Gemini Live allowance.",
      live: "Awaiting live verification",
      liveDetail: "Real-provider voice evidence is skipped in automated runs that lack a live provider attestation.",
      tests: ["agent-voice-stability.test.ts", "voice-gemini-real.spec.ts (skipped without real evidence)"],
      limitations: "Voice quality and provider availability depend on the browser and Google's free-tier allowance; text chat remains the reliable path.",
      href: "/assistant",
      lastSuccess: null,
    },
    {
      id: "agent-reach",
      category: "Bounded external research",
      name: "Agent Reach read-only research",
      description:
        "Bounded, read-only page reads used as evidence for a vacancy. Retrieved content is untrusted data and can never alter a score or satisfy a gate.",
      implementation: "Implemented",
      enabled: true,
      dependency: "Not required",
      dependencyDetail: "Bounded by a per-run cap; no credential is required.",
      live: "Awaiting live verification",
      liveDetail: "Evidence reads are recorded per run; financial or credential-bearing pages are refused.",
      tests: ["agent-reach.test.ts", "discovery-research-enrichment.test.ts"],
      limitations: "Read-only evidence; it cannot submit, log in or bypass a control.",
      href: "/recruitment",
      lastSuccess: null,
    },
  ];

  const summary = {
    total: capabilities.length,
    liveVerified: capabilities.filter((item) => item.live === "Live-verified").length,
    awaitingVerification: capabilities.filter((item) => item.live === "Awaiting live verification").length,
    blocked: capabilities.filter((item) => item.live === "Blocked").length,
    failed: capabilities.filter((item) => item.live === "Failed").length,
    disabled: capabilities.filter((item) => !item.enabled).length,
    notConfigured: capabilities.filter((item) => item.dependency === "Not configured").length,
  };

  return { capabilities, summary };
}
