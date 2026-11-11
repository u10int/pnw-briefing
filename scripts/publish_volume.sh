#!/usr/bin/env bash
# Add freshly built 3D volumes to the published site, as a new single commit on gh-pages.
#
#   scripts/publish_volume.sh <volume-dir> <cycle> <remote-url>
#
# <volume-dir> holds volume.json and volume/. The volumes go in only while the published edition
# is still <cycle>: if a newer edition went out meanwhile, its own volume run follows, so this one
# stops. The push is conditional on gh-pages not having moved since it was read (a briefing
# publishing at the same moment wins, and this tries again on top of it).
set -euo pipefail

VOL="${1:?volume dir}"
CYCLE="${2:?cycle}"
REMOTE="${3:?remote url}"
SITE="site"

for attempt in 1 2 3; do
  rm -rf "$SITE" && mkdir -p "$SITE"
  git fetch -q --depth=1 origin gh-pages
  BASE=$(git rev-parse FETCH_HEAD)
  git archive FETCH_HEAD | tar -x -C "$SITE"
  PUB=$(python3 -c "import json,sys; print((json.load(open(sys.argv[1])).get('meta') or {}).get('cycle',''))" "$SITE/data/briefing.json" 2>/dev/null || true)
  # meta.cycle is like 2026-11-11T12:00Z; the workflow's cycle like 2026-11-11T12Z
  if [ "${PUB/:00Z/Z}" != "$CYCLE" ]; then
    echo "the published edition is ${PUB:-unknown}, not $CYCLE; leaving it alone"
    exit 0
  fi
  rm -rf "$SITE/data/volume" "$SITE/data/volume.json"
  cp -r "$VOL/volume.json" "$VOL/volume" "$SITE/data/"
  echo "adding $(ls "$SITE/data/volume" | wc -l) volume files ($(du -sh "$SITE/data/volume" | cut -f1))"
  (
    cd "$SITE"
    rm -rf .git
    git init -q -b gh-pages
    git config user.name "github-actions[bot]"
    git config user.email "41898333+github-actions[bot]@users.noreply.github.com"
    git add -A
    git commit -q -m "3D volumes $CYCLE"
    git push -q --force-with-lease="gh-pages:$BASE" "$REMOTE" gh-pages
  ) && { echo "published the $CYCLE volumes"; exit 0; }
  echo "gh-pages moved while publishing; trying again"
  sleep 10
done
echo "could not publish the volumes" >&2
exit 1
