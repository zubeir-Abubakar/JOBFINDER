#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

/**
 * Bounded source secret scan. It inspects committed source and deployment
 * templates, never the live `.env`, data directory, backups, dependencies or
 * build output. It deliberately does not print a matching value.
 */

const roots = ["app", "lib", "components", "scripts", "deploy", "proxy.ts", "instrumentation.ts", "next.config.ts"];
const skip = new Set(["node_modules", ".next", ".git", "data", "backups", "coverage"]);
const allow = /(process\.env|example|placeholder|replace|configured|test|fixture|dummy|sample|your[_-]?|<[^>]+>)/i;
const patterns = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "GitHub token", re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "hard-coded credential",
    re: /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']([A-Za-z0-9_+/=-]{20,})["']/i,
  },
];

const findings = [];
function walk(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    if (skip.has(path.basename(target))) return;
    for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
    return;
  }
  if (!/\.(?:[cm]?[jt]sx?|json|md|example|conf|service|timer|yml|yaml)$/.test(target)) return;
  const lines = fs.readFileSync(target, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (allow.test(line)) return;
    for (const pattern of patterns) {
      if (pattern.re.test(line)) findings.push({ file: target, line: index + 1, pattern: pattern.name });
    }
  });
}

for (const root of roots) walk(path.resolve(root));

if (findings.length > 0) {
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: possible ${finding.pattern}`);
  console.error(`Secret scan failed with ${findings.length} finding(s). Values were not printed.`);
  process.exit(1);
}
console.log("Secret scan passed: no credential-shaped values in source, scripts or deployment templates.");
