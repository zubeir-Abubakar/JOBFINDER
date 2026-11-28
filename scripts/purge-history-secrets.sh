#!/usr/bin/env bash
# Purge credential-bearing files from local Git history.
#
# This script is PREPARED, NOT RUN. Rewriting history changes every commit id
# from the first touched commit onward. Do not run it on a shared branch and do
# not force-push without explicit owner authorisation.
#
#   1. Read the audit report for the affected paths.
#   2. Rotate every credential first. A purge is not a substitute for rotation:
#      assume the value was public the moment it was pushed.
#   3. Run this script on a scratch clone, verify, then decide about the remote.
#
# Usage:
#   scripts/purge-history-secrets.sh            # dry run on a scratch clone
#   APPLY=1 scripts/purge-history-secrets.sh    # rewrite THIS clone (no push)
set -euo pipefail

# .tmp/.checkpoints held saved employer pages and diagnostic dumps. The
# artifacts/backups directory held real SQLite backups (users, sessions, Gmail
# accounts, documents, applications) committed by accident.
PATHS=(.tmp .checkpoints artifacts/backups)
SCRATCH="${SCRATCH_DIR:-$(mktemp -d)}"
mkdir -p "$SCRATCH"
# filter-branch runs its filters from a temporary directory, so every path
# handed to it must be absolute.
SCRATCH="$(cd "$SCRATCH" && pwd -P)"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not inside a Git repository." >&2
  exit 1
fi

echo "Repository : $(git rev-parse --show-toplevel)"
echo "Branch     : $(git rev-parse --abbrev-ref HEAD)"
echo "Paths      : ${PATHS[*]}"
echo "Scratch    : $SCRATCH"
echo

# Only a real rewrite needs a clean tree. A dry run deliberately works from
# the last commit, so pending edits are irrelevant to it.
if [ "${APPLY:-0}" = "1" ] && { ! git diff --quiet || ! git diff --cached --quiet; }; then
  echo "Refusing to continue: the working tree has uncommitted changes." >&2
  echo "Commit or stash them first so nothing is lost by the rewrite." >&2
  exit 1
fi

# Capture the scanner from the CURRENT repository before moving into the clone.
# The clone holds the old committed scanner, so verifying with that copy would
# reproduce the exact blind spot that let the key through in the first place.
ORIG_ROOT="$(git rev-parse --show-toplevel)"
SCANNER="$ORIG_ROOT/scripts/secret-scan.mjs"

if [ -f "$SCANNER" ]; then
  echo "==> Baseline: the hardened scanner against the un-purged clone"
  git clone --no-hardlinks --quiet "$ORIG_ROOT" "$SCRATCH/baseline"
  if ( cd "$SCRATCH/baseline" && node "$SCANNER" --history >/dev/null 2>&1 ); then
    echo "    NOTE: no history finding before the purge; the purge is still needed for the files themselves."
  else
    echo "    Confirmed: the un-purged history contains credential-shaped values."
  fi
  rm -rf "$SCRATCH/baseline"
fi

PATHS_FILE="$SCRATCH/paths.txt"
printf '%s\n' "${PATHS[@]}" >"$PATHS_FILE"

# Literal values that live outside the purged directories (for example a
# credential-shaped test fixture) are rewritten across every commit. The values
# are collected into a file and never printed to the terminal or a report.
EXPR_FILE="$SCRATCH/replacements.json"
STRONG_RE='(AIza[0-9A-Za-z_-]{35}|GOCSPX-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|re_[A-Za-z0-9_]{16,}|(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|sb[p]_[A-Za-z0-9_-]{20,})'
git log -p --all --no-color 2>/dev/null | grep -oE "$STRONG_RE" | sort -u >"$SCRATCH/values.txt" || true
node - "$SCRATCH/values.txt" "$EXPR_FILE" <<'NODE'
const fs = require("node:fs");
const [, , valuesPath, outPath] = process.argv;
const values = fs.existsSync(valuesPath)
  ? fs.readFileSync(valuesPath, "utf8").split("\n").filter(Boolean)
  : [];
fs.writeFileSync(outPath, JSON.stringify({ replacements: values.map((value) => [value, "***REMOVED***"]) }, null, 1));
console.log(`    ${values.length} literal value(s) will be replaced across history.`);
NODE

# git-filter-repo expressions file (literal==>replacement).
: >"$SCRATCH/expressions.txt"
node - "$EXPR_FILE" "$SCRATCH/expressions.txt" <<'NODE'
const fs = require("node:fs");
const [, , jsonPath, outPath] = process.argv;
const { replacements } = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
fs.writeFileSync(outPath, replacements.map(([a, b]) => `${a}==>${b}`).join("\n") + (replacements.length ? "\n" : ""));
NODE

echo "==> Cloning into the scratch directory"
git clone --no-hardlinks --quiet "$ORIG_ROOT" "$SCRATCH/repo"
cd "$SCRATCH/repo"

if command -v git-filter-repo >/dev/null 2>&1; then
  echo "==> Rewriting with git-filter-repo"
  git filter-repo --force --invert-paths --paths-from-file "$PATHS_FILE" --replace-text "$SCRATCH/expressions.txt"
else
  echo "==> git-filter-repo not found; using git filter-branch (slower, superseded tool)"
  FILTER='git rm -r --cached --ignore-unmatch '"$(printf '%s ' "${PATHS[@]}")"
  git filter-branch --force --index-filter "$FILTER" --prune-empty -- --all
  # A second index pass rewrites the remaining literal values. It never checks
  # out a tree, so it stays fast despite the committed screenshots.
  git filter-branch --force --index-filter \
    "node '$ORIG_ROOT/scripts/purge-index.mjs' '$EXPR_FILE'" --prune-empty -- --all
  rm -rf .git/refs/original
fi

echo
echo "==> Verifying the rewrite removed the paths from every commit"
REMAINING="$(git log --all --pretty=format: --name-only | sort -u | grep -E '^\.(tmp|checkpoints)/' || true)"
if [ -n "$REMAINING" ]; then
  echo "FAILED: paths still present:" >&2
  echo "$REMAINING" | head >&2
  exit 1
fi
echo "OK: no tracked .tmp/ or .checkpoints/ file remains in history."

echo
echo "==> Verifying no credential-shaped value remains in history (hardened scanner)"
node "$SCANNER" --history \
  || { echo "FAILED: the history scan still reports a finding." >&2; exit 1; }

echo
if [ "${APPLY:-0}" != "1" ]; then
  cat <<EOF
Scratch verification complete. Nothing in your working repository changed.

To rewrite the real repository (still no push, no remote change):

  APPLY=1 scripts/purge-history-secrets.sh

That step must only be run after the credential has been revoked, and a push
still requires explicit authorisation because it rewrites published history:

  git push --force-with-lease origin main

Scratch clone kept at: $SCRATCH/repo
EOF
  exit 0
fi

echo "==> Applying the rewrite to the working repository"
# Must be the ORIGINAL root: the dry run above left us inside $SCRATCH/repo, so
# `git rev-parse --show-toplevel` here would return the scratch clone.
cd "$ORIG_ROOT"
if [ "$(git rev-parse --show-toplevel)" != "$ORIG_ROOT" ]; then
  echo "Refusing to continue: could not return to the working repository." >&2
  exit 1
fi
BACKUP="$(mktemp -d)/pre-purge.bundle"
git bundle create "$BACKUP" --all
echo "Safety bundle written to: $BACKUP"

graft() {
  if command -v git-filter-repo >/dev/null 2>&1; then
    git filter-repo --force --invert-paths --paths-from-file "$PATHS_FILE" --replace-text "$SCRATCH/expressions.txt"
  else
    # filter-branch runs its index filters from .git-rewrite/t, so both the
    # script and the replacements file must be absolute paths.
    REMOVE="git rm -r --cached --ignore-unmatch $(printf '%s ' "${PATHS[@]}")"
    git filter-branch --force --index-filter "$REMOVE" --prune-empty -- --all
    git filter-branch --force --index-filter \
      "node '$ORIG_ROOT/scripts/purge-index.mjs' '$EXPR_FILE'" --prune-empty -- --all
    rm -rf .git/refs/original
  fi
}
graft

echo "Rewrite applied locally. Nothing was pushed."
echo "Review with: git log --oneline --stat -5"
