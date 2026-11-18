"use server";

import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, nowIso, one, run, UPLOAD_DIR } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { randomId, sha256 } from "@/lib/security";
import { extractFields, extractText } from "@/lib/extract";
import { getSetting, setSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { generateApplicationPackage } from "@/lib/agents";

const MAX_BYTES = 8 * 1024 * 1024;

export type UploadState = { error?: string; ok?: string };

export async function uploadCvAction(_prev: UploadState | undefined, formData: FormData): Promise<UploadState> {
  const user = await requireUser();
  const file = formData.get("cv");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a PDF, DOCX or TXT file to upload." };
  if (file.size > MAX_BYTES) return { error: "File is larger than 8 MB." };
  const name = file.name.replace(/[^\w.\- ]/g, "_").slice(-140);
  const lower = name.toLowerCase();
  const allowed =
    lower.endsWith(".pdf") ||
    lower.endsWith(".docx") ||
    lower.endsWith(".txt") ||
    file.type === "application/pdf" ||
    file.type === "text/plain" ||
    file.type.includes("wordprocessingml");
  if (!allowed) return { error: "Unsupported file type. Upload PDF, DOCX or TXT." };

  const buffer = Buffer.from(await file.arrayBuffer());
  let text = "";
  try {
    text = await extractText(buffer, file.type, name);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The document text could not be extracted." };
  }
  if (text.trim().length < 40) return { error: "Almost no text could be extracted. If the CV is a scan, export a text-based PDF first." };

  const id = `doc_${randomId()}`;
  const storedName = `${id}${path.extname(name).toLowerCase() || ".pdf"}`;
  await writeFile(path.join(UPLOAD_DIR, storedName), buffer);

  run(
    `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, sha256, version, status, text_content, created_at)
     VALUES (?, ?, 'original_cv', ?, ?, ?, ?, ?, ?, 'original', 'active', ?, ?)`,
    [
      id,
      user.id,
      `Original CV · ${name}`,
      name,
      file.type || "application/octet-stream",
      storedName,
      buffer.length,
      sha256(text),
      text,
      nowIso(),
    ],
  );
  run("UPDATE documents SET status = 'replaced' WHERE kind = 'original_cv' AND id != ? AND user_id = ? AND status = 'active'", [id, user.id]);
  run("UPDATE profiles SET source_cv_id = ?, updated_at = ? WHERE id = 1", [id, nowIso()]);

  const fields = extractFields(text);
  setSetting("pending_cv_extraction", {
    documentId: id,
    fileName: name,
    fields,
    preview: text.slice(0, 4000),
    extractedAt: nowIso(),
  });

  audit({
    action: "document.uploaded",
    entity: "document",
    entityId: id,
    detail: `Original CV uploaded (${Math.round(buffer.length / 1024)} KB)`,
    userId: user.id,
  });
  revalidatePath("/documents");
  revalidatePath("/profile");
  return { ok: "CV uploaded and parsed. Review the extracted information before it is applied." };
}

export async function applyExtractionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const pending = getSetting<{ documentId: string; fields: Record<string, unknown> } | null>("pending_cv_extraction", null);
  if (!pending) redirect("/documents?error=No+extraction+to+review");

  const includeName = formData.get("include_name") === "on";
  const includeEmail = formData.get("include_email") === "on";
  const includePhone = formData.get("include_phone") === "on";
  const includeLinkedin = formData.get("include_linkedin") === "on";
  const includeSkills = formData.get("include_skills") === "on";
  const fields = pending.fields as { name?: string; email?: string; phone?: string; linkedin?: string; skills?: string[] };

  if (includeName && fields.name) run("UPDATE profiles SET full_name = ? WHERE id = 1", [fields.name]);
  if (includeEmail && fields.email) run("UPDATE profiles SET email = ? WHERE id = 1", [fields.email]);
  if (includePhone && fields.phone) run("UPDATE profiles SET phone = ? WHERE id = 1", [fields.phone]);
  if (includeLinkedin && fields.linkedin) run("UPDATE profiles SET linkedin = ? WHERE id = 1", [fields.linkedin]);

  let added = 0;
  if (includeSkills && Array.isArray(fields.skills)) {
    const existing = new Map(all<{ id: number; name: string; source: string; deleted_at: string | null }>("SELECT id, name, source, deleted_at FROM skills").map((s) => [s.name.toLowerCase(), s]));
    for (const skill of fields.skills) {
      const previous = existing.get(skill.toLowerCase());
      if (previous && previous.source !== "seed") {
        if (previous.deleted_at) {
          run("UPDATE skills SET deleted_at = NULL, verified = 1, source = 'cv' WHERE id = ?", [previous.id]);
          added += 1;
        }
        continue;
      }
      if (previous) {
        run("UPDATE skills SET category = 'From CV', level = 'unspecified', verified = 1, source = 'cv', deleted_at = NULL WHERE id = ?", [previous.id]);
        added += 1;
        continue;
      }
      run(
        "INSERT INTO skills (name, category, level, verified, source, sort) VALUES (?, 'From CV', 'unspecified', 1, 'cv', (SELECT COALESCE(MAX(sort),0)+1 FROM skills))",
        [skill],
      );
      added += 1;
    }
  }
  run("UPDATE profiles SET source_cv_id = ?, updated_at = ? WHERE id = 1", [pending.documentId, nowIso()]);
  setSetting("pending_cv_extraction", null);
  audit({ action: "profile.cv_extraction_applied", entity: "document", entityId: pending.documentId, detail: `${added} skills imported`, userId: user.id });
  revalidatePath("/profile");
  revalidatePath("/documents");
  redirect(`/profile?saved=1&imported=${added}`);
}

export async function discardExtractionAction(): Promise<void> {
  await requireUser();
  setSetting("pending_cv_extraction", null);
  revalidatePath("/documents");
  redirect("/documents?discarded=1");
}

export async function deleteDocumentAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const doc = one<{ id: string; relative_path: string; kind: string; pinned: number }>(
    "SELECT id, relative_path, kind, pinned FROM documents WHERE id = ? AND user_id = ?",
    [id, user.id],
  );
  if (!doc) redirect("/documents?error=Document+not+found");
  try {
    await unlink(path.join(UPLOAD_DIR, path.basename(doc.relative_path)));
  } catch {}
  run("UPDATE documents SET deleted_at = ? WHERE id = ?", [nowIso(), id]);
  if (doc.kind === "original_cv") {
    run("UPDATE profiles SET source_cv_id = NULL WHERE id = 1 AND source_cv_id = ?", [id]);
  }
  audit({ action: "document.deleted", entity: "document", entityId: id, detail: `${doc.kind} deleted manually`, userId: user.id });
  revalidatePath("/documents");
  redirect("/documents?deleted=1");
}

export async function togglePinAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const current = one<{ pinned: number }>("SELECT pinned FROM documents WHERE id = ? AND user_id = ?", [id, user.id]);
  if (!current) redirect("/documents?error=Document+not+found");
  run("UPDATE documents SET pinned = ? WHERE id = ?", [current.pinned ? 0 : 1, id]);
  audit({ action: "document.pin_toggled", entity: "document", entityId: id, detail: current.pinned ? "Unpinned" : "Pinned", userId: user.id });
  revalidatePath("/documents");
  redirect("/documents?saved=1");
}

export async function generatePackageAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const jobId = String(formData.get("job_id") ?? "");
  const outcome = await generateApplicationPackage(user.id, jobId);
  revalidatePath("/documents");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/applications");
  const message = encodeURIComponent(outcome.message);
  redirect(`/jobs/${jobId}?${outcome.ok ? "ok" : "error"}=${message}`);
}
