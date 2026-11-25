import type { NextConfig } from "next";
import { hostname, networkInterfaces } from "node:os";

// CSP is per-request in proxy.ts so Next can nonce its inline bootstrap scripts.
// React development uses eval for Fast Refresh; the proxy permits it only in dev.
const hstsEnabled = process.env.NODE_ENV === "production" || process.env.ENABLE_HSTS === "true";

/**
 * Next 16 blocks dev-only assets and HMR from hosts other than the one the
 * server was started with. A phone opens the LAN IP, so without this list the
 * page renders but hydration never completes. Keep this dev-only: production
 * does not use the HMR endpoint and must not trust extra origins.
 */
function developmentOrigins(): string[] {
  const origins = new Set<string>(["localhost", "127.0.0.1"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) origins.add(entry.address);
    }
  }
  const host = hostname();
  if (host) {
    origins.add(host);
    origins.add(host.endsWith(".local") ? host : `${host}.local`);
  }
  return [...origins];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: developmentOrigins(),
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          ...(hstsEnabled
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/pwa-bootstrap.js",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
    ];
  },
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["mammoth", "unpdf", "pdf-lib", "docx", "playwright"],
  experimental: {
    serverActions: { bodySizeLimit: "12mb" },
    // Hydration must not wait for the dev-only React debug channel. When HMR is
    // unavailable (LAN origin, flaky phone socket, blocked WebSocket) the app
    // still hydrates and the service worker still registers.
    reactDebugChannel: false,
  },
};

export default nextConfig;
