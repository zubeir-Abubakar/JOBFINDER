import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { hashPassword, randomId } from "./security.ts";
import { AGENT_IDENTITIES } from "./agent-identity.ts";
import { applyMigrations } from "./migrations.ts";
import { businessDayKey } from "./business-day.ts";

/** Data location is configurable so a verification run can use an isolated database. */
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const TEMP_DIR = path.join(DATA_DIR, "temp");

/** Established administrator identity. The legacy address is migrated once. */
export const ADMIN_EMAIL = "abubakar@admin.com";
const LEGACY_ADMIN_EMAIL = "admin@admin.com";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin')),
  status TEXT NOT NULL DEFAULT 'active',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  avatar_path TEXT,
  avatar_mime TEXT,
  avatar_updated_at TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  actor TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  full_name TEXT,
  headline TEXT,
  email TEXT,
  phone TEXT,
  location TEXT,
  work_authorisation TEXT,
  permit_valid_until TEXT,
  summary TEXT,
  linkedin TEXT,
  website TEXT,
  languages TEXT,
  preferences TEXT,
  source_cv_id TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'working',
  years REAL,
  verified INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS profile_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  detail TEXT,
  start_date TEXT,
  end_date TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  start_date TEXT,
  end_date TEXT,
  is_current INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  achievements TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  remote INTEGER NOT NULL DEFAULT 0,
  employment_type TEXT,
  salary TEXT,
  url TEXT,
  description TEXT,
  language_text TEXT,
  posted_at TEXT,
  discovered_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  match_score INTEGER,
  match_flag TEXT,
  analysis TEXT,
  ai_note TEXT,
  duplicate_of TEXT,
  raw TEXT,
  last_seen_at TEXT,
  last_seen_source TEXT,
  expiry_at TEXT,
  expiry_status TEXT,
  vacancy_status TEXT,
  vacancy_verified_at TEXT,
  vacancy_verification TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(source, external_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('original_cv','tailored_cv','cover_letter')),
  display_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  job_id TEXT,
  version TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  pinned INTEGER NOT NULL DEFAULT 0,
  ats_score INTEGER,
  ats_report TEXT,
  quality_status TEXT,
  quality_score INTEGER,
  quality_report TEXT,
  text_content TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'discovered',
  cv_document_id TEXT,
  cover_letter_id TEXT,
  method TEXT,
  confirmation TEXT,
  approved_at TEXT,
  submitted_at TEXT,
  notes TEXT,
  last_update TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',
  current_task TEXT,
  last_run_at TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  config TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT,
  agent_key TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  detail TEXT,
  output TEXT,
  error TEXT,
  requires_input INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  summary TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'in-app',
  status TEXT NOT NULL DEFAULT 'unread',
  read_at TEXT,
  report_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_reset ON api_rate_limits(reset_at);
CREATE TABLE IF NOT EXISTS job_sources (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS provider_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  workflow_id TEXT,
  task_id TEXT,
  session_id TEXT,
  source TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  usage_source TEXT,
  cost_chf REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_usage_created ON provider_usage(created_at);
CREATE TABLE IF NOT EXISTS ai_policy_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  agent_key TEXT,
  workflow_id TEXT,
  task_id TEXT,
  session_id TEXT,
  source TEXT,
  operation TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  execution_type TEXT NOT NULL,
  decision TEXT NOT NULL,
  block_reason TEXT,
  verification_timestamp TEXT,
  evidence_reference TEXT,
  network_transmitted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_policy_created ON ai_policy_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_policy_decision ON ai_policy_decisions(decision, created_at DESC);
CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  workflow_id TEXT,
  task_id TEXT,
  source TEXT NOT NULL DEFAULT 'task',
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  provider TEXT,
  model TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_due ON ai_jobs(status, available_at);
CREATE TABLE IF NOT EXISTS gmail_accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT NOT NULL,
  scopes TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  last_sync_at TEXT
);
CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  gmail_id TEXT NOT NULL UNIQUE,
  thread_id TEXT,
  application_id TEXT,
  sender TEXT,
  subject TEXT,
  snippet TEXT,
  category TEXT NOT NULL DEFAULT 'unclassified',
  body_text TEXT,
  draft_id TEXT,
  draft_body TEXT,
  draft_status TEXT NOT NULL DEFAULT 'none',
  received_at TEXT,
  created_at TEXT NOT NULL,
  ai_category TEXT,
  ai_classified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_messages_received ON email_messages(received_at);
CREATE TABLE IF NOT EXISTS workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  agent_key TEXT,
  type TEXT NOT NULL,
  message TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events(workflow_id, id);
CREATE TABLE IF NOT EXISTS temp_objects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  relative_path TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_temp_objects_expiry ON temp_objects(status, expires_at);
CREATE TABLE IF NOT EXISTS recruitment_runs (
  id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL UNIQUE,
  workflow_id TEXT,
  scheduled_for TEXT,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  state_history TEXT,
  started_at TEXT,
  finished_at TEXT,
  jobs_discovered INTEGER NOT NULL DEFAULT 0,
  jobs_duplicates INTEGER NOT NULL DEFAULT 0,
  jobs_filtered INTEGER NOT NULL DEFAULT 0,
  jobs_updated INTEGER NOT NULL DEFAULT 0,
  discovery_scope TEXT NOT NULL DEFAULT 'full',
  discovery_since TEXT,
  jobs_eligible INTEGER NOT NULL DEFAULT 0,
  jobs_qualified INTEGER NOT NULL DEFAULT 0,
  sources_checked INTEGER NOT NULL DEFAULT 0,
  sources_succeeded INTEGER NOT NULL DEFAULT 0,
  sources_failed INTEGER NOT NULL DEFAULT 0,
  sources_partial INTEGER NOT NULL DEFAULT 0,
  discovery_state TEXT,
  packages_prepared INTEGER NOT NULL DEFAULT 0,
  applications_submitted INTEGER NOT NULL DEFAULT 0,
  applications_unverified INTEGER NOT NULL DEFAULT 0,
  applications_intervention INTEGER NOT NULL DEFAULT 0,
  applications_simulated INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  warnings INTEGER NOT NULL DEFAULT 0,
  report TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruitment_runs_created ON recruitment_runs(created_at DESC);
CREATE TABLE IF NOT EXISTS recruitment_run_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  assignment TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  output TEXT,
  error TEXT,
  coordinator_decision TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruitment_run_agents_run ON recruitment_run_agents(run_id, id);
CREATE TABLE IF NOT EXISTS schedule_jobs (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  weekdays TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_id TEXT,
  last_status TEXT,
  last_error TEXT,
  last_scheduled_for TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_locks (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_runtime_locks_expiry ON runtime_locks(expires_at);
CREATE TABLE IF NOT EXISTS runtime_workers (
  name TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  stopped_at TEXT,
  detail TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_workers_heartbeat ON runtime_workers(status, heartbeat_at);
CREATE TABLE IF NOT EXISTS submission_attempts (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT,
  channel TEXT NOT NULL,
  endpoint TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  reference TEXT,
  evidence TEXT,
  error TEXT,
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submission_attempts_job ON submission_attempts(job_id, status);
CREATE TABLE IF NOT EXISTS application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_application_events_app ON application_events(application_id, id);
CREATE TABLE IF NOT EXISTS discovery_source_status (
  source_key TEXT NOT NULL,
  employer TEXT,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  postings INTEGER NOT NULL DEFAULT 0,
  fresh INTEGER NOT NULL DEFAULT 0,
  relevant INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  error_category TEXT,
  status_code INTEGER,
  last_attempts INTEGER NOT NULL DEFAULT 0,
  last_duration_ms INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT NOT NULL,
  last_success_at TEXT,
  last_run_id TEXT,
  PRIMARY KEY (source_key, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_discovery_source_checked ON discovery_source_status(last_checked_at DESC);
CREATE TABLE IF NOT EXISTS application_interventions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  field TEXT,
  question TEXT NOT NULL,
  reason TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interventions_status ON application_interventions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interventions_app ON application_interventions(application_id, status);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  previous_agent_key TEXT,
  context_summary TEXT,
  started_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  UNIQUE(user_id, agent_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_user ON agent_sessions(user_id, status, last_active_at DESC);
CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  failure_kind TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT,
  last_error TEXT,
  last_error_at TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);
CREATE INDEX IF NOT EXISTS idx_provider_health_cooldown ON provider_health(status, cooldown_until);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  notification_id INTEGER,
  user_id TEXT,
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  html_body TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  provider TEXT,
  provider_message_id TEXT,
  provider_thread_id TEXT,
  delivery TEXT,
  report_id TEXT,
  sender TEXT,
  rfc_message_id TEXT,
  gmail_response TEXT,
  sent_observed_at TEXT,
  sent_verification TEXT,
  delivery_evidence TEXT,
  bounce_info TEXT,
  resend_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_due ON notification_outbox(status, available_at);
CREATE TABLE IF NOT EXISTS recruitment_recovery (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  job_id TEXT,
  application_id TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recruitment_recovery_due ON recruitment_recovery(status, available_at);
CREATE TABLE IF NOT EXISTS recruitment_stage_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  output_refs TEXT,
  evidence TEXT,
  decision TEXT,
  reason TEXT,
  next_stage TEXT,
  heartbeat_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, job_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_stage_checkpoints_run ON recruitment_stage_checkpoints(run_id, job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stage_checkpoints_status ON recruitment_stage_checkpoints(status, updated_at);
`;

type GlobalWithDb = typeof globalThis & { __atwDb?: DatabaseSync };
const g = globalThis as GlobalWithDb;

/**
 * Module-scoped (not global) so a hot-reloaded module re-verifies the cached
 * handle. A dev server can keep `globalThis.__atwDb` from a build that predates
 * a new column; returning early would leave that handle unmigrated and every
 * query touching the new schema would crash.
 */
let schemaReady = false;

function restrictMode(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch {
    // Some filesystems (notably mounted volumes) cannot represent POSIX modes.
    // The health endpoint reports the actual mode instead of claiming success.
  }
}

/**
 * Phase 2 registry backfill. Idempotent, additive and evidence-based.
 *
 * - fills the unique dedupe key for legacy rows that lacked one, so the same
 *   listing cannot be inserted twice again;
 * - derives the canonical identity using the documented precedence;
 * - records the internal qualification outcome separately from the legacy
 *   `status` bucket. No employer decision is invented: an employer rejection
 *   only ever exists on `applications` with employer evidence.
 */
export function backfillJobRegistry(db: DatabaseSync): void {
  db.exec(`
    UPDATE jobs
       SET dedupe_key = 'legacy:' || lower(source) || ':' || lower(external_id)
     WHERE dedupe_key IS NULL AND external_id IS NOT NULL;

    UPDATE jobs
       SET employer_key = trim(lower(replace(replace(replace(replace(replace(company,
             ' AG', ''), ' GmbH', ''), ' SA', ''), ' Ltd', ''), ' Inc', '')))
     WHERE employer_key IS NULL;

    UPDATE jobs
       SET canonical_key = CASE
             WHEN requisition_id IS NOT NULL AND requisition_id <> ''
               THEN 'req:' || employer_key || ':' || lower(requisition_id)
             WHEN employer_url IS NOT NULL AND employer_url <> ''
               THEN 'url:' || employer_url
             WHEN dedupe_key IS NOT NULL
               THEN 'id:' || dedupe_key
             WHEN external_id IS NOT NULL
               THEN 'src:' || lower(source) || ':' || lower(external_id)
             ELSE 'id:' || lower(trim(company)) || '|' || lower(trim(title)) || '|' || lower(trim(COALESCE(location, '')))
           END
     WHERE canonical_key IS NULL;

    UPDATE jobs
       SET qualification_status = CASE
             WHEN qualified = 1 OR status IN ('applied', 'shortlisted', 'documents') THEN 'qualified'
             WHEN status = 'rejected' AND eligibility = 'ineligible' THEN 'ineligible'
             WHEN status = 'rejected' AND eligibility = 'needs_review' THEN 'needs_review'
             WHEN status = 'rejected' AND match_score IS NOT NULL AND match_score < 85 THEN 'below_threshold'
             WHEN status = 'rejected' THEN 'below_threshold'
             ELSE 'pending'
           END
     WHERE qualification_status IS NULL;

    UPDATE jobs
       SET vacancy_status = 'verification_unknown'
     WHERE vacancy_status IS NULL;
  `);
}

export function getDb(): DatabaseSync {
  if (g.__atwDb) {
    if (!schemaReady) {
      ensureSchema(g.__atwDb);
      schemaReady = true;
    }
    return g.__atwDb;
  }
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  restrictMode(DATA_DIR, 0o700);
  mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  restrictMode(UPLOAD_DIR, 0o700);
  mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 });
  restrictMode(TEMP_DIR, 0o700);
  const dbFile = path.join(DATA_DIR, "at-ai-workforce.db");
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Every daily boundary is a Europe/Zurich calendar day. Exposing the
  // conversion to SQL keeps filters and grouping DST-correct instead of
  // assuming a fixed UTC offset (a Zurich day can be 23 or 25 hours).
  db.function("business_day", { deterministic: true }, (value: unknown) => {
    if (value === null || value === undefined) return null;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : businessDayKey(parsed);
  });
  ensureSchema(db);
  migrate(db);
  seed(db);
  restrictMode(dbFile, 0o600);
  for (const suffix of ["-wal", "-shm"]) restrictMode(`${dbFile}${suffix}`, 0o600);
  g.__atwDb = db;
  schemaReady = true;
  return db;
}

/** Per-request helper so callers can assert the schema is current. */
/** Close the process-local handle. Used by restart/recovery verification. */
export function closeDb(): void {
  if (g.__atwDb) {
    g.__atwDb.close();
    g.__atwDb = undefined;
    schemaReady = false;
  }
}

/** Per-request helper so callers can assert the schema is current. */
export function schemaVersion(): number {
  const row = getDb().prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

export function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return getDb().prepare(sql).all(...(params as never[])) as T[];
}

export function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
  const row = getDb().prepare(sql).get(...(params as never[]));
  return (row as T) ?? null;
}

export function run(sql: string, params: unknown[] = []): void {
  getDb().prepare(sql).run(...(params as never[]));
}

export const nowIso = () => new Date().toISOString();

/** Normalise values for node:sqlite (no booleans / undefined allowed). */
export function v(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return String(value);
}

const DEFAULT_SETTINGS: Record<string, unknown> = {
  retention_days: 30,
  auto_delete_expired: true,
  // Operating defaults. Eligible applications are submitted autonomously.
  // There is no per-application approval gate; a fresh installation submits
  // only applications that pass every eligibility, document, duplicate and
  // safety check. Consequential declarations, CAPTCHAs, MFA and unsupported
  // portals still stop the workflow for a human. The owner can pause automatic
  // submission at any time.
  approval_mode: false,
  autonomous_submission: true,
  min_match_score: 85,
  max_applications_per_day: 3,
  recruitment_dry_run: false,
  recruitment_submission_enabled: true,
  standing_authorisation_activated_at: null as string | null,
  authorised_answers: {} as Record<string, string>,
  ashby_job_boards: [] as string[],
  employer_career_pages: [] as string[],
  greenhouse_boards: [] as string[],
  lever_sites: [] as string[],
  search_frequency: "daily",
  duplicate_detection: true,
  notify_daily_report: true,
  notify_weekly_report: true,
  notify_immediate: true,
  notify_agent_failure: true,
  notify_interview: true,
  use_date_filter: false,
  ai: {
    provider: "rules",
    model: "at-rules-v1",
    temperature: 0.2,
    max_tokens: 2048,
    local_model: "llama3.1:8b",
    fallback: "rules",
    usage_tokens: 0,
  },
  email: {
    provider: "gmail",
    connected: false,
    sender: "",
    account: "",
  },
  security: {
    session_days: 7,
    remember_days: 30,
    max_login_attempts: 8,
  },
  backup: { enabled: true, last_backup_at: null as string | null },
  deletion: { last_run_at: null as string | null, last_deleted: 0 },
};

const AGENT_SEED = [
  {
    key: "coordinator",
    name: AGENT_IDENTITIES.coordinator.name,
    role: AGENT_IDENTITIES.coordinator.role,
    description:
      "Owns every recruitment workflow: assigns work to specialist agents, tracks task progress, enforces your rules, retries recoverable failures and produces reports.",
    config: { max_retries: 2, priority: "balanced" },
  },
  {
    key: "research",
    name: AGENT_IDENTITIES.research.name,
    role: AGENT_IDENTITIES.research.role,
    description:
      "Searches configured job sources for QA and test engineering vacancies in Switzerland or remote roles open to Swiss-based candidates, extracts descriptions and blocks duplicates.",
    config: { titles: ["Senior QA Engineer", "QA Automation Engineer", "SDET", "Test Lead"], locations: ["Lausanne", "Geneva", "Zurich", "Bern", "Remote"] },
  },
  {
    key: "analysis",
    name: AGENT_IDENTITIES.analysis.name,
    role: AGENT_IDENTITIES.analysis.role,
    description:
      "Reads each vacancy against the verified professional profile, scores the match across six weighted dimensions and explains gaps without auto-rejecting on preferred skills alone.",
    config: { weights: { technical: 35, experience: 25, seniority: 15, language: 10, location: 10, salary: 5 } },
  },
  {
    key: "cv",
    name: AGENT_IDENTITIES.cv.name,
    role: AGENT_IDENTITIES.cv.role,
    description:
      "Tailors the CV to a vacancy using only verified facts from your master profile, reorders relevant skills and produces ATS-friendly PDF and DOCX files.",
    config: { formats: ["pdf", "docx"] },
  },
  {
    key: "ats",
    name: AGENT_IDENTITIES.ats.name,
    role: AGENT_IDENTITIES.ats.role,
    description:
      "Audits generated documents for keyword coverage, formatting, section structure, contact details and unsupported claims before anything can be submitted.",
    config: { pass_threshold: 70, block_fabrication: true },
  },
  {
    key: "cover",
    name: AGENT_IDENTITIES.cover.name,
    role: AGENT_IDENTITIES.cover.role,
    description:
      "Writes vacancy-specific cover letters grounded in your real experience and work authorisation, producing PDF and DOCX files with no invented claims.",
    config: { formats: ["pdf", "docx"] },
  },
  {
    key: "application",
    name: AGENT_IDENTITIES.application.name,
    role: AGENT_IDENTITIES.application.role,
    description:
      "Prepares and submits applications through supported channels. Runs in approval mode by default, verifies eligibility and captures submission confirmations.",
    config: { mode: "approval", supported_channels: ["employer_portal_manual", "email"] },
  },
  {
    key: "email",
    name: AGENT_IDENTITIES.email.name,
    role: AGENT_IDENTITIES.email.role,
    description:
      "Sends notifications, records confirmations, watches for employer responses and keeps application statuses current.",
    config: { provider: "in-app", immediate: true },
  },
];

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** Additive migrations only — existing records are never dropped or rewritten. */
export const SCHEMA_VERSION = 29;

/**
 * Idempotent schema enforcement. Safe to run on every open and on a cached
 * handle: CREATE TABLE IF NOT EXISTS plus ADD COLUMN only. No table is dropped,
 * rebuilt or rewritten, and existing rows are preserved verbatim.
 */
function ensureSchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
  ensureColumn(db, "tasks", "provider", "provider TEXT");
  ensureColumn(db, "tasks", "model", "model TEXT");
  ensureColumn(db, "tasks", "attempts", "attempts INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "workflows", "params", "params TEXT");
  ensureColumn(db, "workflows", "error", "error TEXT");
  ensureColumn(db, "workflows", "pause_requested", "pause_requested INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "workflows", "stop_requested", "stop_requested INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "workflows", "started_by", "started_by TEXT");
  // Execution integrity: distinguish model-backed work from deterministic work.
  // Historical rows stay NULL (unknown), so no past record is rewritten.
  ensureColumn(db, "tasks", "execution_mode", "execution_mode TEXT");
  ensureColumn(db, "tasks", "ai_outcome", "ai_outcome TEXT");
  ensureColumn(db, "agents", "ai_success_count", "ai_success_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "agents", "ai_failure_count", "ai_failure_count INTEGER NOT NULL DEFAULT 0");
  // Cost is not verifiable: the gateway publishes no pricing metadata. Historical
  // rows keep NULL (unknown) rather than being relabelled as verified zero cost.
  ensureColumn(db, "provider_usage", "cost_status", "cost_status TEXT");
  ensureColumn(db, "provider_usage", "routed_platform", "routed_platform TEXT");
  ensureColumn(db, "provider_usage", "routed_model", "routed_model TEXT");
  // Attribution: task-bound calls link to the task that caused them, while
  // assistant/admin/manual calls carry an explicit source and no task id.
  ensureColumn(db, "provider_usage", "task_id", "task_id TEXT");
  ensureColumn(db, "provider_usage", "source", "source TEXT");
  // Phase 3: token provenance and conversation attribution. Historical rows
  // keep NULL provenance rather than being relabelled as measured.
  ensureColumn(db, "provider_usage", "usage_source", "usage_source TEXT");
  ensureColumn(db, "provider_usage", "cached_tokens", "cached_tokens INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "provider_usage", "session_id", "session_id TEXT");
  // Fallback provenance is additive: historical rows keep NULL, while new
  // successful local fallbacks record why the primary route was not used.
  ensureColumn(db, "provider_usage", "fallback_from", "fallback_from TEXT");
  ensureColumn(db, "provider_usage", "fallback_reason", "fallback_reason TEXT");
  ensureColumn(db, "agent_sessions", "previous_agent_key", "previous_agent_key TEXT");
  ensureColumn(db, "agent_sessions", "context_summary", "context_summary TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_usage_session ON provider_usage(session_id)");
  ensureColumn(db, "email_messages", "ai_category", "ai_category TEXT");
  ensureColumn(db, "email_messages", "ai_classified_at", "ai_classified_at TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_usage_task ON provider_usage(task_id)");
  ensureColumn(db, "users", "must_change_password", "must_change_password INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "users", "avatar_path", "avatar_path TEXT");
  ensureColumn(db, "users", "avatar_mime", "avatar_mime TEXT");
  ensureColumn(db, "users", "avatar_updated_at", "avatar_updated_at TEXT");
  // Optional TOTP MFA. Secrets are encrypted with APP_SECRET_KEY; historical
  // accounts stay disabled until the owner explicitly enrols an authenticator.
  ensureColumn(db, "users", "mfa_enabled", "mfa_enabled INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "users", "mfa_secret", "mfa_secret TEXT");
  ensureColumn(db, "users", "mfa_pending_secret", "mfa_pending_secret TEXT");
  ensureColumn(db, "users", "mfa_recovery_hashes", "mfa_recovery_hashes TEXT");
  ensureColumn(db, "users", "mfa_last_step", "mfa_last_step INTEGER");
  ensureColumn(db, "users", "mfa_enabled_at", "mfa_enabled_at TEXT");
  ensureColumn(db, "jobs", "ai_note", "ai_note TEXT");
  // Document quality is stored per file so the UI can show the same gate that
  // accepted or rejected the PDF, rather than a post-hoc advisory note.
  ensureColumn(db, "documents", "quality_status", "quality_status TEXT");
  ensureColumn(db, "documents", "quality_score", "quality_score INTEGER");
  ensureColumn(db, "documents", "quality_report", "quality_report TEXT");
  // CV editor: rich role content is stored beside the plain-text fields used by
  // tailoring and quality gates. Soft deletes keep an explicit removal from
  // being resurrected on the next CV import; they never alter the upload.
  ensureColumn(db, "skills", "deleted_at", "deleted_at TEXT");
  ensureColumn(db, "profiles", "languages_synced_at", "languages_synced_at TEXT");
  ensureColumn(db, "profiles", "cv_synced_source", "cv_synced_source TEXT");
  ensureColumn(db, "experiences", "projects", "projects TEXT");
  ensureColumn(db, "experiences", "responsibilities_html", "responsibilities_html TEXT");
  ensureColumn(db, "experiences", "achievements_html", "achievements_html TEXT");
  ensureColumn(db, "experiences", "projects_html", "projects_html TEXT");
  ensureColumn(db, "experiences", "source_key", "source_key TEXT");
  ensureColumn(db, "experiences", "edited_at", "edited_at TEXT");
  ensureColumn(db, "experiences", "deleted_at", "deleted_at TEXT");
  // Autonomous recruitment records. Additive only: earlier vacancy and
  // application rows keep their NULLs and are never rewritten.
  ensureColumn(db, "jobs", "source_platform", "source_platform TEXT");
  ensureColumn(db, "jobs", "application_url", "application_url TEXT");
  ensureColumn(db, "jobs", "published_at", "published_at TEXT");
  ensureColumn(db, "jobs", "eligibility", "eligibility TEXT");
  ensureColumn(db, "jobs", "eligibility_notes", "eligibility_notes TEXT");
  // German is a hard exclusion at every proficiency level. Both the resolved
  // status and the quoted evidence are persisted so a restart cannot lose it.
  ensureColumn(db, "jobs", "german_requirement", "german_requirement TEXT");
  ensureColumn(db, "jobs", "language_evidence", "language_evidence TEXT");
  ensureColumn(db, "jobs", "eligibility_checked_at", "eligibility_checked_at TEXT");
  ensureColumn(db, "jobs", "qualified", "qualified INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "jobs", "run_id", "run_id TEXT");
  ensureColumn(db, "jobs", "dedupe_key", "dedupe_key TEXT");
  ensureColumn(db, "jobs", "company_domain", "company_domain TEXT");
  // Phase 2 central vacancy registry. Additive and nullable: historical rows
  // keep their values and are classified by the idempotent backfill below.
  ensureColumn(db, "jobs", "canonical_key", "canonical_key TEXT");
  ensureColumn(db, "jobs", "employer_key", "employer_key TEXT");
  ensureColumn(db, "jobs", "requisition_id", "requisition_id TEXT");
  ensureColumn(db, "jobs", "employer_url", "employer_url TEXT");
  ensureColumn(db, "jobs", "ats_vendor", "ats_vendor TEXT");
  ensureColumn(db, "jobs", "url_confidence", "url_confidence TEXT");
  // Evidence for how the employer application URL was obtained. The URL and
  // confidence alone cannot distinguish a redirect from an embedded apply link
  // or explain an unresolved aggregator listing.
  ensureColumn(db, "jobs", "url_provenance", "url_provenance TEXT");
  ensureColumn(db, "jobs", "qualification_status", "qualification_status TEXT");
  ensureColumn(db, "jobs", "duplicate_group", "duplicate_group TEXT");
  ensureColumn(db, "jobs", "first_verified_at", "first_verified_at TEXT");
  ensureColumn(db, "jobs", "last_verified_at", "last_verified_at TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe_key ON jobs(dedupe_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_canonical_key ON jobs(canonical_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_qualification ON jobs(qualification_status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_run ON jobs(run_id)");
  ensureColumn(db, "applications", "run_id", "run_id TEXT");
  ensureColumn(db, "applications", "submission_status", "submission_status TEXT");
  ensureColumn(db, "applications", "submission_evidence", "submission_evidence TEXT");
  ensureColumn(db, "applications", "confirmation_ref", "confirmation_ref TEXT");
  ensureColumn(db, "applications", "match_score_at_submit", "match_score_at_submit INTEGER");
  ensureColumn(db, "applications", "follow_up_at", "follow_up_at TEXT");
  ensureColumn(db, "applications", "interview_status", "interview_status TEXT");
  ensureColumn(db, "applications", "applied_channel", "applied_channel TEXT");
  // Phase 3: one active send per vacancy. A worker atomically inserts a
  // `submitting` attempt before any network call; the partial unique index makes
  // a concurrent second claim fail even when both workers passed the earlier
  // duplicate/readiness checks.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_attempts_active_claim ON submission_attempts(job_id) WHERE status = 'submitting'",
  );
  ensureColumn(db, "documents", "run_id", "run_id TEXT");
  ensureColumn(db, "documents", "master_cv_ref", "master_cv_ref TEXT");
  // Per-source discovery contribution and the run mode (full or discovery only).
  ensureColumn(db, "recruitment_runs", "source_metrics", "source_metrics TEXT");
  ensureColumn(db, "recruitment_runs", "mode", "mode TEXT");
  // Phase 5 execution reports: the exact warning/failure text is kept with the
  // run so the dashboard, manifest and email cannot disagree or lose detail.
  ensureColumn(db, "recruitment_runs", "warnings_json", "warnings_json TEXT");
  ensureColumn(db, "recruitment_runs", "failures_json", "failures_json TEXT");
  // Phase 1 source reliability: honest per-run aggregation. Existing runs keep
  // zero/NULL values rather than being backfilled from less precise data.
  ensureColumn(db, "recruitment_runs", "jobs_duplicates", "jobs_duplicates INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recruitment_runs", "jobs_filtered", "jobs_filtered INTEGER NOT NULL DEFAULT 0");
  // Incremental discovery is persisted on the run: the 10:00 occurrence is a
  // full pass; later two-hourly occurrences reconcile new and updated postings.
  ensureColumn(db, "recruitment_runs", "jobs_updated", "jobs_updated INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recruitment_runs", "discovery_scope", "discovery_scope TEXT NOT NULL DEFAULT 'full'");
  ensureColumn(db, "recruitment_runs", "discovery_since", "discovery_since TEXT");
  ensureColumn(db, "recruitment_runs", "sources_checked", "sources_checked INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recruitment_runs", "sources_succeeded", "sources_succeeded INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recruitment_runs", "sources_failed", "sources_failed INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recruitment_runs", "sources_partial", "sources_partial INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recruitment_runs", "discovery_state", "discovery_state TEXT");
  ensureColumn(db, "discovery_source_status", "error_category", "error_category TEXT");
  ensureColumn(db, "discovery_source_status", "status_code", "status_code INTEGER");
  ensureColumn(db, "discovery_source_status", "last_attempts", "last_attempts INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "discovery_source_status", "last_duration_ms", "last_duration_ms INTEGER NOT NULL DEFAULT 0");
  // Which durable run last exercised this connector, in addition to the last
  // success timestamp and the per-vacancy last-seen evidence on jobs.
  ensureColumn(db, "discovery_source_status", "last_run_id", "last_run_id TEXT");
  ensureColumn(db, "schedule_jobs", "last_checked_at", "last_checked_at TEXT");
  ensureColumn(db, "schedule_jobs", "weekdays", "weekdays TEXT");
  ensureColumn(db, "schedule_jobs", "last_scheduled_for", "last_scheduled_for TEXT");
  // Execution provenance per assigned agent. A step that only recorded a task is
  // distinguishable from one that actually called a model, and the serving
  // provider/model is stored beside it. Historical rows stay NULL (unknown).
  ensureColumn(db, "recruitment_run_agents", "execution_mode", "execution_mode TEXT");
  ensureColumn(db, "recruitment_run_agents", "provider", "provider TEXT");
  ensureColumn(db, "recruitment_run_agents", "model", "model TEXT");
  // Phase 2.4: deterministic vacancy classification and the pre-submission
  // readiness checklist are stored beside the vacancy/application they explain.
  ensureColumn(db, "jobs", "classification", "classification TEXT");
  ensureColumn(db, "jobs", "requirements", "requirements TEXT");
  ensureColumn(db, "applications", "readiness", "readiness TEXT");
  ensureColumn(db, "applications", "readiness_checked_at", "readiness_checked_at TEXT");
  // Phase 2.6: submissions that were prepared but deliberately not sent because
  // the standing policy is inactive, and the queue of essential questions that
  // need the owner's answer before a form can be completed.
  ensureColumn(db, "recruitment_runs", "applications_simulated", "applications_simulated INTEGER NOT NULL DEFAULT 0");
  // Phase 4: durable provider recovery, notification delivery and document
  // recovery. Additive columns only; older rows keep their unknown/NULL state.
  ensureColumn(db, "tasks", "state_reason", "state_reason TEXT");
  ensureColumn(db, "tasks", "next_retry_at", "next_retry_at TEXT");
  ensureColumn(db, "jobs", "document_state", "document_state TEXT");
  // A duplicate is evidence that an existing vacancy is still live. Record when
  // and from which source it was last seen without overwriting its origin.
  ensureColumn(db, "jobs", "last_seen_at", "last_seen_at TEXT");
  ensureColumn(db, "jobs", "last_seen_source", "last_seen_source TEXT");
  ensureColumn(db, "jobs", "source_updated_at", "source_updated_at TEXT");
  // Final vacancy verification is additive: existing jobs keep NULL/unknown
  // until a run re-reads the employer/listing page. No historical decision is
  // rewritten, and an absent expiry is stored as unknown rather than invented.
  ensureColumn(db, "jobs", "expiry_at", "expiry_at TEXT");
  ensureColumn(db, "jobs", "expiry_status", "expiry_status TEXT");
  ensureColumn(db, "jobs", "vacancy_status", "vacancy_status TEXT");
  ensureColumn(db, "jobs", "vacancy_verified_at", "vacancy_verified_at TEXT");
  ensureColumn(db, "jobs", "vacancy_verification", "vacancy_verification TEXT");
  ensureColumn(db, "notifications", "dedupe_key", "dedupe_key TEXT");
  ensureColumn(db, "notifications", "delivery_status", "delivery_status TEXT");
  ensureColumn(db, "notifications", "provider_message_id", "provider_message_id TEXT");
  ensureColumn(db, "notifications", "report_id", "report_id TEXT");
  // Branded HTML is stored beside the plain-text body so a failed delivery can
  // be retried without rebuilding the report from mutable data.
  ensureColumn(db, "notification_outbox", "html_body", "html_body TEXT");
  // Delivery evidence is additive and separate from the worker lifecycle. A
  // legacy row with delivery='accepted' remains Gmail API acceptance only; it is
  // never upgraded to inbox delivery by this migration.
  ensureColumn(db, "notification_outbox", "report_id", "report_id TEXT");
  ensureColumn(db, "notification_outbox", "sender", "sender TEXT");
  ensureColumn(db, "notification_outbox", "rfc_message_id", "rfc_message_id TEXT");
  ensureColumn(db, "notification_outbox", "gmail_response", "gmail_response TEXT");
  ensureColumn(db, "notification_outbox", "sent_observed_at", "sent_observed_at TEXT");
  ensureColumn(db, "notification_outbox", "sent_verification", "sent_verification TEXT");
  ensureColumn(db, "notification_outbox", "delivery_evidence", "delivery_evidence TEXT");
  ensureColumn(db, "notification_outbox", "bounce_info", "bounce_info TEXT");
  // A machine-readable reason separates a dead refresh grant from a transient
  // Google-side failure without parsing the human-readable last_error text.
  ensureColumn(db, "notification_outbox", "failure_code", "failure_code TEXT");
  ensureColumn(db, "notification_outbox", "resend_count", "resend_count INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_notification_outbox_report ON notification_outbox(report_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(status, next_retry_at)");
  // Phase 2 durable task contract. Every column is additive and nullable, so
  // historical rows retain their original values and remain readable. The
  // dependency list references existing task ids; no table is rebuilt.
  ensureColumn(db, "tasks", "run_id", "run_id TEXT");
  ensureColumn(db, "tasks", "task_type", "task_type TEXT");
  ensureColumn(db, "tasks", "depends_on", "depends_on TEXT");
  ensureColumn(db, "tasks", "input_refs", "input_refs TEXT");
  ensureColumn(db, "tasks", "output_refs", "output_refs TEXT");
  ensureColumn(db, "tasks", "heartbeat_at", "heartbeat_at TEXT");
  ensureColumn(db, "tasks", "retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "tasks", "error_class", "error_class TEXT");
  ensureColumn(db, "tasks", "recovery_state", "recovery_state TEXT");
  ensureColumn(db, "tasks", "idempotency_key", "idempotency_key TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_heartbeat ON tasks(status, heartbeat_at)");
  // Versioned, additive migrations ("schema_migrations"). Each runs once, in a
  // transaction, after a consistent backup of the database file.
  applyMigrations(db, { dataDir: DATA_DIR });
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * Legacy rows keep the link they already have. They are never linked to a task
 * by timestamp proximity or matching provider/model: that heuristic could turn
 * a conversational Coordinator call into a specialist's task execution. A row
 * with no persisted task id stays `legacy` (background) unless an explicit
 * source exists; unknown attribution is never fabricated.
 */
function backfillUsageAttribution(db: DatabaseSync): void {
  db.exec("UPDATE provider_usage SET source = 'legacy' WHERE source IS NULL AND task_id IS NULL");
  db.exec("UPDATE provider_usage SET source = 'task' WHERE source IS NULL AND task_id IS NOT NULL");
}

/**
 * Counters are a projection of task-bound usage rows. Recomputing them here
 * makes the roster reconcile with provider_usage instead of drifting from it.
 * Assistant/admin/manual calls are deliberately excluded: they are not task
 * executions and are shown separately in the admin view.
 */
function reconcileAgentAiCounters(db: DatabaseSync): void {
  db.exec(`
    UPDATE agents SET
      ai_success_count = (
        SELECT COUNT(*) FROM provider_usage u JOIN tasks t ON t.id = u.task_id AND t.agent_key = u.agent_key
        WHERE u.agent_key = agents.key AND u.source = 'task' AND u.status = 'ok'
      ),
      ai_failure_count = (
        SELECT COUNT(*) FROM provider_usage u JOIN tasks t ON t.id = u.task_id AND t.agent_key = u.agent_key
        WHERE u.agent_key = agents.key AND u.source = 'task' AND u.status = 'error'
      )
  `);
}

/** Data-only migrations. Runs once per process, after the schema is current. */
function migrateAgentIdentity(db: DatabaseSync) {
  // Display names and roles are derived from the immutable key. Historical
  // rows keep their agent_key, so task and execution relationships never move.
  const update = db.prepare("UPDATE agents SET name = ?, role = ? WHERE key = ?");
  for (const identity of Object.values(AGENT_IDENTITIES)) {
    update.run(identity.name, identity.role, identity.key);
  }
}

function migrate(db: DatabaseSync) {
  migrateAgentIdentity(db);
  backfillUsageAttribution(db);
  reconcileAgentAiCounters(db);
  // Keep the legacy generated advisory separate from deterministic scoring.
  const analysed = db.prepare("SELECT id, analysis FROM jobs WHERE analysis IS NOT NULL").all() as Array<{ id: string; analysis: string }>;
  for (const row of analysed) {
    try {
      const parsed = JSON.parse(row.analysis) as Record<string, unknown>;
      if (typeof parsed.aiNote === "string" && parsed.aiNote.trim()) {
        db.prepare("UPDATE jobs SET ai_note = ?, analysis = ? WHERE id = ?").run(
          parsed.aiNote,
          JSON.stringify({ ...parsed, aiNote: undefined }),
          row.id,
        );
      }
    } catch {
      // Preserve malformed historical analysis untouched.
    }
  }

  migrateAdminIdentity(db);
  migrateAutonomyDefaults(db);
  migrateStandingAuthorisationDefaults(db);
  migrateAutonomousSubmissionPolicy(db);
  migrateLegacyApprovalQueue(db);
  migrateWeeklyScheduleDefaults(db);
  backfillJobRegistry(db);
  enforceThresholdFloor(db);

  // Normalise legacy statuses written by earlier builds.
  db.exec("UPDATE agents SET status = 'working' WHERE status = 'running'");

  db.exec("UPDATE agents SET status = 'failed' WHERE status = 'error'");

  // Align the stored analysis weights with the requested scoring model, but only
  // when the legacy weights are still present so custom edits are preserved.
  const analysisAgent = db.prepare("SELECT config FROM agents WHERE key = 'analysis'").get() as { config?: string } | undefined;
  if (analysisAgent?.config?.includes('"industry"')) {
    try {
      const parsed = JSON.parse(analysisAgent.config) as Record<string, unknown>;
      parsed.weights = { technical: 35, experience: 25, seniority: 15, language: 10, location: 10, salary: 5 };
      db.prepare("UPDATE agents SET config = ? WHERE key = 'analysis'").run(JSON.stringify(parsed));
    } catch {}
  }
}

function seed(db: DatabaseSync) {
  const ts = nowIso();
  // Migrations may have inserted marker rows before seeding. Seed every
  // missing default individually; INSERT OR IGNORE never overwrites an existing
  // owner setting, and this still fills defaults on a fresh database.
  const stmt = db.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    stmt.run(key, JSON.stringify(value), ts);
  }

  const agentCount = db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number };
  if (!agentCount || agentCount.c === 0) {
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO agents (key, name, role, description, enabled, status, run_count, success_count, failure_count, config, sort) VALUES (?, ?, ?, ?, 1, 'idle', 0, 0, 0, ?, ?)",
    );
    AGENT_SEED.forEach((a, i) => stmt.run(a.key, a.name, a.role, a.description, JSON.stringify(a.config), i));
  }

  const sourceCount = db.prepare("SELECT COUNT(*) AS c FROM job_sources").get() as { c: number };
  if (!sourceCount || sourceCount.c === 0) {
    const stmt = db.prepare("INSERT OR IGNORE INTO job_sources (key, name, kind, url, enabled, notes) VALUES (?, ?, ?, ?, ?, ?)");
    stmt.run(
      "arbeitnow",
      "Arbeitnow job board",
      "api",
      "https://www.arbeitnow.com/api/job-board-api",
      1,
      "Free public feed (no API key). Attribution link required in the UI. Filters on QA titles and Switzerland / remote.",
    );
    stmt.run("manual", "Manual vacancy entry", "manual", null, 1, "Paste a vacancy URL and description from any Swiss job board or employer site.");
  }

  // Recruitment discovery sources. INSERT OR IGNORE keeps an existing, possibly
  // edited row (including a disabled state) exactly as it is.
  const sourceStmt = db.prepare("INSERT OR IGNORE INTO job_sources (key, name, kind, url, enabled, notes) VALUES (?, ?, ?, ?, ?, ?)");
  sourceStmt.run(
    "ashby",
    "Ashby-hosted job boards",
    "ashby",
    "https://api.ashbyhq.com/posting-api/job-board",
    1,
    "Public Ashby posting API (no key). Configure board slugs in Settings or ASHBY_JOB_BOARDS, e.g. acme,otherco.",
  );
  sourceStmt.run(
    "career_pages",
    "Employer career pages",
    "career_page",
    null,
    1,
    "Direct employer career pages with schema.org JobPosting data. Configure URLs in Settings or EMPLOYER_CAREER_PAGES.",
  );
  sourceStmt.run(
    "greenhouse",
    "Greenhouse-hosted job boards",
    "greenhouse",
    "https://boards-api.greenhouse.io/v1/boards",
    1,
    "Public Greenhouse job board API (no key). Configure board tokens in Settings or GREENHOUSE_BOARDS.",
  );
  sourceStmt.run(
    "lever",
    "Lever job boards",
    "lever",
    "https://api.lever.co/v0/postings",
    1,
    "Public Lever postings API (no key). Configure site names in Settings or LEVER_SITES.",
  );
  sourceStmt.run(
    "jobs_ch",
    "jobs.ch Swiss job board",
    "api",
    "https://www.jobs.ch/api/v1/public/search",
    1,
    "Verified public search JSON plus schema.org JobPosting detail (no key). Configure queries in JOBS_CH_QUERIES.",
  );

  const profile = db.prepare("SELECT id FROM profiles WHERE id = 1").get();
  if (!profile) {
    db.prepare(
      `INSERT INTO profiles (id, full_name, headline, email, phone, location, work_authorisation, permit_valid_until, summary, languages, preferences, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "Abubakar Towfiq",
      "Senior QA Engineer | Mobile (iOS/Android) | Test Automation | API & Payment Systems",
      null,
      null,
      "Switzerland",
      "Swiss Permit B — authorised to work in Switzerland without employer sponsorship",
      "2028-02",
      "Senior QA engineer with more than five years in software quality assurance, covering fintech and financial technology, mobile and web applications, API testing and test automation framework development. Experienced in QA leadership, test management and release readiness decisions.",
      JSON.stringify(["English"]),
      JSON.stringify({
        titles: [
          "Senior QA Engineer",
          "Senior QA Automation Engineer",
          "SDET",
          "QA Automation Engineer",
          "Lead QA Engineer",
          "QA Lead",
          "Test Lead",
          "Test Manager",
          "Senior Software Test Engineer",
        ],
        locations: ["Lausanne", "Geneva", "Zurich", "Bern", "Switzerland", "Remote"],
        min_salary: null,
        employment_types: ["Full-time"],
        remote_preference: "hybrid_or_remote",
        industries: ["Fintech", "Financial services", "Software"],
        languages: ["English"],
        german_required: "avoid",
        french: "evaluate",
      }),
      ts,
    );

    const skills: Array<[string, string, string]> = [
      ["Playwright", "Automation & testing", "working"],
      ["Cypress", "Automation & testing", "working"],
      ["Selenium", "Automation & testing", "working"],
      ["Appium", "Automation & testing", "working"],
      ["Espresso", "Automation & testing", "exposure"],
      ["XCUITest", "Automation & testing", "exposure"],
      ["REST Assured", "Automation & testing", "working"],
      ["Postman", "Automation & testing", "advanced"],
      ["Swagger", "Automation & testing", "working"],
      ["Manual & exploratory testing", "Automation & testing", "advanced"],
      ["Regression testing", "Automation & testing", "advanced"],
      ["Integration testing", "Automation & testing", "working"],
      ["End-to-end testing", "Automation & testing", "advanced"],
      ["Python", "Programming", "working"],
      ["JavaScript", "Programming", "working"],
      ["TypeScript", "Programming", "working"],
      ["Java", "Programming", "working"],
      ["SQL", "Programming", "working"],
      ["Jenkins", "DevOps & infrastructure", "working"],
      ["Azure DevOps", "DevOps & infrastructure", "working"],
      ["Docker", "DevOps & infrastructure", "working"],
      ["Git", "DevOps & infrastructure", "advanced"],
      ["CI/CD", "DevOps & infrastructure", "working"],
      ["JMeter", "Performance & monitoring", "working"],
      ["k6", "Performance & monitoring", "working"],
      ["Grafana", "Performance & monitoring", "working"],
      ["Jira", "QA management", "advanced"],
      ["Xray", "QA management", "working"],
      ["QA Touch", "QA management", "working"],
      ["Test planning", "QA management", "advanced"],
      ["Test strategy", "QA management", "advanced"],
      ["Defect management", "QA management", "advanced"],
      ["Test reporting", "QA management", "advanced"],
      ["Release readiness", "QA management", "advanced"],
      ["Go/No-Go assessments", "QA management", "advanced"],
    ];
    const skillStmt = db.prepare(
      "INSERT INTO skills (name, category, level, verified, source, sort) VALUES (?, ?, ?, 1, 'seed', ?)",
    );
    skills.forEach(([name, category, level], i) => skillStmt.run(name, category, level, i));

    const expStmt = db.prepare(
      "INSERT INTO experiences (company, title, is_current, summary, achievements, sort) VALUES (?, ?, 0, NULL, '[]', ?)",
    );
    expStmt.run("Cashia", "Lead QA Engineer", 0);
    expStmt.run("Nobilis", "QA Engineer / V&V Test Lead", 1);
    expStmt.run("Safaricom", "Junior Backend Developer", 2);
  }

  provisionFromEnv(db);
}

/**
 * Phase 2 changes the operating default from "approve every application" to
 * "submit qualifying applications". The change is applied once, guarded by a
 * marker, so an owner who later re-enables approval mode keeps that choice on
 * the next start. Values that were already customised are left untouched.
 */
function migrateAutonomyDefaults(db: DatabaseSync) {
  const marker = db.prepare("SELECT value FROM settings WHERE key = 'autonomy_defaults_v2'").get();
  if (marker) return;
  const read = (key: string): unknown => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined;
    if (!row?.value) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  };
  const write = (key: string, value: unknown) => {
    db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?").run(JSON.stringify(value), nowIso(), key);
  };
  // Never rewrite approval_mode or autonomous_submission here. Those are the
  // owner's safety switches; startup must not enable autonomous sending.
  if (read("min_match_score") === 60) write("min_match_score", 85);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('autonomy_defaults_v2', ?, ?)").run(
    JSON.stringify({ applied_at: nowIso(), version: 2 }),
    nowIso(),
  );
}

/**
 * Phase 2.6 defaults. The previous default cap was 5/day; a stored 5 is raised
 * or lowered to the new default 3 exactly once. A custom value (for example 4)
 * is preserved, so the owner's explicit choice is never silently overwritten.
 * Activation is inserted as NULL: defaults do not authorise real submissions.
 */
function migrateStandingAuthorisationDefaults(db: DatabaseSync) {
  const marker = db.prepare("SELECT value FROM settings WHERE key = 'autonomy_defaults_v3'").get();
  if (marker) return;
  const read = (key: string): unknown => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string } | undefined;
    if (!row?.value) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  };
  const write = (key: string, value: unknown) => {
    const exists = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key);
    if (exists) db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?").run(JSON.stringify(value), nowIso(), key);
    else db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), nowIso());
  };
  // The owner-authorised maximum is three verified submissions per day. Only a
  // missing value is created here; an older stored value is clamped at read time.
  if (read("max_applications_per_day") === undefined) write("max_applications_per_day", 3);
  // Never rewrite approval_mode or autonomous_submission here either.
  if (read("standing_authorisation_activated_at") === undefined) write("standing_authorisation_activated_at", null);
  if (read("authorised_answers") === undefined) write("authorised_answers", {});
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('autonomy_defaults_v3', ?, ?)").run(
    JSON.stringify({ applied_at: nowIso(), version: 3, activated: false }),
    nowIso(),
  );
}

/**
 * One-time move from per-application approval to automatic submission. This is
 * the policy the owner asked for. The marker ensures a later deliberate pause
 * (autonomous_submission=false) is preserved on subsequent starts; it is not
 * re-enabled by every migration.
 */
function migrateAutonomousSubmissionPolicy(db: DatabaseSync) {
  const marker = db.prepare("SELECT value FROM settings WHERE key = 'autonomy_defaults_v4'").get();
  if (marker) return;
  const write = (key: string, value: unknown) => {
    const exists = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key);
    if (exists) db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?").run(JSON.stringify(value), nowIso(), key);
    else db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), nowIso());
  };
  write("approval_mode", false);
  write("autonomous_submission", true);
  write("recruitment_dry_run", false);
  const activated = db.prepare("SELECT value FROM settings WHERE key = 'standing_authorisation_activated_at'").get() as { value?: string } | undefined;
  if (!activated?.value || activated.value === "null") write("standing_authorisation_activated_at", nowIso());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('autonomy_defaults_v4', ?, ?)").run(
    JSON.stringify({ applied_at: nowIso(), version: 4, perApplicationApproval: false }),
    nowIso(),
  );
}

/**
 * Retire the old per-application approval queue. A legacy awaiting_approval
 * package that already passed its readiness checklist is released to the
 * automatic queue; one without that evidence goes back to the quality check.
 * No application is marked submitted and no employer is contacted.
 */
function migrateLegacyApprovalQueue(db: DatabaseSync) {
  const marker = db.prepare("SELECT value FROM settings WHERE key = 'approval_queue_retired_v1'").get();
  if (marker) return;
  db.exec(`
    UPDATE applications
    SET status = 'ready_to_submit', approved_at = NULL, last_update = '${nowIso()}'
    WHERE status = 'awaiting_approval'
      AND readiness LIKE '%"state":"ready_for_submission"%'
  `);
  db.exec(`
    UPDATE applications
    SET status = 'quality_check', approved_at = NULL, last_update = '${nowIso()}'
    WHERE status = 'awaiting_approval'
  `);
  db.exec("UPDATE documents SET status = 'ready' WHERE status = 'awaiting_approval'");
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('approval_queue_retired_v1', ?, ?)").run(
    JSON.stringify({ applied_at: nowIso(), version: 1, perApplicationApproval: false }),
    nowIso(),
  );
}

/**
 * Initial schedule: one recruitment discovery per calendar day (Monday–Sunday)
 * at 12:00 Europe/Zurich, and the daily report at 16:00 Monday–Friday. Existing
 * custom times or weekday sets are preserved; only rows with no weekday list
 * are initialised.
 */
function migrateWeeklyScheduleDefaults(db: DatabaseSync) {
  const marker = db.prepare("SELECT value FROM settings WHERE key = 'schedule_defaults_v1'").get();
  if (marker) return;
  const update = db.prepare(
    "UPDATE schedule_jobs SET time = ?, timezone = ?, weekdays = ?, updated_at = ? WHERE key = ? AND (weekdays IS NULL OR weekdays = '')",
  );
  update.run("12:00", "Europe/Zurich", JSON.stringify([1, 2, 3, 4, 5, 6, 7]), nowIso(), "daily_recruitment");
  update.run("16:00", "Europe/Zurich", JSON.stringify([1, 2, 3, 4, 5]), nowIso(), "daily_executive_brief");
  // Legacy rows may already have a weekday value after this build; fix only the
  // known old clock defaults when the row still has no explicit weekday list.
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('schedule_defaults_v1', ?, ?)").run(
    JSON.stringify({ applied_at: nowIso(), version: 1, recruitmentTime: "12:00", reportTime: "16:00" }),
    nowIso(),
  );
}

/**
 * The stored threshold can never sit below the enforced floor. A value above
 * 85% is preserved; a legacy 80 (written before the floor existed) is raised.
 * This runs on every open and is idempotent.
 */
function enforceThresholdFloor(db: DatabaseSync) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'min_match_score'").get() as { value?: string } | undefined;
  if (!row?.value) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return;
  }
  const value = Number(parsed);
  if (!Number.isFinite(value) || value >= 85) return;
  db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'min_match_score'").run(JSON.stringify(85), nowIso());
}

/**
 * Move the existing administrator address once, without touching its password or
 * related records. The current password must then be replaced before the console
 * can be used. No default password is stored or re-asserted by the application.
 */
function migrateAdminIdentity(db: DatabaseSync) {
  const target = db
    .prepare("SELECT id, role FROM users WHERE lower(email) = ?")
    .get(ADMIN_EMAIL) as { id: string; role: string } | undefined;
  const legacy = db
    .prepare("SELECT id, role FROM users WHERE lower(email) = ?")
    .get(LEGACY_ADMIN_EMAIL) as { id: string; role: string } | undefined;

  if (target && target.role !== "admin") {
    throw new Error(`Administrator migration stopped: ${ADMIN_EMAIL} is already used by another account.`);
  }
  if (target && legacy && target.id !== legacy.id) {
    throw new Error(`Administrator migration stopped: both ${LEGACY_ADMIN_EMAIL} and ${ADMIN_EMAIL} exist.`);
  }
  if (target) return;
  if (!legacy || legacy.role !== "admin") return;

  db.prepare("UPDATE users SET email = ?, role = 'admin', status = 'active', must_change_password = 1 WHERE id = ?").run(
    ADMIN_EMAIL,
    legacy.id,
  );
}

/** Secure initial provisioning: only when the account does not already exist. */
function provisionFromEnv(db: DatabaseSync) {
  const pairs: Array<[string | undefined, string | undefined, string, "owner" | "admin"]> = [
    [process.env.OWNER_EMAIL, process.env.OWNER_PASSWORD, "Abubakar Towfiq", "owner"],
    [process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD, "Administrator", "admin"],
  ];
  for (const [email, password, name, role] of pairs) {
    if (!email || !password || password.length < 10) continue;
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase()) as { id?: string } | undefined;
    if (existing?.id) continue;
    const id = `u_${role}_${randomId()}`;
    db.prepare(
      "INSERT INTO users (id, email, password_hash, name, role, status, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 'active', 1, ?)",
    ).run(id, email.toLowerCase(), hashPassword(password), name, role, nowIso());
  }
}
