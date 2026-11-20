import { getDb, nowIso, one, run } from "./db";
import { hashPassword, passwordIssues, randomId } from "./security";
import { getSetting, setSetting } from "./settings";

export type InitialAccountsInput = {
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
  adminEmail: string;
  adminPassword: string;
};

export type InitialAccountsResult = { ok: true } | { ok: false; error: string };

/** Setup is closed by the existence of any account OR the permanent marker. */
export function setupClosed(): boolean {
  getDb();
  const users = one<{ c: number }>("SELECT COUNT(*) AS c FROM users")?.c ?? 0;
  if (users > 0) return true;
  return Boolean(getSetting<string | null>("setup_completed_at", null));
}

/**
 * Create the two initial accounts in one SQLite write transaction. The
 * BEGIN IMMEDIATE claim and the in-transaction closure check make concurrent
 * setup submissions serialize; only one can create accounts.
 */
export function initializeAccounts(input: InitialAccountsInput): InitialAccountsResult {
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  const adminEmail = input.adminEmail.trim().toLowerCase();
  const ownerName = input.ownerName.trim() || "Account owner";

  if (!ownerEmail.includes("@") || !adminEmail.includes("@")) {
    return { ok: false, error: "Enter valid owner and administrator email addresses." };
  }
  if (ownerEmail === adminEmail) {
    return { ok: false, error: "The owner and administrator must use different email addresses." };
  }
  const ownerIssue = passwordIssues(input.ownerPassword);
  if (ownerIssue) return { ok: false, error: `Owner password: ${ownerIssue}` };
  const adminIssue = passwordIssues(input.adminPassword);
  if (adminIssue) return { ok: false, error: `Administrator password: ${adminIssue}` };

  // Hash before taking the write lock so expensive scrypt work does not block
  // another request's transaction.
  const ownerHash = hashPassword(input.ownerPassword);
  const adminHash = hashPassword(input.adminPassword);
  const db = getDb();
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    if (setupClosed()) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { ok: false, error: "This system is already provisioned. Sign in instead." };
    }
    if (one("SELECT id FROM users WHERE lower(email) IN (?, ?)", [ownerEmail, adminEmail])) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { ok: false, error: "An account already uses one of those addresses." };
    }

    const ts = nowIso();
    run(
      "INSERT INTO users (id, email, password_hash, name, role, status, created_at) VALUES (?, ?, ?, ?, 'owner', 'active', ?)",
      [`u_${randomId()}`, ownerEmail, ownerHash, ownerName, ts],
    );
    run(
      "INSERT INTO users (id, email, password_hash, name, role, status, created_at) VALUES (?, ?, ?, ?, 'admin', 'active', ?)",
      [`u_${randomId()}`, adminEmail, adminHash, "Administrator", ts],
    );
    run("UPDATE profiles SET email = ? WHERE id = 1 AND email IS NULL", [ownerEmail]);
    setSetting("setup_completed_at", ts);
    db.exec("COMMIT");
    transactionOpen = false;
    return { ok: true };
  } catch {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure; no account is created without commit.
      }
    }
    return { ok: false, error: "First-run setup could not be completed. No accounts were created." };
  }
}
