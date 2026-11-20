import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { DiagnosticsBoot } from "@/components/DiagnosticsBoot";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";

export const metadata: Metadata = {
  title: "AT AI Workforce",
  description: "Multi-agent AI recruitment operations platform.",
  applicationName: "AT AI Workforce",
  manifest: "/manifest.webmanifest",
  formatDetection: { telephone: false, email: false, address: false },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "AT Workforce",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f6fa" },
    { media: "(prefers-color-scheme: dark)", color: "#070a10" },
  ],
};

const themeScript = `(function(){try{var t=localStorage.getItem('atw-theme');var d=t?t==='dark':true;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* These must not depend on React hydration. If a client chunk fails,
            the worker still registers and PWA installation remains possible.
            Manual scripts need the per-request nonce explicitly; strict-dynamic
            does not cover parser-inserted scripts. */}
        <script src="/pwa-bootstrap.js" defer nonce={nonce} />
        <DiagnosticsBoot nonce={nonce} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body suppressHydrationWarning>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
