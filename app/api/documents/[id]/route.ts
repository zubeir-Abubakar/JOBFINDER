import { readFile } from "node:fs/promises";
import path from "node:path";
import { currentUser } from "@/lib/auth";
import { one, UPLOAD_DIR } from "@/lib/db";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorised", { status: 401 });
  const { id } = await context.params;
  const doc = one<{ relative_path: string; file_name: string; mime: string; user_id: string; deleted_at: string | null }>(
    "SELECT relative_path, file_name, mime, user_id, deleted_at FROM documents WHERE id = ?",
    [id],
  );
  if (!doc || doc.deleted_at) return new Response("Not found", { status: 404 });
  if (user.role !== "admin" && doc.user_id !== user.id) return new Response("Forbidden", { status: 403 });

  const safe = path.basename(doc.relative_path);
  try {
    const bytes = await readFile(path.join(UPLOAD_DIR, safe));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": doc.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("File is no longer available", { status: 410 });
  }
}
