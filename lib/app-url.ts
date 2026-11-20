/**
 * Returns the configured public application origin, or null when the value is
 * missing, malformed, loopback, link-local or a private-network address.
 *
 * Email links are opened on another device, so silently using
 * `https://localhost:3000` produces a link that cannot work. Callers should
 * omit the link and explain the configuration gap instead.
 */
export function publicAppBaseUrl(
  value: string | undefined = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_BASE_URL,
): string | null {
  const raw = (value ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return null;
  }
  return url.origin;
}
