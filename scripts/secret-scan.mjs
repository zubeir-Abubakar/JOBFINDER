#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

/**
 * Repository secret scanner.
 *
 * Three scopes:
 *   (default)  every tracked file, plus staged content — what would be pushed
 *   --staged   only added lines in the index — used by the pre-commit hook
 *   --history  every blob in every commit — used to plan a history purge
 *
 * It never prints a matched value. Findings report the path, line, pattern
 * name, value length, the first four characters and a truncated SHA-256 so a
 * finding can be correlated without the secret entering a log or a report.
 *
 * Exit code 1 on any finding, so it can gate a commit or a workflow.
 */

const args = new Set(process.argv.slice(2));
const STAGED = args.has("--staged");
const HISTORY = args.has("--history");

const SKIP_PATHS = [
  /^node_modules\//,
  /^\.next\//,
  /^\.git\//,
  /^data\//,
  /^backups\//,
  /^coverage\//,
  /^playwright-report\//,
  /^test-results\//,
  /^package-lock\.json$/, // hashes only; audited by npm audit
];

/** High-signal formats. These are enforced in every file, tests included. */
const STRONG = [
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "Google OAuth client secret", re: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI-style key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "Groq key", re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { name: "Resend key", re: /\bre_[A-Za-z0-9_]{16,}/ },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Supabase key", re: /\bsb[p]_[A-Za-z0-9_-]{20,}/ },
  { name: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "database URL with password", re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>:@/]{1,64}:[^\s"'<>@/]{2,64}@/ },
];

/**
 * Generic `secret = "..."` assignments are noisy, so they only apply outside
 * test/documentation trees and only when the value looks genuinely random
 * rather than a dash-separated placeholder.
 */
const GENERIC = {
  name: "hard-coded credential",
  re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|client[_-]?secret|access[_-]?key|private[_-]?key)\b\s*[:=]\s*["'`]([A-Za-z0-9_+/=.-]{20,})["'`]/i,
};

const GENERIC_SKIP = /^(?:tests?|e2e|docs?|artifacts|deploy\/.*\.example)/;

/**
 * Placeholder detection applies to the MATCHED VALUE, never to the whole line:
 * a line that merely mentions "example" must still be scanned. A real key never
 * contains these words.
 */
const PLACEHOLDER_VALUE = /(?:placeholder|change[-_]?this|your[-_]|example|redacted|not[-_]a[-_]|dummy|sample|fixture|xxxx)/i;
/** Template expressions are not literal credentials. */
const TEMPLATE_VALUE = /^(?:\$\{|<[^>]*>|\{\{)/;

function sha(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function redactFinding(file, line, name, value) {
  return {
    file,
    line,
    pattern: name,
    length: value.length,
    prefix: value.slice(0, 4).replace(/[^A-Za-z0-9]/g, "?"),
    digest: sha(value),
  };
}

function looksRandom(value) {
  if (/^[a-z]+(?:-[a-z]+){2,}$/i.test(value)) return false; // kebab placeholder
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return value.length >= 24 && classes >= 2;
}

function scanText(file, text, findings) {
  const genericAllowed = !GENERIC_SKIP.test(file);
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line || line.length > 8000) return;
    for (const pattern of STRONG) {
      const match = pattern.re.exec(line);
      if (!match) continue;
      const value = match[0];
      if (PLACEHOLDER_VALUE.test(value) || TEMPLATE_VALUE.test(value)) continue;
      findings.push(redactFinding(file, index + 1, pattern.name, value));
    }
    if (genericAllowed) {
      const match = GENERIC.re.exec(line);
      if (match && looksRandom(match[1]) && !PLACEHOLDER_VALUE.test(match[1]) && !TEMPLATE_VALUE.test(match[1])) {
        findings.push(redactFinding(file, index + 1, GENERIC.name, match[1]));
      }
    }
  });
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !SKIP_PATHS.some((re) => re.test(file)));
}

function stagedFindings(findings) {
  const files = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !SKIP_PATHS.some((re) => re.test(file)));

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4_000_000) continue;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue; // binary
    scanText(file, buffer.toString("utf8"), findings);
  }
}

function workingTreeFindings(findings) {
  const files = trackedFiles();
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 4_000_000) continue;
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue;
    scanText(file, buffer.toString("utf8"), findings);
  }
}

function historyFindings(findings) {
  const commits = execFileSync("git", ["rev-list", "--all"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
  const seen = new Set();
  for (const commit of commits) {
    let diff = "";
    try {
      diff = execFileSync("git", ["show", "--format=", "--unified=0", "--no-color", commit], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    let current = "";
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++ b/")) {
        current = line.slice(6);
        continue;
      }
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      if (!current || SKIP_PATHS.some((re) => re.test(current))) continue;
      const local = [];
      scanText(current, line.slice(1), local);
      for (const finding of local) {
        const key = `${finding.pattern}:${finding.digest}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ ...finding, commit, location: "history" });
      }
    }
  }
}

const findings = [];
if (HISTORY) {
  historyFindings(findings);
} else {
  workingTreeFindings(findings);
  stagedFindings(findings);
}

const unique = [];
const seen = new Set();
for (const finding of findings) {
  const key = `${finding.file}:${finding.line}:${finding.pattern}:${finding.digest}`;
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(finding);
}

if (unique.length > 0) {
  console.error(`Secret scan failed: ${unique.length} finding(s). Values are intentionally not printed.`);
  for (const finding of unique) {
    const where = finding.commit ? `${finding.file} (commit ${finding.commit.slice(0, 8)})` : `${finding.file}:${finding.line}`;
    console.error(
      `  ${where}: possible ${finding.pattern} — len=${finding.length} prefix=${finding.prefix}… sha256=${finding.digest}`,
    );
  }
  console.error("Remove the value, rotate the credential, and purge it from history if it was committed.");
  process.exit(1);
}

const scope = HISTORY ? "Git history and working tree" : STAGED ? "staged files" : "tracked files";
console.log(`Secret scan passed: no credential-shaped values in ${scope}.`);
