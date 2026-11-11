#!/usr/bin/env bash
# Assemble the published site in ./site from today's build and the existing gh-pages contents.
#
#   scripts/assemble_site.sh <build-dir> <date> <cycle> [mark]
#   e.g. scripts/assemble_site.sh web/dist 2026-11-07 2026-11-07T18Z mark
#
# - Starts from the current gh-pages tree (if any), so the dated archive carries over.
# - Replaces the latest page at the site root with this build.
# - Keeps one page per day in archive/<date>/ (without the hourly fields, which are large; the
#   latest page keeps them): the day's 12Z edition, or the first edition of the day when there
#   isn't one yet. Earlier days' archives feed the trends, verification and change views.
# - With "mark", records the edition as archive/editions/<cycle>.json (its briefing.json), which
#   the workflow's gate checks so each cycle runs once, and which the same cycle's edition the
#   next day compares against. Edition files older than KEEP_EDITION_DAYS go.
# - Prunes: archive pages older than 60 days; GeoTIFFs in archive pages older than 14 days.
# - Keeps the published 3D volumes (data/volume*) when the build has none: the volume workflow
#   adds them after the briefing is out (scripts/publish_volume.sh).
# - Rebuilds archive/index.html.
#
# Publishing ./site as a single fresh commit (see publish_site.sh) keeps gh-pages history from
# accumulating every day's binary files.
set -euo pipefail

BUILD="${1:?build dir}"
DATE="${2:?date YYYY-MM-DD}"
CYCLE="${3:-}"
MARK="${4:-}"
SITE="site"
KEEP_DAYS=60
KEEP_EDITION_DAYS=4
KEEP_GRID_DAYS=14

rm -rf "$SITE" && mkdir -p "$SITE"

# 1. existing site, if gh-pages exists
if git fetch -q --depth=1 origin gh-pages 2>/dev/null; then
  git archive FETCH_HEAD | tar -x -C "$SITE"
  echo "started from the existing gh-pages tree"
else
  echo "no gh-pages branch yet; starting fresh"
fi

# 2. latest page at the root: remove everything except the archive, then copy today's build.
#    The 3D volumes come from their own workflow after the briefing is out, so the previous ones
#    stay until it replaces them (the page labels them with their model run).
KEEPV=$(mktemp -d)
if [ ! -e "$BUILD/data/volume.json" ] && [ -e "$SITE/data/volume.json" ]; then
  cp -r "$SITE/data/volume.json" "$KEEPV/"
  [ -d "$SITE/data/volume" ] && cp -r "$SITE/data/volume" "$KEEPV/"
fi
find "$SITE" -mindepth 1 -maxdepth 1 ! -name archive -exec rm -rf {} +
cp -r "$BUILD/." "$SITE/"
if [ -e "$KEEPV/volume.json" ]; then
  mkdir -p "$SITE/data" && cp -r "$KEEPV/." "$SITE/data/"
  echo "kept the previous 3D volumes until the volume workflow replaces them"
fi
rm -rf "$KEEPV"

# 3. the day's archive copy, without hourly fields or 3D volumes: the 12Z edition, or the first of the day
if [[ "$CYCLE" == *T12Z ]] || [ ! -e "$SITE/archive/$DATE/data/briefing.json" ]; then
  mkdir -p "$SITE/archive/$DATE"
  rm -rf "${SITE:?}/archive/$DATE/"*
  cp -r "$BUILD/." "$SITE/archive/$DATE/"
  rm -rf "$SITE/archive/$DATE/data/fields" "$SITE/archive/$DATE/data/fields.json" "$SITE/archive/$DATE/data/volume" "$SITE/archive/$DATE/data/volume.json"
  echo "archived as $DATE"
fi

# 4. edition record
mkdir -p "$SITE/archive/editions"
if [ "$MARK" = mark ] && [ -n "$CYCLE" ]; then
  cp "$BUILD/data/briefing.json" "$SITE/archive/editions/$CYCLE.json"
  echo "recorded the $CYCLE edition"
fi

# 5. pruning
cd "$SITE/archive"
ECUT=$(date -u -d "$DATE - $KEEP_EDITION_DAYS days" +%Y-%m-%d 2>/dev/null || echo "")
if [ -n "$ECUT" ]; then
  for f in editions/*; do
    [ -e "$f" ] || continue
    b=$(basename "$f")
    if [[ "${b:0:10}" < "$ECUT" ]]; then rm -f "$f"; fi
  done
fi
mapfile -t DAYS < <(ls -1d 20*/ 2>/dev/null | sed 's#/$##' | sort -r)
for i in "${!DAYS[@]}"; do
  d="${DAYS[$i]}"
  if (( i >= KEEP_DAYS )); then rm -rf "$d"; continue; fi
  # older archive pages never keep hourly fields; GeoTIFFs only for the most recent days
  rm -rf "$d/data/fields" "$d/data/fields.json" "$d/data/volume" "$d/data/volume.json"
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
