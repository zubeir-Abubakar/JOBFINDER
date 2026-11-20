import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = "http://127.0.0.1:3213";
const dataDir = readFileSync("/tmp/atw-identity-datadir", "utf8").trim();
const db = `${dataDir}/at-ai-workforce.db`;
const expected = [
  ["Chief", "Chief Coordinator / Orchestrator", "coordinator"],
  ["Saffa", "Job Research Agent / Discovery", "research"],
  ["Ali", "Job Analysis Agent / Matching", "analysis"],
  ["Kora", "CV Optimisation Agent / Documents", "cv"],
  ["Kali", "ATS Quality Control Agent", "ats"],
  ["Amira", "Application Agent / Cover Letter & Documents", "cover"],
  ["Noor", "Application Agent / Submission", "application"],
  ["Rayna", "Email & Tracking Agent", "email"],
];
const results = [];
const consoleErrors = [];
const pageErrors = [];

mkdirSync("artifacts", { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  const setupResponse = await page.goto(`${base}/setup`, { waitUntil: "networkidle" });
  if (setupResponse?.status() !== 200) throw new Error(`Setup page returned ${setupResponse?.status()}`);
  if (await page.locator("#setup_token").count()) {
    await page.fill("#setup_token", "identity-browser-setup-token-2026");
  }
  await page.fill("#owner_name", "Identity Browser Owner");
  await page.fill("#owner_email", "identity-owner@example.test");
  await page.fill("#owner_password", "Identity!2026Alpha");
  await page.fill("#admin_email", "identity-admin@example.test");
  await page.fill("#admin_password", "Admin!2026Alpha");
  await Promise.all([
    page.waitForURL("**/dashboard", { timeout: 30000 }),
    page.getByRole("button", { name: /Create accounts/i }).click(),
  ]);
  results.push(["setup", "owner account created and signed in"]);

  const ownerId = execFileSync("sqlite3", [db, "SELECT id FROM users WHERE role='owner' LIMIT 1;"]).toString().trim();
  const now = new Date().toISOString();
  const statements = [
    `INSERT INTO workflows (id,kind,label,status,summary,created_at,finished_at,started_by) VALUES ('wf_identity_browser','recruitment','Identity browser check','completed','All eight stages recorded.','${now}','${now}','${ownerId}');`,
    ...expected.map(
      ([, , key], index) =>
        `INSERT INTO tasks (id,workflow_id,agent_key,title,status,output,created_at,started_at,finished_at,execution_mode) VALUES ('task_identity_${key}','wf_identity_browser','${key}','Browser check ${index + 1}','completed','Recorded for ${key}.','${now}','${now}','${now}','deterministic');`,
    ),
  ].join("\n");
  execFileSync("sqlite3", [db, statements]);

  const agentsResponse = await page.goto(`${base}/agents`, { waitUntil: "networkidle" });
  if (agentsResponse?.status() !== 200) throw new Error(`Agents page returned ${agentsResponse?.status()}`);
  const agentsBody = await page.locator("body").innerText();
  for (const [name, title] of expected) {
    if (!agentsBody.includes(name)) throw new Error(`Agents page is missing ${name}`);
    if (!agentsBody.includes(title)) throw new Error(`Agents page is missing title ${title}`);
  }
  results.push(["agent roster", "all eight names and professional titles are visible"]);

  const stages = await page.locator(".flow-stage-name").allTextContents();
  const requiredStages = ["Chief", "Saffa", "Ali", "Kora & Amira", "Kali", "Noor", "Rayna"];
  if (JSON.stringify(stages) !== JSON.stringify(requiredStages)) {
    throw new Error(`Workflow order mismatch: ${JSON.stringify(stages)}`);
  }
  results.push(["workflow chart", requiredStages.join(" -> ")]);
  await page.screenshot({ path: "artifacts/identity-agents-desktop.png", fullPage: true });

  async function send(message) {
    return page.evaluate(async (text) => {
      const response = await fetch("/api/assistant/message/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const raw = await response.text();
      const events = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return { status: response.status, events };
    }, message);
  }

  for (const [name, , key] of expected.filter(([, , key]) => key !== "coordinator")) {
    const response = await send(name);
    const done = response.events.find((event) => event.type === "done");
    if (response.status !== 200 || !done) throw new Error(`${name} routing returned no done event`);
    if (done.agentKey !== key) throw new Error(`${name} routed to ${done.agentKey}, expected ${key}`);
    if (!done.reply.includes(name)) throw new Error(`${name} introduction did not name ${name}`);
  }
  results.push(["named routing", "Saffa, Ali, Kora, Kali, Amira, Noor and Rayna each activated their real session"]);

  const returnToChief = await send("Chief");
  const chiefDone = returnToChief.events.find((event) => event.type === "done");
  if (chiefDone?.agentKey !== "coordinator") throw new Error(`Chief return routed to ${chiefDone?.agentKey}`);
  results.push(["return to Chief", "conversation returned to the coordinator"]);

  const connectNoor = await send("Connect me to Noor about my application");
  const noorDone = connectNoor.events.find((event) => event.type === "done");
  if (noorDone?.agentKey !== "application") throw new Error(`Noor connection routed to ${noorDone?.agentKey}`);
  results.push(["natural connection", "Connect me to Noor about my application reached Noor"]);

  await page.goto(`${base}/assistant`, { waitUntil: "networkidle" });
  const assistantHeading = await page.getByRole("heading", { name: "Noor", exact: true }).isVisible();
  const assistantBody = await page.locator("body").innerText();
  if (!assistantHeading) throw new Error("Assistant page does not show Noor as the active agent");
  if (!assistantBody.includes("Application Agent / Submission")) throw new Error("Assistant page is missing Noor's title");
  if (!(await page.getByRole("button", { name: /Open AT Voice Assistant/i }).isVisible())) {
    throw new Error("Voice trigger is not visible");
  }
  await page.screenshot({ path: "artifacts/identity-assistant-desktop.png", fullPage: true });
  results.push(["assistant UI", "active agent, title and voice/text entry points are visible"]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/agents`, { waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 2) throw new Error(`Mobile page overflows horizontally by ${overflow}px`);
  const mobileBody = await page.locator("body").innerText();
  for (const [name] of expected) {
    if (!mobileBody.includes(name)) throw new Error(`Mobile agents page is missing ${name}`);
  }
  await page.screenshot({ path: "artifacts/identity-agents-mobile.png", fullPage: true });
  results.push(["mobile layout", "390px viewport has no page-level horizontal overflow and keeps all names"]);

  console.log(JSON.stringify({ ok: true, results, consoleErrors, pageErrors }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), results, consoleErrors, pageErrors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
