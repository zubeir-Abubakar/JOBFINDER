import crypto from "node:crypto";
import { isLoopbackRequest } from "./request-context";

/** Loopback-only health access with an optional bearer token for monitors. */
export function healthRequestAuthorised(request: Request): boolean {
  if (process.env.HEALTH_PUBLIC === "true") return true;
  // Development/direct host checks may be local, but production requires a
  // token even on loopback so a public-port mistake cannot expose health.
  if (isLoopbackRequest(request.headers, { allowDirect: process.env.NODE_ENV !== "production" })) {
    return true;
  }

  const configured = process.env.HEALTHCHECK_TOKEN?.trim();
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!configured || !supplied) return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(configured);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
