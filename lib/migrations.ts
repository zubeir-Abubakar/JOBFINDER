import type { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Versioned, additive migrations.
 *
 * `ensureSchema` already creates the base tables idempotently; this ledger adds
 * the structural changes that cannot be expressed as a bare CREATE TABLE
 * without losing the ability to tell what has already run. Every migration is
 * idempotent, runs inside its own transaction, and is recorded only after it
 * commits. A database file is copied before the first pending migration so an
 * interrupted upgrade can be inspected or restored without data loss.
 */
export const MIGRATION_VERSION = 5;

type MigrationContext = { now: string; dataDir: string };
type Migration = {
  version: number;
  name: string;
  up: (db: DatabaseSync, context: MigrationContext) => void;
};

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function addColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** The database file behind this handle, or null for an in-memory database. */
function databaseFile(db: DatabaseSync): string | null {
  try {
    const rows = db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
    const main = rows.find((row) => row.name === "main");
    return main?.file ? main.file : null;
  } catch {
    return null;
  }
}

/**
 * A consistent point-in-time copy. `VACUUM INTO` is used when possible because
 * copying a WAL database file by path can omit committed frames; the plain
 * copy is only a fallback when the vacuum cannot run.
 */
function backupDatabase(db: DatabaseSync, dataDir: string, label: string): string | null {
  const source = databaseFile(db);
  if (!source || !existsSync(source)) return null;
  const dir = path.join(dataDir, "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `pre-migration-${label}-${stamp}.db`);
  try {
    db.prepare("VACUUM INTO ?").run(target);
    return target;
  } catch {
    try {
      copyFileSync(source, target);
      return target;
    } catch {
      return null;
    }
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "persistent_qualified_queue_and_submission_lifecycle",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS recruitment_queue (
          job_id TEXT PRIMARY KEY,
          canonical_key TEXT,
          origin_run_id TEXT,
          state TEXT NOT NULL,
          reason TEXT,
          destination_confidence TEXT,
          destination_url TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          entered_at TEXT NOT NULL,
          last_checked_at TEXT NOT NULL,
          next_check_at TEXT,
          lease_owner TEXT,
          lease_expires_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recruitment_queue_state ON recruitment_queue(state, next_check_at);
        CREATE INDEX IF NOT EXISTS idx_recruitment_queue_lease ON recruitment_queue(lease_expires_at);
        CREATE TABLE IF NOT EXISTS recruitment_queue_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          from_state TEXT,
          to_state TEXT NOT NULL,
          reason TEXT,
          actor TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recruitment_queue_events_job ON recruitment_queue_events(job_id, created_at);
      `);

      // Explicit submission lifecycle, kept beside the legacy status so that
      // existing workflows and reports keep working. Historical rows are
      // classified from the evidence they already carry; nothing is invented.
      addColumn(db, "applications", "submission_state", "submission_state TEXT");
      addColumn(db, "applications", "block_signature", "block_signature TEXT");
      addColumn(db, "applications", "blocked_at", "blocked_at TEXT");
      addColumn(db, "applications", "last_block_reason", "last_block_reason TEXT");
      addColumn(db, "applications", "retry_count", "retry_count INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "applications", "last_retry_at", "last_retry_at TEXT");
      addColumn(db, "applications", "next_retry_at", "next_retry_at TEXT");

      db.exec(`
        UPDATE applications SET submission_state = CASE
          WHEN submission_status = 'verified' OR status IN ('submitted','acknowledged','interview_invited','interview_completed','offer_received') THEN 'submitted_reference'
          WHEN submission_status = 'blocked' AND submission_evidence LIKE '%security_challenge%' THEN 'blocked_security'
          WHEN submission_status = 'blocked' AND (
            submission_evidence LIKE '%unresolved%' OR
            submission_evidence LIKE '%aggregator%' OR
            submission_evidence LIKE '%No application URL%'
          ) THEN 'waiting_destination'
          WHEN submission_status = 'blocked' THEN 'blocked_technical'
          WHEN submission_status = 'unverified' OR status = 'submission_unverified' THEN 'blocked_technical'
          WHEN status IN ('ready_to_submit','awaiting_approval') THEN 'ready_for_submission'
          WHEN status = 'quality_check' THEN 'package_ready'
          WHEN status IN ('human_intervention_required','quality_review_required') THEN 'awaiting_human'
          WHEN status IN ('rejected','rejected_by_employer','closed','withdrawn') THEN 'ineligible_closed'
          ELSE NULL
        END
        WHERE submission_state IS NULL;
      `);
    },
  },
  {
    version: 2,
    name: "verified_employer_email_destination",
    up(db) {
      // Some employers accept applications only by email. The address is kept
      // separately from application_url because there is no web form to load;
      // it is a verified human handoff, never an automatic send.
      addColumn(db, "jobs", "application_email", "application_email TEXT");
      addColumn(db, "jobs", "application_email_source", "application_email_source TEXT");
      addColumn(db, "jobs", "application_email_verified_at", "application_email_verified_at TEXT");
    },
  },
  {
    version: 3,
    name: "owner_email_handoff_receipt",
    up(db) {
      // Owner-attested email sending is not employer confirmation. It is kept
      // as its own receipt (timestamp + note) next to the normal lifecycle.
      addColumn(db, "applications", "email_handoff_sent_at", "email_handoff_sent_at TEXT");
      addColumn(db, "applications", "email_handoff_note", "email_handoff_note TEXT");
    },
  },
  {
    version: 4,
    name: "submission_claim_evidence_and_reconciliation",
    up(db) {
      // Phase 3 records the irreversible send before it happens: an idempotency
      // key, the destination known at claim time, the start time, and the later
      // reconciliation outcome. Historical attempts keep NULL provenance rather
      // than being relabelled as if they had carried these fields.
      addColumn(db, "submission_attempts", "idempotency_key", "idempotency_key TEXT");
      addColumn(db, "submission_attempts", "destination", "destination TEXT");
      addColumn(db, "submission_attempts", "started_at", "started_at TEXT");
      addColumn(db, "submission_attempts", "reconciliation_state", "reconciliation_state TEXT");
      addColumn(db, "submission_attempts", "reconciliation_evidence", "reconciliation_evidence TEXT");
      addColumn(db, "submission_attempts", "reconciled_at", "reconciled_at TEXT");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_attempts_idempotency ON submission_attempts(idempotency_key) WHERE idempotency_key IS NOT NULL",
      );
      // The attempt timestamp is factual evidence of when the claim began; it is
      // copied into the new start-time column only where that is exact.
      db.exec("UPDATE submission_attempts SET started_at = attempted_at WHERE started_at IS NULL");
    },
  },
  {
    version: 5,
    name: "verified_outreach_contacts_and_gmail_drafts",
    up(db) {
      // Contact evidence is stored separately from the vacancy. A contact is
      // only usable for outreach when its address was explicitly published or
      // observed in real correspondence; naming-pattern guesses are never
      // persisted as verified.
      db.exec(`
        CREATE TABLE IF NOT EXISTS outreach_contacts (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          name TEXT NOT NULL,
          title TEXT,
          company TEXT NOT NULL,
          email TEXT,
          email_domain TEXT,
          source_url TEXT,
          source_kind TEXT NOT NULL,
          discovery_method TEXT NOT NULL,
          evidence TEXT NOT NULL,
          confidence INTEGER NOT NULL DEFAULT 0,
          priority INTEGER NOT NULL DEFAULT 9,
          verification_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_contacts_job_email
          ON outreach_contacts(job_id, email) WHERE email IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_outreach_contacts_job
          ON outreach_contacts(job_id, verification_status, priority);

        CREATE TABLE IF NOT EXISTS outreach_drafts (
          id TEXT PRIMARY KEY,
          application_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          contact_id TEXT NOT NULL,
          recipient TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          cv_document_id TEXT NOT NULL,
          cover_document_id TEXT NOT NULL,
          cv_sha256 TEXT NOT NULL,
          cover_sha256 TEXT NOT NULL,
          attachment_manifest TEXT NOT NULL,
          gmail_draft_id TEXT,
          gmail_message_id TEXT,
          gmail_thread_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          error TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sent_at TEXT,
          last_reconciled_at TEXT,
          UNIQUE(application_id, contact_id)
        );
        CREATE INDEX IF NOT EXISTS idx_outreach_drafts_job
          ON outreach_drafts(job_id, status);
        CREATE INDEX IF NOT EXISTS idx_outreach_drafts_contact
          ON outreach_drafts(contact_id, status);

        CREATE TABLE IF NOT EXISTS outreach_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          draft_id TEXT NOT NULL,
          contact_id TEXT NOT NULL,
          type TEXT NOT NULL,
          message TEXT,
          meta TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_outreach_events_draft
          ON outreach_events(draft_id, created_at);
      `);
    },
  },
];

export type MigrationResult = {
  applied: number[];
  backupPath: string | null;
  version: number;
  pendingBefore: number;
};

/** Applies every migration not yet recorded. Safe to call on every open. */
export function applyMigrations(
  db: DatabaseSync,
  options: { dataDir: string; now?: Date } = { dataDir: path.join(process.cwd(), "data") },
): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version),
  );
  const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version)).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) {
    const current = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as
      | { v: number }
      | undefined;
    return { applied: [], backupPath: null, version: current?.v ?? 0, pendingBefore: 0 };
  }

  const backupPath = backupDatabase(db, options.dataDir, `v${pending[0].version}`);
  const now = (options.now ?? new Date()).toISOString();
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  const done: number[] = [];
  for (const migration of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db, { now, dataDir: options.dataDir });
      record.run(migration.version, migration.name, now);
      db.exec("COMMIT");
      done.push(migration.version);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    }
  }
  return { applied: done, backupPath, version: done.at(-1) ?? MIGRATION_VERSION, pendingBefore: pending.length };
}

export function migrationStatus(db: DatabaseSync): { version: number; applied: Array<{ version: number; name: string; applied_at: string }> } {
  try {
    const rows = db
      .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string; applied_at: string }>;
    return { version: rows.at(-1)?.version ?? 0, applied: rows };
  } catch {
    return { version: 0, applied: [] };
  }
}
