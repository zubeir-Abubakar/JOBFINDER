import { readFile } from "node:fs/promises";
import path from "node:path";
import { currentUser } from "@/lib/auth";
import { one } from "@/lib/db";
import { AVATAR_DIR } from "@/lib/account";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) return new Response("Unauthorised", { status: 401 });

  const row = one<{ avatar_path: string | null; avatar_mime: string | null }>(
    "SELECT avatar_path, avatar_mime FROM users WHERE id = ?",
    [user.id],
  );
  if (!row?.avatar_path) return new Response("Not found", { status: 404 });

  try {
    const bytes = await readFile(path.join(AVATAR_DIR, path.basename(row.avatar_path)));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": row.avatar_mime || "application/octet-stream",
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
