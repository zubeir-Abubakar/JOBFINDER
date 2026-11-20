import { createServer } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const port = Number(process.env.E2E_PORT ?? 3313);
const jobPort = Number(process.env.E2E_JOB_PORT ?? 3314);
const baseURL = `http://127.0.0.1:${port}`;
const runtimeDir = path.join(root, ".e2e-runtime");
const dataDir = path.join(runtimeDir, "data");

if (!existsSync(path.join(root, ".next/BUILD_ID"))) {
  console.error("E2E requires a production build. Run: npm run e2e:prepare");
  process.exit(1);
}

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(runtimeDir, "manifest.json"),
  JSON.stringify({ baseURL, dataDir, jobSourceURL: `http://127.0.0.1:${jobPort}/api/job-board-api` }, null, 2),
);

const nowSeconds = Math.floor(Date.now() / 1000);
const fixtureJobs = [
  {
    slug: "e2e-qa-automation-zurich",
    company_name: "Helvetia Digital Systems AG",
    title: "Senior QA Automation Engineer",
    description:
      "We are hiring a hands-on QA automation engineer to build Playwright and TypeScript test suites for our Zurich platform. You will own test automation strategy, CI quality gates and end-to-end testing for a growing engineering team.",
    remote: true,
    url: "https://careers.helvetia-digital.example/jobs/e2e-qa-automation",
    tags: ["qa", "playwright", "typescript", "automation"],
    job_types: ["Full-time"],
    location: "Zurich, Switzerland",
    created_at: nowSeconds,
  },
  {
    slug: "e2e-marketing-zurich",
    company_name: "Helvetia Digital Systems AG",
    title: "Marketing Campaign Manager",
    description:
      "Plan and run demand-generation campaigns for our Zurich office. This is a marketing role and does not involve software testing or quality engineering.",
    remote: true,
    url: "https://careers.helvetia-digital.example/jobs/e2e-marketing",
    tags: ["marketing"],
    job_types: ["Full-time"],
    location: "Zurich, Switzerland",
    created_at: nowSeconds,
  },
  {
    slug: "e2e-qa-berlin-onsite",
    company_name: "Northstar Synthetic GmbH",
    title: "QA Automation Engineer",
    description:
      "Build automated tests for a large e-commerce platform. This role is based in Berlin and requires on-site attendance; it is not remote.",
    remote: false,
    url: "https://careers.northstar-synthetic.example/jobs/e2e-qa-berlin",
    tags: ["qa", "automation"],
    job_types: ["Full-time"],
    location: "Berlin, Germany",
    created_at: nowSeconds,
  },
];

let fixtureMode = "normal";

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
  });
}

function mockCompletion(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt = messages.map((message) => String(message.content ?? "")).join("\n");
  if (/which agent handles application submission/i.test(prompt)) {
    return "Noor handles application submission and confirmation verification. Application Agent / Submission.";
  }
  if (/submitted in the last 7 days/i.test(prompt)) {
    return "You have submitted 0 application(s) in the last 7 days (0 recorded in total). Only confirmed submissions are counted.";
  }
  if (/what can you do|commands/i.test(prompt)) {
    return "I can inspect live recruitment state, explain agent ownership, and guide supported recruitment actions. I never claim an action happened without a stored result.";
  }
  return "I can help with job discovery, application preparation, agent status and recruitment reporting. I only use persisted workspace facts.";
}

async function handleMockProvider(request, response, url) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ object: "list", data: [{ id: "e2e-model", object: "model", owned_by: "e2e" }] }));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    const raw = await readBody(request);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      body = {};
    }
    const text = mockCompletion(body);
    const usage = { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 };
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      response.write(`data: ${JSON.stringify({ model: "e2e-model", choices: [{ delta: { content: text } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ model: "e2e-model", choices: [], usage })}\n\n`);
      response.end("data: [DONE]\n\n");
      return true;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        id: "chatcmpl-e2e",
        object: "chat.completion",
        model: "e2e-model",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage,
      }),
    );
    return true;
  }
  return false;
}

const jobServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${jobPort}`);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (await handleMockProvider(request, response, url)) return;

  if (url.pathname === "/health") {
    response.end(JSON.stringify({ ok: true, mode: fixtureMode }));
    return;
  }

  if (url.pathname === "/__control") {
    if (request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          fixtureMode = parsed.mode === "fail" ? "fail" : "normal";
        } catch {
          fixtureMode = "normal";
        }
        response.end(JSON.stringify({ ok: true, mode: fixtureMode }));
      });
      return;
    }
    response.end(JSON.stringify({ mode: fixtureMode }));
    return;
  }

  if (url.pathname === "/api/job-board-api") {
    if (fixtureMode === "fail") {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "Synthetic job source unavailable for E2E failure test." }));
      return;
    }
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    response.end(
      JSON.stringify({
        data: page === 1 ? fixtureJobs : [],
        links: { next: null },
        meta: { page, synthetic: true },
      }),
    );
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: "Not found" }));
});

jobServer.listen(jobPort, "127.0.0.1", () => {
  console.log(`E2E synthetic job source listening on http://127.0.0.1:${jobPort}`);
});

const nextBin = path.join(root, "node_modules/next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    DATA_DIR: dataDir,
    APP_SECRET_KEY: "e2e-only-app-secret-key-not-for-production",
    SETUP_TOKEN: "e2e-setup-token-2026-owner-safe",
    // A local OpenAI-compatible provider exercises the real provider path
    // without spending money or using an external credential.
    FREELLMAPI_ENABLED: "true",
    FREELLMAPI_API_KEY: "e2e-fake-provider-key",
    FREELLMAPI_BASE_URL: `http://127.0.0.1:${jobPort}/v1`,
    FREELLMAPI_MODEL: "e2e-model",
    FREELLMAPI_ALLOWED_MODELS: "e2e-model",
    OLLAMA_ENABLED: "false",
    OPENROUTER_ENABLED: "false",
    AI_PRIMARY_PROVIDER: "freellmapi",
    // Synthetic OAuth configuration exercises status/redaction without ever
    // contacting Google. The value is asserted absent from rendered pages.
    GOOGLE_CLIENT_ID: "e2e-google-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "e2e-fake-google-secret-must-never-render",
    GOOGLE_REDIRECT_URI: `${baseURL}/api/gmail/oauth/callback`,
    RECRUITMENT_DRY_RUN: "true",
    // The isolated E2E fixture is deliberately loopback-only. This flag is set
    // by the test harness, never by production configuration.
    OUTBOUND_ALLOW_PRIVATE: "true",
    ARBEITNOW_API_URL: `http://127.0.0.1:${jobPort}/api/job-board-api`,
  },
  stdio: "inherit",
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (signal) console.log(`E2E server shutting down (${signal})`);
  child.kill("SIGTERM");
  jobServer.close();
  setTimeout(() => process.exit(0), 500).unref();
}

child.on("exit", (code, signal) => {
  console.log(`Next.js E2E server exited: code=${code ?? "null"} signal=${signal ?? "none"}`);
  jobServer.close();
  process.exit(code ?? 1);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
