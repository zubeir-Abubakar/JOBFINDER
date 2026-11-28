import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * End-to-end tests for scripts/secret-scan.mjs.
 *
 * Every credential below is assembled at runtime from harmless fragments, so
 * this file — which the scanner itself scans — contains no credential-shaped
 * literal. Each case runs the real scanner against a throwaway Git repository,
 * which is the only way to prove the exit code, the redaction and the
 * placeholder handling together.
 */

const here = dirname(fileURLToPath(import.meta.url));
const scanner = resolve(here, "../scripts/secret-scan.mjs");

/** Deterministic filler with mixed character classes, like a real token body. */
function filler(length: number, seed = "Ab3xY9"): string {
  return Array.from({ length }, (_, index) => seed[index % seed.length]).join("");
}

let counter = 0;

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), `atw-secret-scan-${counter++}-`));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function scan(dir: string): { status: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [scanner], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

function withRepo(files: Record<string, string>): { status: number; output: string } {
  const dir = repoWith(files);
  try {
    return scan(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES: Array<{ name: string; value: string; file: string }> = [
  { name: "a Google API key", value: `AIza${filler(35)}`, file: "probe.ts" },
  { name: "a Google OAuth client secret", value: `GOCSPX-${filler(24)}`, file: "probe.ts" },
  { name: "a Resend API key", value: `re_${filler(20)}`, file: "probe.ts" },
  { name: "an OpenAI-style key", value: `sk-${filler(32)}`, file: "probe.ts" },
  { name: "a GitHub token", value: `ghp_${filler(36)}`, file: "probe.ts" },
  { name: "an AWS access key", value: `AKIA${filler(16, "ABCDEFGHIJKLMNOP")}`, file: "probe.ts" },
  { name: "a signed JWT", value: `eyJ${filler(12)}.${filler(16)}.${filler(20)}`, file: "probe.ts" },
  {
    name: "a private key block",
    value: `-----BEGIN ${"RSA PRIVATE KEY"}-----`,
    file: "probe.pem",
  },
  {
    name: "a database URL with a password",
    // Concatenated so the test file itself is not a leaked DSN.
    value: "postgres" + ":" + "//app:" + filler(24) + "@db.example.com/atw",
    file: "probe.env",
  },
  {
    name: "a credential embedded in an arbitrary URL",
    value: `https://svc:${filler(24)}@registry.example.com/pkg`,
    file: "probe.html",
  },
];

for (const entry of CASES) {
  test(`detects ${entry.name}`, () => {
    const result = withRepo({ [entry.file]: `value = "${entry.value}"\n` });
    assert.equal(result.status, 1, `expected a non-zero exit for ${entry.name}`);
    assert.match(result.output, /Secret scan failed/);
    // The scanner must never print the matched value, only a redacted summary.
    assert.equal(
      result.output.includes(entry.value),
      false,
      `the scanner printed the ${entry.name} it found`,
    );
  });
}

test("detects a credential embedded in package-lock.json", () => {
  const value = `https://svc:${filler(24)}@npm.example.com/pkg.tgz`;
  const lockfile = JSON.stringify({
    name: "probe",
    lockfileVersion: 3,
    packages: { "node_modules/probe": { version: "1.0.0", resolved: value } },
  });
  const result = withRepo({ "package-lock.json": lockfile });
  assert.equal(result.status, 1);
});

test("ordinary lockfile metadata is not a finding", () => {
  const lockfile = JSON.stringify({
    name: "probe",
    lockfileVersion: 3,
    packages: {
      "": { name: "probe", dependencies: { next: "^16.4.6" } },
      "node_modules/next": {
        version: "16.4.6",
        resolved: "https://registry.npmjs.org/next/-/next-16.4.6.tgz",
        integrity: `sha512-${filler(60, "AAAA")}`,
      },
    },
  });
  const result = withRepo({ "package-lock.json": lockfile });
  assert.equal(result.status, 0, result.output);
});

test("documented placeholders are not reported", () => {
  const result = withRepo({
    ".env.example": [
      `GEMINI_API_KEY=AIza${filler(24)}placeholder`,
      "RESEND_API_KEY=your-resend-api-key-here-change-this",
      "GOOGLE_CLIENT_SECRET=your-client-secret-from-google-cloud",
      "APP_SECRET_KEY=",
      "GITHUB_TOKEN=<paste-your-token-here>",
      "",
    ].join("\n"),
  });
  assert.equal(result.status, 0, result.output);
});

test("an ordinary source tree passes", () => {
  const result = withRepo({
    "lib/example.ts": [
      'const apiKeyName = "GEMINI_API_KEY";',
      'const tokenPath = "/api/gmail/oauth/callback";',
      "export function score(password: string) { return password.length; }",
      "",
    ].join("\n"),
  });
  assert.equal(result.status, 0, result.output);
});
