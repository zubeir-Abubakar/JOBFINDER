#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Installs the local pre-commit secret scan.
 *
 * This is deliberately fail-safe: a missing .git directory (packaged install,
 * CI checkout with hooks disabled) must never break `npm install`, and an
 * existing hook that this project did not write is left untouched.
 */

const HOOK_MARKER = "# atw-secret-scan";
const HOOK_BODY = `#!/bin/sh
${HOOK_MARKER} - blocks a commit that contains a credential-shaped value.
# Bypass only for a verified false positive: git commit --no-verify
node scripts/secret-scan.mjs --staged || {
  echo ""
  echo "Commit blocked: the staged changes contain something that looks like a credential."
  echo "Remove the value, put it in .env, and rotate it if it was ever pushed."
  exit 1
}
`;

function readIfPresent(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const gitDir = path.join(process.cwd(), ".git");
  if (!existsSync(gitDir)) return;

  const hooksDir = path.join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-commit");

  if (existsSync(hookPath) && !readIfPresent(hookPath).includes(HOOK_MARKER)) {
    console.log("pre-commit hook already exists and was not created by this project; left unchanged.");
    return;
  }

  writeFileSync(hookPath, HOOK_BODY, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
  console.log("Installed pre-commit secret scan (.git/hooks/pre-commit).");
}

main();
