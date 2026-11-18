import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { hashPassword, randomId } from "./security.ts";

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
  raw TEXT
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
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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
  source TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_chf REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_usage_created ON provider_usage(created_at);
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

export function getDb(): DatabaseSync {
  if (g.__atwDb) {
    if (!schemaReady) {
      ensureSchema(g.__atwDb);
      schemaReady = true;
    }
    return g.__atwDb;
  }
  mkdirSync(UPLOAD_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, "at-ai-workforce.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  ensureSchema(db);
  migrate(db);
  seed(db);
  g.__atwDb = db;
  schemaReady = true;
  return db;
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
  approval_mode: true,
  autonomous_submission: false,
  min_match_score: 60,
  max_applications_per_day: 5,
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
    name: "Chief Coordinator",
    role: "Orchestrator",
    description:
      "Owns every recruitment workflow: assigns work to specialist agents, tracks task progress, enforces your rules, retries recoverable failures and produces reports.",
    config: { max_retries: 2, priority: "balanced" },
  },
  {
    key: "research",
    name: "Job Research Agent",
    role: "Discovery",
    description:
      "Searches configured job sources for QA and test engineering vacancies in Switzerland or remote roles open to Swiss-based candidates, extracts descriptions and blocks duplicates.",
    config: { titles: ["Senior QA Engineer", "QA Automation Engineer", "SDET", "Test Lead"], locations: ["Lausanne", "Geneva", "Zurich", "Bern", "Remote"] },
  },
  {
    key: "analysis",
    name: "Job Analysis Agent",
    role: "Matching",
    description:
      "Reads each vacancy against the verified professional profile, scores the match across six weighted dimensions and explains gaps without auto-rejecting on preferred skills alone.",
    config: { weights: { technical: 35, experience: 25, seniority: 15, language: 10, location: 10, salary: 5 } },
  },
  {
    key: "cv",
    name: "CV Optimisation Agent",
    role: "Documents",
    description:
      "Tailors the CV to a vacancy using only verified facts from your master profile, reorders relevant skills and produces ATS-friendly PDF and DOCX files.",
    config: { formats: ["pdf", "docx"] },
  },
  {
    key: "ats",
    name: "ATS Quality Control Agent",
    role: "Assurance",
    description:
      "Audits generated documents for keyword coverage, formatting, section structure, contact details and unsupported claims before anything can be submitted.",
    config: { pass_threshold: 70, block_fabrication: true },
  },
  {
    key: "cover",
    name: "Cover Letter Agent",
    role: "Documents",
    description:
      "Writes vacancy-specific cover letters grounded in your real experience and work authorisation, producing PDF and DOCX files with no invented claims.",
    config: { formats: ["pdf", "docx"] },
  },
  {
    key: "application",
    name: "Application Agent",
    role: "Submission",
    description:
      "Prepares and submits applications through supported channels. Runs in approval mode by default, verifies eligibility and captures submission confirmations.",
    config: { mode: "approval", supported_channels: ["employer_portal_manual", "email"] },
  },
  {
    key: "email",
    name: "Email & Tracking Agent",
    role: "Tracking",
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
export const SCHEMA_VERSION = 7;

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
  ensureColumn(db, "email_messages", "ai_category", "ai_category TEXT");
  ensureColumn(db, "email_messages", "ai_classified_at", "ai_classified_at TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_provider_usage_task ON provider_usage(task_id)");
  ensureColumn(db, "users", "must_change_password", "must_change_password INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "users", "avatar_path", "avatar_path TEXT");
  ensureColumn(db, "users", "avatar_mime", "avatar_mime TEXT");
  ensureColumn(db, "users", "avatar_updated_at", "avatar_updated_at TEXT");
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
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * Links pre-v4 usage rows to the AI task that produced them when the match is
 * unambiguous (same agent, provider, model and a timestamp within five
 * minutes). Rows that cannot be matched are labelled `legacy` rather than
 * guessed into a task. No financial or task record is rewritten.
 */
function backfillUsageAttribution(db: DatabaseSync): void {
  const proximity = `ABS(
      CAST(strftime('%s', COALESCE(t.finished_at, t.started_at, t.created_at)) AS INTEGER)
      - CAST(strftime('%s', provider_usage.created_at) AS INTEGER)
    )`;
  db.exec(`
    UPDATE provider_usage
    SET task_id = (
      SELECT t.id FROM tasks t
      WHERE t.agent_key = provider_usage.agent_key
        AND t.provider = provider_usage.provider
        AND t.model = provider_usage.model
        AND t.execution_mode = 'ai'
        AND ${proximity} <= 300
      ORDER BY ${proximity} ASC
      LIMIT 1
    )
    WHERE task_id IS NULL
      AND EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.agent_key = provider_usage.agent_key
          AND t.provider = provider_usage.provider
          AND t.model = provider_usage.model
          AND t.execution_mode = 'ai'
          AND ${proximity} <= 300
      )
  `);
  db.exec("UPDATE provider_usage SET source = 'task' WHERE task_id IS NOT NULL AND source IS NULL");
  db.exec("UPDATE provider_usage SET source = 'legacy' WHERE source IS NULL");
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
        SELECT COUNT(*) FROM provider_usage u
        WHERE u.agent_key = agents.key AND u.source = 'task' AND u.status = 'ok'
      ),
      ai_failure_count = (
        SELECT COUNT(*) FROM provider_usage u
        WHERE u.agent_key = agents.key AND u.source = 'task' AND u.status = 'error'
      )
  `);
}

/** Data-only migrations. Runs once per process, after the schema is current. */
function migrate(db: DatabaseSync) {
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
  const settingCount = db.prepare("SELECT COUNT(*) AS c FROM settings").get() as { c: number };
  if (!settingCount || settingCount.c === 0) {
    const stmt = db.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      stmt.run(key, JSON.stringify(value), ts);
    }
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
