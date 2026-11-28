/**
 * Applies the versioned schema migrations and prints the resulting ledger.
 *
 * Usage:
 *   npx tsx scripts/apply-migrations.ts            # live data directory
 *   DATA_DIR=/path/to/copy npx tsx scripts/apply-migrations.ts
 *
 * A consistent backup is written to <DATA_DIR>/backups before the first
 * pending migration. Existing records are preserved; no table is dropped.
 */
import { closeDb, DATA_DIR, SCHEMA_VERSION, getDb } from "../lib/db.ts";
import { migrationStatus } from "../lib/migrations.ts";
import {
  pipelineReconciliation,
  queueSnapshot,
  requeueBlockedApplications,
  syncQualifiedQueue,
} from "../lib/recruitment-queue.ts";

const db = getDb();
const status = migrationStatus(db);
// Populate the persistent backlog from existing qualified vacancies and apply
// the safe retry rules. This never generates documents or submits anything.
const requeue = requeueBlockedApplications({ runId: null });
const synced = syncQualifiedQueue({ actor: "migration" });
console.log(
  JSON.stringify(
    {
      dataDir: DATA_DIR,
      schemaVersion: SCHEMA_VERSION,
      migrationVersion: status.version,
      applied: status.applied,
      requeue,
      synced,
      counts: pipelineReconciliation().counts,
      queue: queueSnapshot(20),
    },
    null,
    2,
  ),
);
closeDb();
