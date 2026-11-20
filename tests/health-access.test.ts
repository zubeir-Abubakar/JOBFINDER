import assert from "node:assert/strict";
import test from "node:test";
import { healthRequestAuthorised } from "../lib/health-access.ts";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/health", { headers });
}

test("health stays local by default and can be reached by a bearer token", () => {
  const saved = {
    token: process.env.HEALTHCHECK_TOKEN,
    public: process.env.HEALTH_PUBLIC,
    trust: process.env.TRUST_PROXY,
  };
  delete process.env.HEALTHCHECK_TOKEN;
  delete process.env.HEALTH_PUBLIC;
  delete process.env.TRUST_PROXY;

  assert.equal(healthRequestAuthorised(request()), true, "direct host request");
  assert.equal(healthRequestAuthorised(request({ host: "localhost:3000" })), true, "direct loopback host");
  // Without an explicit proxy contract, a client-supplied header cannot turn a
  // remote peer into localhost.
  assert.equal(healthRequestAuthorised(request({ "x-real-ip": "127.0.0.1" })), false);
  assert.equal(healthRequestAuthorised(request({ host: "localhost:3000", "x-real-ip": "203.0.113.9" })), false);
  assert.equal(healthRequestAuthorised(request({ "x-real-ip": "203.0.113.9" })), false);
  assert.equal(healthRequestAuthorised(request({ "x-forwarded-for": "127.0.0.1, 203.0.113.9" })), false);

  process.env.TRUST_PROXY = "true";
  assert.equal(healthRequestAuthorised(request({ "x-real-ip": "127.0.0.1" })), true);
  assert.equal(healthRequestAuthorised(request({ "x-real-ip": "203.0.113.9" })), false);
  // The last forwarded hop is the peer; a prepended value is ignored.
  assert.equal(healthRequestAuthorised(request({ "x-forwarded-for": "127.0.0.1, 203.0.113.9" })), false);

  process.env.HEALTHCHECK_TOKEN = "private-monitor-token";
  assert.equal(healthRequestAuthorised(request({ "x-real-ip": "203.0.113.9", authorization: "Bearer wrong" })), false);
  assert.equal(healthRequestAuthorised(request({ "x-real-ip": "203.0.113.9", authorization: "Bearer private-monitor-token" })), true);

  process.env.HEALTH_PUBLIC = "true";
  assert.equal(healthRequestAuthorised(request({ "x-real-ip": "203.0.113.9" })), true);

  if (saved.token === undefined) delete process.env.HEALTHCHECK_TOKEN;
  else process.env.HEALTHCHECK_TOKEN = saved.token;
  if (saved.public === undefined) delete process.env.HEALTH_PUBLIC;
  else process.env.HEALTH_PUBLIC = saved.public;
  if (saved.trust === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = saved.trust;
});
