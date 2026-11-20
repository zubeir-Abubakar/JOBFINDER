import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import manifest from "../app/manifest.ts";

const root = process.cwd();

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file} is a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("PWA manifest uses the AT Workforce name, standalone mode and both orientations", () => {
  const pwa = manifest();
  assert.equal(pwa.name, "AT AI Workforce");
  assert.equal(pwa.short_name, "AT Workforce");
  assert.equal(pwa.display, "standalone");
  assert.equal(pwa.orientation, "any");
  assert.equal(pwa.start_url, "/dashboard");
  assert.equal(pwa.scope, "/");
  assert.equal(pwa.background_color, "#070a10");
  assert.equal(pwa.theme_color, "#070a10");
  assert.deepEqual(
    pwa.icons?.map((icon) => [icon.src, icon.sizes, icon.purpose]),
    [
      ["/icons/icon-192.png", "192x192", "any"],
      ["/icons/icon-512.png", "512x512", "any"],
      ["/icons/maskable-512.png", "512x512", "maskable"],
    ],
  );
});

test("home-screen icons are correctly sized from the official logo assets", () => {
  assert.deepEqual(pngSize(join(root, "public/icons/icon-192.png")), { width: 192, height: 192 });
  assert.deepEqual(pngSize(join(root, "public/icons/icon-512.png")), { width: 512, height: 512 });
  assert.deepEqual(pngSize(join(root, "public/icons/maskable-512.png")), { width: 512, height: 512 });
  assert.deepEqual(pngSize(join(root, "public/icons/apple-touch-icon.png")), { width: 180, height: 180 });
});

test("service worker never caches private workspace routes or API responses", () => {
  const worker = readFileSync(join(root, "public/sw.js"), "utf8");
  assert.match(worker, /const CACHE = "atw-shell-v6"/);
  assert.match(worker, /Promise\.allSettled\(SHELL\.map/);
  assert.match(worker, /url\.pathname === "\/manifest\.webmanifest"/);
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  for (const route of ["/admin", "/login", "/setup", "/change-password", "/documents", "/applications", "/inbox"]) {
    assert.match(worker, new RegExp(`url\\.pathname\\.startsWith\\("${route.replace("/", "\\/")}"\\)`));
  }
  assert.match(worker, /caches\.match\("\/offline"\)/);
  // Network-first chunks avoid pinning a stale Turbopack/Next bundle.
  assert.match(worker, /const response = await fetch\(request\)/);
  assert.match(worker, /const cached = await cache\.match\(request\)/);
  assert.match(worker, /response\.ok && response\.type === "basic"/);
});

test("service worker registration is independent of React hydration", () => {
  const bootstrap = readFileSync(join(root, "public/pwa-bootstrap.js"), "utf8");
  assert.match(bootstrap, /navigator\.serviceWorker\.register\("\/sw\.js"/);
  assert.match(bootstrap, /scope: "\/"/);
  assert.match(bootstrap, /updateViaCache: "none"/);
  assert.match(bootstrap, /sw-register-error/);
  assert.match(bootstrap, /console\.error\("\[PWA\] Service worker registration failed"/);
  const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
  assert.match(layout, /src="\/pwa-bootstrap\.js" defer nonce=\{nonce\}/);
  assert.match(layout, /<DiagnosticsBoot nonce=\{nonce\}/);
  assert.match(layout, /<script nonce=\{nonce\} dangerouslySetInnerHTML/);
  const registrar = readFileSync(join(root, "components/ServiceWorkerRegistrar.tsx"), "utf8");
  assert.match(registrar, /dataset\.atwHydrated = "true"/);
  assert.doesNotMatch(registrar, /serviceWorker\.register\(/);
});

test("dev hydration does not depend on the cross-origin HMR channel", () => {
  const config = readFileSync(join(root, "next.config.ts"), "utf8");
  assert.match(config, /allowedDevOrigins: developmentOrigins\(\)/);
  assert.match(config, /networkInterfaces\(\)/);
  assert.match(config, /reactDebugChannel: false/);
  assert.match(config, /source: "\/sw\.js"/);
  assert.match(config, /Service-Worker-Allowed/);
});

test("HTTPS development setup keeps certificates out of git and registers on every HTTPS origin", () => {
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.match(ignore, /^certs\/$/m);
  const bootstrap = readFileSync(join(root, "public/pwa-bootstrap.js"), "utf8");
  assert.doesNotMatch(bootstrap, /NEXT_PUBLIC_PWA_DEV/);
  assert.match(bootstrap, /window\.isSecureContext/);
  assert.match(bootstrap, /window\.location\.protocol !== "https:"/);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["dev:https"], "node scripts/dev-https.mjs");
  assert.equal(pkg.scripts["dev:https:cert"], "node scripts/dev-https.mjs --cert-only");
});

test("development certificate generation covers localhost, loopback, hostname and LAN and validates the CA signature", () => {
  const script = readFileSync(join(root, "scripts/dev-https.mjs"), "utf8");
  assert.match(script, /new X509Certificate/);
  assert.match(script, /checkHost\(name\)/);
  assert.match(script, /checkIP\(ip\)/);
  assert.match(script, /certificate\.checkIssued\(authority\)/);
  assert.match(script, /certificate\.verify\(authority\.publicKey\)/);
  assert.match(script, /localhost/);
  assert.match(script, /127\.0\.0\.1/);
  assert.match(script, /networkInterfaces\(\)/);
  assert.match(script, /subjectAltName=@alt_names/);
  assert.match(script, /reportMacTrust/);
  assert.match(script, /security",\s*\[\s*"verify-cert"/);
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.match(readme, /security add-trusted-cert -r trustRoot -k "\$HOME\/Library\/Keychains\/login\.keychain-db" certs\/local-ca\.crt/);
  assert.ok(readme.includes("Never copy"));
  assert.ok(readme.includes("certs/local-ca.key"));
  assert.ok(readme.includes("certs/local.key"));
});

test("development CSP permits React eval while production keeps unsafe-eval out", () => {
  const source = readFileSync(join(root, "lib/csp.ts"), "utf8");
  assert.match(source, /development \? " 'unsafe-eval'" : ""/);
  assert.match(source, /'nonce-\$\{nonce\}' 'strict-dynamic'/);
});

test("diagnostics runtime loads before hydration and is independent of React", () => {
  const boot = readFileSync(join(root, "components/DiagnosticsBoot.tsx"), "utf8");
  assert.match(boot, /from "next\/script"/);
  assert.match(boot, /strategy="beforeInteractive"/);
  assert.match(boot, /\/diagnostics\.js\?v=1/);
  assert.match(boot, /nonce=\{nonce\}/);
  const runtime = readFileSync(join(root, "public/diagnostics.js"), "utf8");
  assert.match(runtime, /function initPage\(\)/);
  assert.match(runtime, /atw\.diag/);
  assert.match(runtime, /beforeinstallprompt/);
  assert.match(runtime, /atwHydrated/);
  assert.match(runtime, /hydration-timeout/);
  assert.match(runtime, /sw-register-error/);
  assert.match(runtime, /addEventListener\("error", function \(event\) \{[\s\S]*?\}, true\);/);
});
