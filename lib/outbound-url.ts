import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.oraclecloud.com",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

export function privateIpv6(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("::ffff:")) return privateIpv4(value.slice(7));
  if (value.startsWith("fc") || value.startsWith("fd")) return true; // unique local
  if (/^fe[89ab]/.test(value)) return true; // link local
  if (value.startsWith("ff")) return true; // multicast
  if (value.startsWith("2001:db8")) return true; // documentation
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** True only for a globally routable IP literal. */
export function isPublicAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family === 4) return !privateIpv4(host);
  if (family === 6) return !privateIpv6(host);
  return false;
}

/**
 * Validate an outbound URL before a server-side fetch. This blocks URL-level
 * SSRF to loopback, link-local metadata and private networks. It deliberately
 * does not perform DNS resolution here: production DNS can change between the
 * check and the request, so redirects must also be re-validated by callers.
 *
 * Local fixtures are allowed in non-production and can be explicitly enabled
 * with OUTBOUND_ALLOW_PRIVATE=true. Production defaults to public-only.
 */
export function assertPublicHttpUrl(
  raw: string,
  options: { allowPrivate?: boolean } = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The outbound URL is not a valid absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) outbound URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new Error("Outbound URLs must not contain embedded credentials.");
  }

  const allowPrivate =
    options.allowPrivate ??
    (process.env.NODE_ENV !== "production" || process.env.OUTBOUND_ALLOW_PRIVATE === "true");
  if (allowPrivate) return url;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) {
    throw new Error("The outbound URL points to a blocked local host.");
  }
  if (isIP(host) && !isPublicAddress(host)) {
    throw new Error("The outbound URL points to a private or link-local address.");
  }
  return url;
}
