import { test, expect } from "@playwright/test";

test("login is public while workspace and health endpoints are protected", async ({ request }) => {
  const login = await request.get("/login", { maxRedirects: 0 });
  expect(login.status()).toBe(200);
  expect(await login.text()).toContain("Sign in to your workspace");

  const dashboard = await request.get("/dashboard", { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(dashboard.status());
  expect(dashboard.headers()["location"]).toContain("/login");

  const health = await request.get("/api/health", { maxRedirects: 0 });
  expect(health.status()).toBe(404);
  expect(await health.text()).not.toContain("APP_SECRET_KEY");
});

test("post-authentication setup is permanently closed", async ({ request }) => {
  const setup = await request.get("/setup");
  expect(setup.status()).toBe(200);
  const body = await setup.text();
  // Next renders a server redirect as a 200 document with a redirect marker in
  // this production runtime. Either form proves /setup is no longer available.
  expect(body).toMatch(/NEXT_REDIRECT;replace;\/login|url=\/login/);
  expect(body).not.toContain("Create accounts and open workspace");
  expect(body).not.toContain("Provision your");
});
