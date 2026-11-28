#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Rewrites literal credential-shaped values directly in the Git index.
 *
 * Used by scripts/purge-history-secrets.sh as a `git filter-branch
 * --index-filter` step. Unlike a --tree-filter it never checks out a working
 * tree, so rewriting a handful of commits takes seconds even with large
 * committed screenshots.
 *
 * Usage: node scripts/purge-index.mjs <patterns.json>
 * patterns.json: { "replacements": [["literal-value", "***REMOVED***"], ...] }
 *
 * Only counts are printed; no value is ever written to stdout.
 */

const patternsFile = process.argv[2];
if (!patternsFile) {
  console.error("purge-index: a patterns file is required.");
  process.exit(1);
}

const { replacements } = JSON.parse(readFileSync(patternsFile, "utf8"));
if (!Array.isArray(replacements) || replacements.length === 0) {
  process.exit(0);
}

const git = (args, input) =>
  execFileSync("git", args, {
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
  });

const files = git(["ls-files", "-z"])
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

let changed = 0;

for (const file of files) {
  // Only text-y paths are candidates; binary blobs cannot contain a literal
  // credential in any meaningful form.
  if (!/\.(?:[cm]?[jt]sx?|json|md|txt|html?|ya?ml|env|example|conf|log|sh|mjs)$/i.test(file)) continue;

  let original;
  try {
    original = git(["cat-file", "blob", `:${file}`]).toString("utf8");
  } catch {
    continue;
  }

  let updated = original;
  for (const [needle, replacement] of replacements) {
    if (!needle || !updated.includes(needle)) continue;
    updated = updated.split(needle).join(replacement);
  }
  if (updated === original) continue;

  const sha = git(["hash-object", "-w", "--stdin"], Buffer.from(updated, "utf8")).toString("utf8").trim();
  git(["update-index", "--cacheinfo", `100644,${sha},${file}`]);
  changed += 1;
}

console.log(`purge-index: rewrote ${changed} file(s) in this commit.`);
