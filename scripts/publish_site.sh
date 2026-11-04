#!/usr/bin/env bash
# Publish ./site to the gh-pages branch as a single commit with no history.
#
#   scripts/publish_site.sh <remote-url> <message>
#
# Each run replaces gh-pages entirely, so the branch never grows beyond one day's site
# (the dated archive lives inside that tree, pruned by assemble_site.sh).
set -euo pipefail

REMOTE="${1:?remote url}"
MSG="${2:-Update briefing}"

cd site
rm -rf .git
git init -q -b gh-pages
git config user.name "github-actions[bot]"
git config user.email "41898333+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -q -m "$MSG"
git push -q -f "$REMOTE" gh-pages
echo "published $(git rev-parse --short HEAD) to gh-pages as a single commit"
