#!/usr/bin/env bash
# Assemble the published site in ./site from today's build and the existing gh-pages contents.
#
#   scripts/assemble_site.sh <build-dir> <date> [edition]   e.g. scripts/assemble_site.sh web/dist 2026-11-04 evening
#
# - Starts from the current gh-pages tree (if any), so the dated archive carries over.
# - Replaces the latest page at the site root with today's build.
# - Adds today's build to archive/<date>/, without the hourly fields (they're large; the
#   latest page keeps them).
# - Prunes: archive pages older than 60 days; GeoTIFFs in archive pages older than 14 days.
# - Records the edition (morning/evening) as archive/editions/<date>-<edition>, which the
#   workflow's gate checks so each edition runs once a day; markers older than KEEP_DAYS go.
# - Rebuilds archive/index.html.
#
# Publishing ./site as a single fresh commit (see publish_site.sh) keeps gh-pages history from
# accumulating every day's binary files.
set -euo pipefail

BUILD="${1:?build dir}"
DATE="${2:?date YYYY-MM-DD}"
EDITION="${3:-}"
SITE="site"
KEEP_DAYS=60
KEEP_GRID_DAYS=14

rm -rf "$SITE" && mkdir -p "$SITE"

# 1. existing site, if gh-pages exists
if git fetch -q --depth=1 origin gh-pages 2>/dev/null; then
  git archive FETCH_HEAD | tar -x -C "$SITE"
  echo "started from the existing gh-pages tree"
else
  echo "no gh-pages branch yet; starting fresh"
fi

# 2. latest page at the root: remove everything except the archive, then copy today's build
find "$SITE" -mindepth 1 -maxdepth 1 ! -name archive -exec rm -rf {} +
cp -r "$BUILD/." "$SITE/"

# 3. today's archive copy, without hourly fields
mkdir -p "$SITE/archive/$DATE"
rm -rf "${SITE:?}/archive/$DATE/"*
cp -r "$BUILD/." "$SITE/archive/$DATE/"
rm -rf "$SITE/archive/$DATE/data/fields" "$SITE/archive/$DATE/data/fields.json"

# 4. edition marker
mkdir -p "$SITE/archive/editions"
if [ -n "$EDITION" ]; then
  date -u +%Y-%m-%dT%H:%M:%SZ > "$SITE/archive/editions/$DATE-$EDITION"
  echo "marked the $EDITION edition of $DATE"
fi

# 5. pruning
cd "$SITE/archive"
CUTOFF=$(date -u -d "$DATE - $KEEP_DAYS days" +%Y-%m-%d 2>/dev/null || echo "")
if [ -n "$CUTOFF" ]; then
  for f in editions/*; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    if [[ "${b:0:10}" < "$CUTOFF" ]]; then rm -f "$f"; fi
  done
fi
mapfile -t DAYS < <(ls -1d 20*/ 2>/dev/null | sed 's#/$##' | sort -r)
for i in "${!DAYS[@]}"; do
  d="${DAYS[$i]}"
  if (( i >= KEEP_DAYS )); then rm -rf "$d"; continue; fi
  # older archive pages never keep hourly fields; GeoTIFFs only for the most recent days
  rm -rf "$d/data/fields" "$d/data/fields.json"
  if (( i >= KEEP_GRID_DAYS )); then rm -rf "$d/data/cogs"; fi
done

# 6. archive listing
{
  echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  echo '<title>Past briefings</title><style>body{font:15px/1.6 Inter,system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1b1f24;background:#f8f9fb}a{color:#2a78d6}</style>'
  echo '<h1>Past briefings</h1><p><a href="../">Latest</a></p><ul>'
  for d in $(ls -1d 20*/ 2>/dev/null | sed 's#/$##' | sort -r); do echo "<li><a href=\"$d/\">$d</a></li>"; done
  echo '</ul>'
} > index.html
cd - >/dev/null

touch "$SITE/.nojekyll"
echo "site assembled: $(du -sh "$SITE" | cut -f1), $(ls -1d "$SITE"/archive/20*/ 2>/dev/null | wc -l) archived days"
