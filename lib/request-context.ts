type HeaderBag = { get(name: string): string | null };

/**
 * Proxy headers are only trusted when the operator explicitly says the app is
 * behind a proxy that overwrites them. Without this contract any client can
 * claim to be localhost or another address.
 */
export function trustProxyHeaders(): boolean {
  return process.env.TRUST_PROXY === "true";
}

export function hasProxyHeaders(headers: HeaderBag): boolean {
  return Boolean(headers.get("x-real-ip") || headers.get("x-forwarded-for"));
}

export function isLoopbackAddress(value: string | null): boolean {
  if (!value) return false;
  const address = value.trim().toLowerCase();
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "localhost" ||
    address === "::ffff:127.0.0.1"
  );
}

export function isLoopbackHost(value: string | null): boolean {
  if (!value) return false;
  const host = value.trim().toLowerCase();
  if (host === "localhost" || host.startsWith("localhost:")) return true;
  if (host === "[::1]" || host.startsWith("[::1]:")) return true;
  if (/^127\.0\.0\.1(?::\d+)?$/.test(host)) return true;
  return false;
}

/**
 * Resolve the peer address without trusting spoofable headers by default.
 * X-Real-IP is preferred because the supplied nginx configuration overwrites
 * it. X-Forwarded-For is only used after TRUST_PROXY=true, and the last hop is
 * used so a client cannot prepend a fake first address.
 */
export function requestIpFromHeaders(headers: HeaderBag): string {
  if (!trustProxyHeaders()) return "direct";
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return forwarded?.at(-1) || "direct";
}

/**
 * A loopback-only endpoint may be reached directly on the host, where Next.js
 * does not add forwarding headers. The production systemd unit binds the app to
 * 127.0.0.1, so this direct path is local. Once any proxy header is present we
 * must not guess: only a trusted proxy may assert a loopback peer.
 */
export function isLoopbackRequest(headers: HeaderBag, options: { allowDirect?: boolean } = {}): boolean {
  const allowDirect = options.allowDirect ?? process.env.NODE_ENV !== "production";
  if (trustProxyHeaders()) {
    if (allowDirect && !hasProxyHeaders(headers) && isLoopbackHost(headers.get("host"))) {
      return true;
    }
    return isLoopbackAddress(requestIpFromHeaders(headers));
  }
  {
    if (allowDirect && isLoopbackHost(headers.get("host"))) {
      // Next may add a loopback forwarding header even for a direct request.
      // Accept it only when every forwarding value is itself loopback.
      const forwarded = headers
        .get("x-forwarded-for")
        ?.split(",")
        .map((part) => part.trim())
        .filter(Boolean) ?? [];
      const proxyValues = [headers.get("x-real-ip"), ...forwarded].filter(
        (value): value is string => Boolean(value),
      );
      if (proxyValues.every(isLoopbackAddress)) return true;
    }
    if (hasProxyHeaders(headers)) return false;
    return allowDirect;
  }
}
