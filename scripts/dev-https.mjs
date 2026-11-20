import { spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";

/**
 * Local HTTPS for Android PWA testing.
 *
 * Android only treats an origin as secure when it is HTTPS (or localhost).
 * This creates a private local CA and a server certificate whose SAN includes
 * the Mac's current LAN address. The CA is trusted once on the Samsung; the
 * server certificate is regenerated on each start so a hotspot IP change does
 * not leave a stale certificate. Nothing is exposed publicly by this script.
 */

const root = process.cwd();
const certDir = path.join(root, "certs");
const caKey = path.join(certDir, "local-ca.key");
const caCrt = path.join(certDir, "local-ca.crt");
const serverKey = path.join(certDir, "local.key");
const serverCrt = path.join(certDir, "local.crt");
const certOnly = process.argv.includes("--cert-only");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function lanAddresses() {
  const addresses = new Set(["127.0.0.1"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function serverNames() {
  const host = hostname().trim();
  const names = new Set(["localhost"]);
  if (host) {
    names.add(host);
    // macOS reports the local hostname with a .local suffix. Include the
    // short name too so both forms already accepted by Next.js work over TLS.
    if (host.toLowerCase().endsWith(".local")) names.add(host.slice(0, -6));
    else names.add(`${host}.local`);
  }
  return [...names].filter(Boolean);
}

/** Refuse to start with a certificate that does not actually cover the names
 * the app advertises. This catches a stale certificate or an OpenSSL config
 * regression before the browser reports an opaque service-worker SSL error. */
function assertCertificate(names, ips) {
  const certificate = new X509Certificate(readFileSync(serverCrt));
  const authority = new X509Certificate(readFileSync(caCrt));
  if (!certificate.checkIssued(authority) || !certificate.verify(authority.publicKey)) {
    throw new Error("The development certificate was not signed by the local CA.");
  }

  const now = Date.now();
  const serverExpiry = new Date(certificate.validTo).getTime();
  const caExpiry = new Date(authority.validTo).getTime();
  if (new Date(certificate.validFrom).getTime() > now || serverExpiry <= now) {
    throw new Error("The development server certificate is expired or not yet valid.");
  }
  if (new Date(authority.validFrom).getTime() > now || caExpiry <= now) {
    throw new Error("The local CA is expired or not yet valid. Regenerate it deliberately and re-trust it.");
  }
  const serverDays = Math.floor((serverExpiry - now) / 86_400_000);
  if (serverDays < 30) {
    console.warn(`WARNING: the development certificate expires in ${serverDays} day(s).`);
  }
  console.log(`Certificate validity: server ${serverDays} day(s), CA ${Math.floor((caExpiry - now) / 86_400_000)} day(s).`);

  const missing = [];
  for (const name of names) {
    if (!certificate.checkHost(name)) missing.push(`DNS:${name}`);
  }
  for (const ip of ips) {
    if (!certificate.checkIP(ip)) missing.push(`IP Address:${ip}`);
  }
  if (missing.length > 0) {
    throw new Error(`The development certificate is missing required SANs: ${missing.join(", ")}`);
  }
}

function ensureCertificateAuthority() {
  if (existsSync(caKey) && existsSync(caCrt)) return;
  if (existsSync(caKey) !== existsSync(caCrt)) {
    throw new Error("The local CA is incomplete. Remove certs/local-ca.key and certs/local-ca.crt together, then retry.");
  }

  const config = path.join(certDir, "ca.cnf");
  writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=v3_ca",
      "prompt=no",
      "[dn]",
      "CN=AT AI Workforce Local CA",
      "[v3_ca]",
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,keyCertSign,cRLSign",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", caKey,
    "-out", caCrt,
    "-days", "3650",
    "-sha256",
    "-config", config,
  ]);
  chmodSync(caKey, 0o600);
  rmSync(config, { force: true });
}

function writeServerCertificate() {
  const ips = lanAddresses();
  const names = serverNames();
  const san = [
    ...[...names].filter(Boolean).map((name, index) => `DNS.${index + 1}=${name}`),
    ...ips.map((ip, index) => `IP.${index + 1}=${ip}`),
  ];
  const config = path.join(certDir, "server.cnf");
  writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name=dn",
      "prompt=no",
      "[dn]",
      "CN=AT AI Workforce Local",
      "[v3_req]",
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=@alt_names",
      "[alt_names]",
      ...san,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const csr = path.join(certDir, "local.csr");
  run("openssl", [
    "req", "-new", "-newkey", "rsa:2048", "-nodes",
    "-keyout", serverKey,
    "-out", csr,
    "-config", config,
  ]);
  run("openssl", [
    "x509", "-req",
    "-in", csr,
    "-CA", caCrt,
    "-CAkey", caKey,
    "-CAcreateserial",
    "-out", serverCrt,
    "-days", "825",
    "-sha256",
    "-extfile", config,
    "-extensions", "v3_req",
  ]);
  chmodSync(serverKey, 0o600);
  rmSync(csr, { force: true });
  rmSync(config, { force: true });

  const certificate = readFileSync(serverCrt, "utf8");
  if (!certificate.includes("BEGIN CERTIFICATE")) throw new Error("The generated server certificate is not valid PEM.");
  assertCertificate(names, ips);
  return ips;
}

/** The Samsung and the Mac use different trust stores. A certificate that
 * works on the phone can still fail Chrome on the Mac if the CA was never
 * trusted in Keychain, so report the exact local remedy instead of silently
 * starting a server that cannot register its service worker locally. */
function reportMacTrust(names, ips) {
  if (process.platform !== "darwin") return;
  const failed = [];
  for (const name of [...new Set([...names, ...ips])]) {
    const result = spawnSync(
      "security",
      ["verify-cert", "-c", serverCrt, "-p", "ssl", "-n", name, "-L"],
      { stdio: "ignore" },
    );
    if (result.error || result.status !== 0) failed.push(name);
  }
  if (failed.length === 0) {
    console.log("macOS Keychain: local CA trusted for every certificate name.");
    return;
  }
  console.warn(`macOS Keychain: the local CA is not trusted for: ${failed.join(", ")}.`);
  console.warn("Trust only the public CA certificate in your login keychain:");
  console.warn(`  security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" ${path.relative(root, caCrt)}`);
  console.warn("Or open the CA in Keychain Access, add it to login, and set Trust to Always Trust.");
  console.warn("Never copy certs/local-ca.key, certs/local.key or any private key to a browser or phone.");
}

function prepare() {
  mkdirSync(certDir, { recursive: true });
  ensureCertificateAuthority();
  const ips = writeServerCertificate();
  console.log(`Local CA: ${path.relative(root, caCrt)}`);
  console.log(`Server certificate: ${path.relative(root, serverCrt)}`);
  console.log(`LAN address(es): ${ips.join(", ")}`);
  console.log("Trust only the CA certificate on your Samsung and Mac; never copy the private keys to either device.");
  reportMacTrust(serverNames(), ips);
}

if (certOnly) {
  prepare();
  process.exit(0);
}

prepare();
const nextBin = path.join(root, "node_modules", ".bin", "next");
if (!existsSync(nextBin)) throw new Error("Next.js is not installed. Run npm install first.");

console.log("Starting HTTPS development server on https://0.0.0.0:3000");
console.log("Open the LAN URL shown by Next on the Samsung after installing the local CA.");
const child = spawn(
  nextBin,
  [
    "dev",
    "--hostname", "0.0.0.0",
    "--experimental-https",
    "--experimental-https-key", serverKey,
    "--experimental-https-cert", serverCrt,
  ],
  {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, ATW_HTTPS: "1" },
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on("exit", (code) => {
  process.exit(code ?? 0);
});
