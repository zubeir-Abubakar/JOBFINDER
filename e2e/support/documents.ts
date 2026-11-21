import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { E2E } from "./constants";
import { execute, one } from "./db";

/**
 * Synthetic documents used by the visual tests. The PDF fixture is generated
 * for E2E only and contains no real personal data. Both files are owned by the
 * synthetic owner account; a third document belongs to the admin account so the
 * account boundary can be verified.
 */
export function seedSyntheticDocuments(): { cvId: string; coverId: string; foreignId: string } {
  const owner = one<{ id: string }>("SELECT id FROM users WHERE email = ?", E2E.owner.email);
  const admin = one<{ id: string }>("SELECT id FROM users WHERE email = ?", E2E.admin.email);
  if (!owner?.id || !admin?.id) throw new Error("Synthetic accounts are not provisioned yet.");

  const uploads = path.join(process.cwd(), E2E.dataDir, "uploads");
  mkdirSync(uploads, { recursive: true });
  const fixture = path.join(process.cwd(), "e2e/fixtures/synthetic-cv.pdf");
  const cvId = "doc_e2e_synthetic_cv";
  const coverId = "doc_e2e_synthetic_cover";
  const foreignId = "doc_e2e_foreign_cv";

  const rows: Array<{ id: string; userId: string; kind: string; name: string }> = [
    { id: cvId, userId: owner.id, kind: "tailored_cv", name: "Synthetic Candidate · QA Engineer CV" },
    { id: coverId, userId: owner.id, kind: "cover_letter", name: "Synthetic Candidate · Cover Letter" },
    { id: foreignId, userId: admin.id, kind: "tailored_cv", name: "Administrator-only synthetic CV" },
  ];

  for (const row of rows) {
    copyFileSync(fixture, path.join(uploads, `${row.id}.pdf`));
    execute(
      `INSERT OR REPLACE INTO documents
         (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, version, created_at)
       VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, ?, 'draft', '1.0', ?)`,
      row.id,
      row.userId,
      row.kind,
      row.name,
      `${row.id}.pdf`,
      `${row.id}.pdf`,
      811,
      new Date().toISOString(),
    );
  }

  return { cvId, coverId, foreignId };
}
