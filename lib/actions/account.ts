"use server";

import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { nowIso, one, run } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { randomId } from "@/lib/security";
import { AVATAR_DIR, detectAvatarType, MAX_AVATAR_BYTES } from "@/lib/account";

function fail(message: string): never {
  redirect(`/settings?error=${encodeURIComponent(message)}#account`);
}

function saved(message: string): never {
  redirect(`/settings?saved=${encodeURIComponent(message)}#account`);
}

export async function updateAccountNameAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").replace(/\s+/g, " ").trim();
  if (!name) fail("Enter a name for your account.");
  if (name.length > 80) fail("Account names must be 80 characters or fewer.");

  run("UPDATE users SET name = ? WHERE id = ?", [name, user.id]);
  // Keep the CV/profile name aligned so generated documents and the workspace
  // do not show two different names.
  run("UPDATE profiles SET full_name = ?, updated_at = ? WHERE id = 1", [name, nowIso()]);
  audit({ action: "account.name_updated", entity: "user", entityId: user.id, detail: name, userId: user.id });
  revalidatePath("/", "layout");
  revalidatePath("/profile");
  revalidatePath("/settings");
  saved("Account name updated.");
}

export async function uploadAccountAvatarAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) fail("Choose a profile photo to upload.");
  if (file.size > MAX_AVATAR_BYTES) fail("Profile photos must be 3 MB or smaller.");

  const bytes = Buffer.from(await file.arrayBuffer());
  const type = detectAvatarType(bytes);
  if (!type) fail("Upload a JPEG, PNG or WebP image.");

  await mkdir(AVATAR_DIR, { recursive: true });
  const storedName = `avatar_${randomId()}${type.extension}`;
  await writeFile(path.join(AVATAR_DIR, storedName), bytes);

  const previous = one<{ avatar_path: string | null }>("SELECT avatar_path FROM users WHERE id = ?", [user.id]);
  run("UPDATE users SET avatar_path = ?, avatar_mime = ?, avatar_updated_at = ? WHERE id = ?", [
    storedName,
    type.mime,
    nowIso(),
    user.id,
  ]);
  if (previous?.avatar_path && previous.avatar_path !== storedName) {
    try {
      await unlink(path.join(AVATAR_DIR, path.basename(previous.avatar_path)));
    } catch {
      // A missing old file does not affect the new avatar.
    }
  }
  audit({
    action: "account.avatar_updated",
    entity: "user",
    entityId: user.id,
    detail: `${type.mime} (${Math.round(bytes.length / 1024)} KB)`,
    userId: user.id,
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings");
  saved("Profile photo updated.");
}

export async function removeAccountAvatarAction(): Promise<void> {
  const user = await requireUser();
  const previous = one<{ avatar_path: string | null }>("SELECT avatar_path FROM users WHERE id = ?", [user.id]);
  run("UPDATE users SET avatar_path = NULL, avatar_mime = NULL, avatar_updated_at = NULL WHERE id = ?", [user.id]);
  if (previous?.avatar_path) {
    try {
      await unlink(path.join(AVATAR_DIR, path.basename(previous.avatar_path)));
    } catch {
      // The database is authoritative; an orphaned file is harmless.
    }
  }
  audit({ action: "account.avatar_removed", entity: "user", entityId: user.id, userId: user.id });
  revalidatePath("/", "layout");
  revalidatePath("/settings");
  saved("Profile photo removed.");
}
