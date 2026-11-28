#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { strongValues } from "./secret-patterns.mjs";

/**
 * Builds the `git filter-branch --replace-text` value list from a `git log -p`
 * stream. Values come from `scripts/secret-patterns.mjs`, the same definition
 * the scanner uses, so an ordinary identifier cannot be mistaken for a key.
 *
 * Usage: git log -p --all | node scripts/purge-values.mjs <replacements.json>
 * Only a count is printed; no value is ever written to stdout.
 */

const outPath = process.argv[2];
if (!outPath) {
  console.error("purge-values: an output path is required.");
  process.exit(1);
}

const patch = readFileSync(0, "utf8");
const values = [...new Set(strongValues(patch))].sort();
writeFileSync(
  outPath,
  JSON.stringify({ replacements: values.map((value) => [value, "***REMOVED***"]) }, null, 1),
);
console.log(`    ${values.length} literal value(s) will be replaced across history.`);
