import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Isolated JavaScript ATS fixture for the Phase 2 browser-executor proof.
 *
 * It is a loopback-only application for a synthetic employer. The initial HTML
 * is a loading skeleton; the form is hydrated with JavaScript, a language
 * question is fetched and appended later, and the cover-letter question only
 * appears after a cover-letter file is attached. The server validates again and
 * deduplicates repeated submissions by candidate email + vacancy.
 */

export type FixtureFile = {
  field: string;
  filename: string;
  size: number;
  sha256: string;
  firstBytes: string;
};

export type FixtureSubmission = {
  reference: string;
  fields: Record<string, string>;
  files: FixtureFile[];
  receivedAt: string;
};

export type AtsFixtureState = {
  submissions: FixtureSubmission[];
  duplicateAttempts: number;
  requests: string[];
};

export type AtsFixture = {
  baseUrl: string;
  state: AtsFixtureState;
  close: () => Promise<void>;
};

const FORM_FIELDS = `
<input type="hidden" name="job_id" value="fixture-job-qa-001">
<label for="full_name">Full name</label>
<input id="full_name" name="full_name" autocomplete="name" required>
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required>
<label for="phone">Phone</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" required>
<label for="work_authorisation">Work authorisation</label>
<input id="work_authorisation" name="work_authorisation" required>
<label for="country">Country</label>
<select id="country" name="country" required>
  <option value="">Select a country</option>
  <option value="Switzerland">Switzerland</option>
  <option value="Germany">Germany</option>
</select>
<label for="languages">Languages</label>
<select id="languages" name="languages" required>
  <option value="">Loading language options…</option>
</select>
<label for="resume">Resume / CV</label>
<input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx" required>
<label for="cover_file">Cover letter file</label>
<input id="cover_file" name="cover_file" type="file" accept=".pdf,.doc,.docx" required>
<div id="cover-details" hidden>
  <label for="cover_letter">Cover letter text</label>
  <textarea id="cover_letter" name="cover_letter"></textarea>
</div>
<label for="work_model">Preferred working model</label>
<select id="work_model" name="work_model" class="custom-select">
  <option value="">Choose…</option>
  <option value="hybrid">Hybrid</option>
  <option value="remote">Remote</option>
  <option value="office">Office</option>
</select>
<label for="how">How did you hear about us?</label>
<input id="how" name="how_did_you_hear">
<div id="client-errors" role="alert" hidden></div>
<button type="submit">Submit application</button>
`;

function page(options: { unknown?: boolean; challenge?: boolean; noConfirmation?: boolean }): string {
  const extra = options.unknown
    ? '<label for="favourite_framework">What is your favourite testing framework?</label><input id="favourite_framework" name="favourite_framework" required>'
    : "";
  const challenge = options.challenge
    ? '<div class="g-recaptcha" data-sitekey="fixture-site-key" style="width:304px;height:78px">Security check</div>'
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Northstar Synthetic ATS</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 32px auto; }
  label { display:block; margin-top:14px; font-weight:600; }
  input, select, textarea { width:100%; padding:8px; margin-top:4px; }
  .custom-select { appearance:none; background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z'/%3E%3C/svg%3E") no-repeat right 10px center; }
  #client-errors { color:#a00; margin-top:12px; }
</style></head>
<body>
<h1>Apply — Senior QA Automation Engineer</h1>
<p>Northstar Synthetic AG · Zürich</p>
<div id="app">Loading application…</div>
<script>
setTimeout(function () {
  var app = document.getElementById('app');
  app.innerHTML = '<form id="ats-form" method="post" action="' + ${JSON.stringify(options.noConfirmation ? "/ats/apply?noconfirm=1" : "/ats/apply")} + '" enctype="multipart/form-data" data-ready="false">' +
    ${JSON.stringify(FORM_FIELDS + extra + challenge)} +
    '</form>';
  var form = document.getElementById('ats-form');
  var coverFile = document.getElementById('cover_file');
  var coverDetails = document.getElementById('cover-details');
  coverFile.addEventListener('change', function () {
    if (coverFile.files && coverFile.files.length) {
      coverDetails.hidden = false;
      document.getElementById('cover_letter').required = true;
    }
  });
  // A second, dynamically loaded question. The form is not marked ready until
  // this request has completed, so a test cannot mistake the skeleton for the
  // complete application.
  fetch('/ats/questions.json').then(function (response) { return response.json(); }).then(function (data) {
    var languages = document.getElementById('languages');
    languages.innerHTML = '<option value="">Select a language</option>' + data.languages.map(function (language) {
      return '<option value="' + language + '">' + language + '</option>';
    }).join('');
    form.dataset.ready = 'true';
  });
  form.addEventListener('submit', function (event) {
    var phone = document.getElementById('phone').value;
    if (!/^\\+41/.test(phone)) {
      event.preventDefault();
      var errors = document.getElementById('client-errors');
      errors.hidden = false;
      errors.textContent = 'Phone number must start with +41.';
    }
  });
}, 350);
</script>
</body></html>`;
}

function confirmation(reference: string, duplicate: boolean): string {
  return `<!doctype html><html><body>
<h1>Thank you for applying</h1>
<p>Your application was received by Northstar Synthetic AG.</p>
<p>Application reference: ${reference}</p>
${duplicate ? "<p>This application was already received; no duplicate was created.</p>" : ""}
</body></html>`;
}

function parseMultipart(
  body: Buffer,
  contentType: string,
): { fields: Record<string, string>; files: FixtureFile[] } {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  const fields: Record<string, string> = {};
  const files: FixtureFile[] = [];
  if (!boundary) return { fields, files };
  const raw = body.toString("latin1");
  for (const chunk of raw.split(`--${boundary}`)) {
    if (!chunk.trim() || chunk.startsWith("--")) continue;
    const separator = chunk.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const head = chunk.slice(0, separator);
    const content = chunk.slice(separator + 4).replace(/\r\n$/, "");
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    if (filename) {
      const buffer = Buffer.from(content, "latin1");
      files.push({
        field: name,
        filename,
        size: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        firstBytes: buffer.subarray(0, 40).toString("utf8"),
      });
    } else {
      fields[name] = content;
    }
  }
  return { fields, files };
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8_000_000) {
        reject(new Error("Fixture upload limit exceeded"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export async function startAtsFixture(): Promise<AtsFixture> {
  const state: AtsFixtureState = { submissions: [], duplicateAttempts: 0, requests: [] };
  let server: Server;
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    state.requests.push(`${request.method} ${url.pathname}${url.search}`);

    if (request.method === "GET" && url.pathname === "/ats") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        page({
          unknown: url.searchParams.get("unknown") === "1",
          challenge: url.searchParams.get("challenge") === "1",
          noConfirmation: url.searchParams.get("noconfirm") === "1",
        }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/ats-challenge") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(page({ challenge: true }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/ats/questions.json") {
      // A delayed dynamic question, fetched after the first render.
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ languages: ["English (C1)"] }));
      }, 250);
      return;
    }

    if (request.method === "GET" && url.pathname === "/ats/confirmation") {
      const reference = url.searchParams.get("ref") ?? "ATS-2026-UNKNOWN";
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(confirmation(reference, false));
      return;
    }

    if (request.method === "POST" && url.pathname === "/ats/apply") {
      const body = await readBody(request);
      const parsed = parseMultipart(body, String(request.headers["content-type"] ?? ""));
      const fields = parsed.fields;

      if (url.searchParams.get("noconfirm") === "1") {
        // A 200 response with no confirmation or reference. The executor must
        // not treat this as a successful application.
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body><h1>OK</h1><p>Request processed.</p></body></html>");
        return;
      }

      if (String(fields.email ?? "").includes("+reject")) {
        response.writeHead(422, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          '<!doctype html><html><body><h1>Application not accepted</h1><div role="alert">The employer server rejected this email address.</div></body></html>',
        );
        return;
      }

      const missing = ["full_name", "email", "phone", "work_authorisation", "country", "languages"].filter(
        (name) => !String(fields[name] ?? "").trim(),
      );
      if (parsed.files.some((file) => file.field === "cover_file") && !String(fields.cover_letter ?? "").trim()) {
        missing.push("cover_letter");
      }
      if (missing.length > 0) {
        response.writeHead(422, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><html><body><h1>Application not accepted</h1><div role="alert">Missing required field: ${missing.join(", ")}</div></body></html>`,
        );
        return;
      }

      const key = `${fields.email}|${fields.job_id}`;
      const existing = state.submissions.find(
        (submission) => `${submission.fields.email}|${submission.fields.job_id}` === key,
      );
      if (existing) {
        state.duplicateAttempts += 1;
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(confirmation(existing.reference, true));
        return;
      }

      const reference = `ATS-2026-${1001 + state.submissions.length}`;
      state.submissions.push({
        reference,
        fields,
        files: parsed.files,
        receivedAt: new Date().toISOString(),
      });
      response.writeHead(303, { Location: `/ats/confirmation?ref=${encodeURIComponent(reference)}` });
      response.end();
      return;
    }

    response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    response.end("Not found");
  };

  server = createServer((request, response) => {
    handler(request, response).catch((error) => {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.message : "fixture error");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
