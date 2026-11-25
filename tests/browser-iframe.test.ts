import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { CandidateDocuments, CandidateProfile } from "../lib/candidate-forms.ts";

/**
 * Local-only iframe fixtures.
 *
 * Every page, frame and POST target is on loopback. The cross-origin case uses
 * 127.0.0.1 for the employer page and localhost for the embedded form provider,
 * which gives the browser two distinct origins without contacting a third
 * party. No fixture is an employer, ATS or production form.
 */

process.env.RECRUITMENT_IFRAME_WAIT_MS = "1200";
process.env.RECRUITMENT_IFRAME_ALLOWED_HOSTS = "";

type Post = { path: string; body: string; contentType: string };
const POSTS: Post[] = [];
let port = 0;

function fieldset(input: { file?: boolean; stepTwo?: boolean } = {}): string {
  return [
    '<label for="full_name">Full name</label><input id="full_name" name="full_name" required>',
    '<label for="email">Email</label><input id="email" name="email" type="email" required>',
    '<label for="phone">Phone</label><input id="phone" name="phone" required>',
    '<label for="work_authorisation">Work authorisation</label><input id="work_authorisation" name="work_authorisation" required>',
    '<label for="sponsorship">Will you require sponsorship?</label>',
    '<select id="sponsorship" name="sponsorship" required><option value="">Select</option><option>Yes</option><option>No</option></select>',
    input.file
      ? '<label for="resume">Resume / CV</label><input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx" required>'
      : "",
    input.stepTwo
      ? '<label for="cover_file">Cover letter file</label><input id="cover_file" name="cover_file" type="file" accept=".pdf,.doc,.docx" required>'
      : "",
    '<label for="cover_letter">Cover letter</label><textarea id="cover_letter" name="cover_letter"></textarea>',
    '<label for="how">How did you hear about us?</label><input id="how" name="how_did_you_hear">',
  ].join("");
}

function applicationForm(action: string, input: { file?: boolean } = {}): string {
  return `<form method="post" action="${action}" enctype="multipart/form-data">${fieldset(input)}<button type="submit">Submit application</button></form>`;
}

function dynamicApplicationForm(action: string): string {
  return `<!doctype html><html><body><div id="root">Loading…</div><script>
setTimeout(function () {
  var root = document.getElementById('root');
  var form = document.createElement('form');
  form.method = 'post';
  form.action = ${JSON.stringify(action)};
  form.enctype = 'multipart/form-data';
  form.innerHTML = ${JSON.stringify(`${fieldset({ file: true })}<button type="submit">Submit application</button>`)};
  root.appendChild(form);
}, 220);
</script></body></html>`;
}

function iframePage(src: string, extra = ""): string {
  return `<!doctype html><html><body><h1>Fixture employer application</h1>${extra}<iframe title="Application form" src="${src}" width="100%" height="900"></iframe></body></html>`;
}

function delayedIframePage(src: string, delayMs: number): string {
  return `<!doctype html><html><body><h1>Fixture employer application</h1><div id="host"></div><script>
setTimeout(function () { var f = document.createElement('iframe'); f.src = ${JSON.stringify(src)}; f.title='Application form'; document.getElementById('host').appendChild(f); }, ${delayMs});
</script></body></html>`;
}

function stepOnePage(): string {
  return `<!doctype html><html><body><form method="post" action="/iframe-step2">${fieldset()}<button type="submit">Next</button></form></body></html>`;
}

function stepTwoPage(): string {
  return `<!doctype html><html><body><form method="post" action="/iframe-submit" enctype="multipart/form-data">${fieldset({ file: true, stepTwo: true })}<button type="submit">Submit application</button></form></body></html>`;
}

function validationPage(): string {
  return `<!doctype html><html><body><div class="error">Please correct the highlighted field.</div><form method="post" action="/iframe-validation">${fieldset()}<button type="submit">Next</button></form></body></html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET") {
    if (url.pathname === "/inner-form") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><body>${applicationForm("/iframe-submit", { file: true })}</body></html>`);
      return;
    }
    if (url.pathname === "/inner-dynamic") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(dynamicApplicationForm("/iframe-submit"));
      return;
    }
    if (url.pathname === "/apply-link") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<!doctype html><html><body><h1>QA Engineer</h1><a href="/same-origin">Apply now!</a></body></html>');
      return;
    }
    if (url.pathname === "/same-origin") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(iframePage("/inner-form"));
      return;
    }
    if (url.pathname === "/cross-origin") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(iframePage(`http://localhost:${port}/inner-form`));
      return;
    }
    if (url.pathname === "/delayed-iframe") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(delayedIframePage("/inner-form", 240));
      return;
    }
    if (url.pathname === "/dynamic-frame") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(iframePage("/inner-dynamic"));
      return;
    }
    if (url.pathname === "/multiple") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        iframePage(
          "/inner-form",
          '<iframe title="Newsletter" src="/newsletter" width="400" height="200"></iframe>',
        ),
      );
      return;
    }
    if (url.pathname === "/multiple-equal") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        iframePage(
          "/inner-form",
          '<iframe title="Duplicate application" src="/inner-form" width="100%" height="900"></iframe>',
        ),
      );
      return;
    }
    if (url.pathname === "/newsletter") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<form><label for="news_email">Email</label><input id="news_email" name="news_email" type="email"><button type="submit">Subscribe</button></form>');
      return;
    }
    if (url.pathname === "/unrelated") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(iframePage(`http://localhost:${port}/inner-form`));
      return;
    }
    if (url.pathname === "/inaccessible") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(iframePage("http://localhost:1/apply"));
      return;
    }
    if (url.pathname === "/timeout") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(delayedIframePage("/inner-form", 5_000));
      return;
    }
    if (url.pathname === "/iframe-captcha") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(iframePage("/captcha-form"));
      return;
    }
    if (url.pathname === "/captcha-form") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<!doctype html><html><body><div class="g-recaptcha" data-sitekey="fixture" style="width:304px;height:78px"></div>${applicationForm("/iframe-submit", { file: true })}</body></html>`,
      );
      return;
    }
    if (url.pathname === "/iframe-multistep") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(iframePage("/iframe-step1"));
      return;
    }
    if (url.pathname === "/iframe-step1") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(stepOnePage());
      return;
    }
    if (url.pathname === "/iframe-validation") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(iframePage("/iframe-validation-form"));
      return;
    }
    if (url.pathname === "/iframe-validation-form") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(validationPage());
      return;
    }
    res.writeHead(404);
    res.end("not found");
    return;
  }

  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 2_000_000) req.destroy();
  });
  req.on("end", () => {
    POSTS.push({ path: url.pathname, body, contentType: String(req.headers["content-type"] ?? "") });
    if (url.pathname === "/iframe-step2") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(stepTwoPage());
      return;
    }
    if (url.pathname === "/iframe-validation") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(validationPage());
      return;
    }
    if (url.pathname === "/iframe-500") {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Server error</h1></body></html>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<html><body><h1>Thank you for applying</h1><p>Your application was received.</p><p>Reference: IFR-2026-7777</p></body></html>",
    );
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
});

const { runBrowserCandidateForm } = await import("../lib/browser-form.ts");

const profile: CandidateProfile = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+41 79 000 00 00",
  location: "Zürich",
  linkedin: null,
  website: null,
  workAuthorisation: "Swiss Permit B — authorised to work in Switzerland without employer sponsorship",
  summary: "Senior QA engineer with fintech, mobile and API test automation experience.",
  skills: ["Playwright", "Cypress", "API testing"],
  languages: ["English (C1)"],
  experienceText: "Lead QA Engineer — Cashia\n2020 → 2024\nBuilt Playwright suites for payment APIs.",
  educationText: "BSc Computer Science — University of Example",
  sponsorshipAnswer: "No",
};

const documents: CandidateDocuments = {
  cv: { buffer: Buffer.from("%PDF-1.4 iframe tailored CV"), name: "iframe-cv.pdf" },
  cover: { buffer: Buffer.from("%PDF-1.4 iframe cover"), name: "iframe-cover.pdf" },
  coverText: "Dear Fixture team, I am applying for the QA Automation Engineer role.",
};

function frameOf(result: { evidence: Record<string, unknown> }) {
  return result.evidence.applicationFrame as
    | { kind?: string; url?: string; ancestorOrigins?: string[] }
    | null;
}

function run(path: string, extra: { allowedFrameHosts?: string[] } = {}) {
  return runBrowserCandidateForm({
    pageUrl: `${base}${path}`,
    jobTitle: "Senior QA Automation Engineer",
    company: "Fixture Employer AG",
    profile,
    documents,
    authorised: {},
    ...extra,
  });
}

test("an explicit employer Apply link is followed once before selecting its frame", { timeout: 90_000 }, async () => {
  const runResult = await run("/apply-link");
  assert.equal(runResult.result.status, "verified", runResult.result.detail);
  assert.equal(frameOf(runResult.result)?.kind, "same-origin");
});

test("a same-origin iframe form is selected, filled and verified", { timeout: 90_000 }, async () => {
  const before = POSTS.length;
  const runResult = await run("/same-origin");
  assert.equal(runResult.result.status, "verified", runResult.result.detail);
  assert.equal(runResult.result.reference, "IFR-2026-7777");
  assert.equal(POSTS.length, before + 1);
  assert.match(POSTS.at(-1)?.body ?? "", /Ada Lovelace/);
  assert.match(POSTS.at(-1)?.body ?? "", /iframe-cv\.pdf/);
  assert.equal(frameOf(runResult.result)?.kind, "same-origin");
});

test("a cross-origin provider frame is entered only when its host is approved", { timeout: 90_000 }, async () => {
  const runResult = await run("/cross-origin", { allowedFrameHosts: ["localhost"] });
  assert.equal(runResult.result.status, "verified", runResult.result.detail);
  assert.equal(frameOf(runResult.result)?.kind, "approved-provider");
  assert.deepEqual(frameOf(runResult.result)?.ancestorOrigins, [base]);
});

test("a dynamically created iframe is detected after the DOM is ready", { timeout: 90_000 }, async () => {
  const runResult = await run("/delayed-iframe");
  assert.equal(runResult.result.status, "verified", runResult.result.detail);
});

test("a form rendered inside the selected iframe after JavaScript is supported", { timeout: 90_000 }, async () => {
  const runResult = await run("/dynamic-frame");
  assert.equal(runResult.result.status, "verified", runResult.result.detail);
});

test("the highest-scoring application frame wins over an unrelated frame", { timeout: 90_000 }, async () => {
  const runResult = await run("/multiple");
  assert.equal(runResult.result.status, "verified", runResult.result.detail);
  assert.equal(runResult.plan.fields.some((field) => field.name === "news_email"), false);
  assert.equal(runResult.plan.fields.some((field) => field.name === "full_name"), true);
});

test("two equally plausible application frames are rejected instead of guessed", { timeout: 90_000 }, async () => {
  const runResult = await run("/multiple-equal");
  assert.equal(runResult.result.status, "blocked");
  assert.match(runResult.result.detail, /more than one embedded application frame/i);
});

test("an unapproved third-party iframe is never entered", { timeout: 90_000 }, async () => {
  const runResult = await run("/unrelated");
  assert.equal(runResult.result.status, "blocked");
  assert.match(runResult.result.detail, /unapproved third-party|no eligible application form/i);
});

test("a delayed frame beyond the bounded wait is classified as a timeout", { timeout: 90_000 }, async () => {
  const runResult = await run("/timeout");
  assert.equal(runResult.result.status, "blocked");
  assert.match(runResult.result.detail, /within 1200 ms/i);
});

test("an inaccessible iframe is classified as unsupported without a send", { timeout: 90_000 }, async () => {
  const before = POSTS.length;
  const runResult = await run("/inaccessible");
  assert.equal(runResult.result.status, "blocked");
  assert.equal(POSTS.length, before);
});

test("a CAPTCHA inside the selected frame blocks before any field is entered", { timeout: 90_000 }, async () => {
  const before = POSTS.length;
  const runResult = await run("/iframe-captcha");
  assert.equal(runResult.result.status, "blocked");
  assert.match(runResult.result.detail, /captcha/i);
  assert.equal(frameOf(runResult.result)?.kind, "same-origin");
  assert.equal(POSTS.length, before);
});

test("a multi-step iframe form uploads both documents and verifies once", { timeout: 120_000 }, async () => {
  const before = POSTS.length;
  const runResult = await run("/iframe-multistep");
  assert.equal(runResult.result.status, "verified", runResult.result.detail);
  assert.equal(runResult.result.reference, "IFR-2026-7777");
  const submits = POSTS.slice(before).filter((post) => post.path === "/iframe-submit");
  assert.equal(submits.length, 1);
  assert.match(submits[0].body, /iframe-cv\.pdf/);
  assert.match(submits[0].body, /iframe-cover\.pdf/);
  assert.match(submits[0].body, /Dear Fixture team/);
  assert.equal(runResult.plan.fields.some((field) => field.name === "sponsorship"), true);
});

test("a validation failure inside an iframe stops the workflow", { timeout: 90_000 }, async () => {
  const runResult = await run("/iframe-validation");
  assert.equal(runResult.result.status, "failed");
  assert.match(runResult.result.detail, /rejected the step|Please correct/i);
  assert.equal(runResult.result.evidence.sent, false);
});

test("a new browser instance runs after an uncertain iframe response without reusing state", { timeout: 120_000 }, async () => {
  const first = await runBrowserCandidateForm({
    pageUrl: `${base}/inner-form`,
    jobTitle: "Senior QA Automation Engineer",
    company: "Fixture Employer AG",
    profile,
    documents,
    authorised: {},
  });
  assert.equal(first.result.status, "verified", first.result.detail);

  const second = await run("/same-origin");
  assert.equal(second.result.status, "verified", second.result.detail);
  assert.equal(frameOf(first.result)?.kind, "main");
  assert.equal(frameOf(second.result)?.kind, "same-origin");
});
