import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { detectDocumentType, safeDocumentMime } from "../lib/document-type.ts";
import { assertPublicHttpUrl } from "../lib/outbound-url.ts";
import { isLoopbackRequest } from "../lib/request-context.ts";
import { readLimitedText, resolvePublicAddresses, safeFetch, validateRedirectTarget } from "../lib/safe-http.ts";

const fixture = createServer((request, response) => {
  if (request.url === "/redirect-private") {
    response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end("safe fixture response");
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixturePort = (fixture.address() as AddressInfo).port;
const fixtureBase = `http://127.0.0.1:${fixturePort}`;

after(() => {
  fixture.close();
});

test("outbound URLs reject loopback, private, metadata and credential-bearing targets", () => {
  const blocked = [
    "http://localhost/admin",
    "http://127.0.0.1:3000/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://user:pass@jobs.example.com/",
    "file:///etc/passwd",
  ];
  for (const url of blocked) {
    assert.throws(() => assertPublicHttpUrl(url, { allowPrivate: false }), url);
  }
  assert.equal(assertPublicHttpUrl("https://jobs.example.com/apply").hostname, "jobs.example.com");
});

test("document content signatures override a lying browser MIME type", () => {
  const pdf = detectDocumentType(Buffer.from("%PDF-1.7\n"), "cv.pdf");
  assert.equal(pdf?.mime, "application/pdf");
  const docx = detectDocumentType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), "cv.docx");
  assert.equal(docx?.mime, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const txt = detectDocumentType(Buffer.from("plain UTF-8 CV text"), "cv.txt");
  assert.equal(txt?.mime, "text/plain");

  assert.equal(detectDocumentType(Buffer.from("<html>not a pdf</html>"), "cv.pdf"), null);
  assert.equal(detectDocumentType(Buffer.from("not a zip"), "cv.docx"), null);
  assert.equal(safeDocumentMime("cv.html", "text/html"), "application/octet-stream");
  assert.equal(safeDocumentMime("cv.pdf", "text/html"), "application/pdf");
});

test("proxy headers are not trusted without an explicit proxy contract", () => {
  const saved = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  assert.equal(isLoopbackRequest(new Headers()), true);
  assert.equal(isLoopbackRequest(new Headers({ "x-real-ip": "127.0.0.1" })), false);

  process.env.TRUST_PROXY = "true";
  assert.equal(isLoopbackRequest(new Headers({ "x-real-ip": "127.0.0.1" })), true);
  assert.equal(isLoopbackRequest(new Headers({ "x-real-ip": "203.0.113.9" })), false);
  assert.equal(isLoopbackRequest(new Headers({ "x-forwarded-for": "127.0.0.1, 203.0.113.9" })), false);

  if (saved === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = saved;
});

test("DNS resolution rejects private answers and accepts public answers", async () => {
  await assert.rejects(
    resolvePublicAddresses("jobs.example.test", {
      allowPrivate: false,
      lookupImpl: ((_hostname: string, _options: unknown, callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void) =>
        callback(null, [{ address: "127.0.0.1", family: 4 }])) as never,
    }),
    /private|loopback|reserved/i,
  );
  const addresses = await resolvePublicAddresses("jobs.example.test", {
    allowPrivate: false,
    lookupImpl: ((_hostname: string, _options: unknown, callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void) =>
      callback(null, [
        { address: "127.0.0.1", family: 4 },
        { address: "93.184.216.34", family: 4 },
      ])) as never,
  });
  assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }]);
});

test("redirects to metadata and private destinations are rejected", () => {
  assert.throws(
    () => validateRedirectTarget("http://169.254.169.254/latest/meta-data/", "https://jobs.example.com/", { allowPrivate: false }),
    /private|link-local|blocked/i,
  );
  assert.throws(
    () => validateRedirectTarget("http://10.0.0.4/admin", "https://jobs.example.com/", { allowPrivate: false }),
    /private|link-local|blocked/i,
  );
  assert.equal(
    validateRedirectTarget("/apply", "https://jobs.example.com/job/1", { allowPrivate: false }),
    "https://jobs.example.com/apply",
  );
});

test("safe fetch uses the pinned local transport and bounded response reads", async () => {
  const response = await safeFetch(`${fixtureBase}/ok`, {}, { allowPrivate: true });
  assert.equal(await readLimitedText(response, 100), "safe fixture response");
  const port = new URL(fixtureBase).port;
  const byHostname = await safeFetch(`http://localhost:${port}/ok`, {}, { allowPrivate: true });
  assert.equal(await readLimitedText(byHostname, 100), "safe fixture response", "the validated lookup must satisfy Node's all-addresses request");
  await assert.rejects(
    safeFetch(`${fixtureBase}/ok`, {}, { allowPrivate: false }),
    /private|link-local|blocked/i,
  );
  const limited = await safeFetch(`${fixtureBase}/ok`, {}, { allowPrivate: true });
  await assert.rejects(readLimitedText(limited, 5), /size limit/i);
  const redirect = await safeFetch(`${fixtureBase}/redirect-private`, { redirect: "manual" }, { allowPrivate: true });
  assert.equal(redirect.status, 302);
});
