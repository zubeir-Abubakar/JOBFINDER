import path from "node:path";
import { UPLOAD_DIR } from "./db";

export const AVATAR_DIR = path.join(UPLOAD_DIR, "avatars");
export const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

export function avatarUrlFor(user: { avatar_path: string | null; avatar_updated_at: string | null }): string | null {
  if (!user.avatar_path) return null;
  const version = user.avatar_updated_at ? Date.parse(user.avatar_updated_at) || 0 : 0;
  return `/api/account/avatar?v=${version}`;
}

export function detectAvatarType(bytes: Uint8Array): { mime: string; extension: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: ".jpg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: "image/png", extension: ".png" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: "image/webp", extension: ".webp" };
  }
  return null;
}
