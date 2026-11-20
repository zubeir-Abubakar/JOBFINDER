/**
 * One CSP shared by the proxy and tests. Scripts are nonce-bound and
 * strict-dynamic in production; style attributes remain inline because the
 * existing UI uses React style props extensively.
 */
export function contentSecurityPolicy(nonce: string, options: { development?: boolean } = {}): string {
  const development = options.development ?? false;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "connect-src 'self' https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com https://*.googleapis.com",
    "frame-src 'self' https://accounts.google.com",
  ].join("; ");
}

export function newCspNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}
