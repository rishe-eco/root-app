#!/usr/bin/env bash
#
# Builds the SPA here and installs it there, atomically.
#
#   ./deploy/release-web.sh root@203.0.113.10
#   ./deploy/release-web.sh root@203.0.113.10 /srv/root
#
# Why the build happens on your machine: `vite build` plus `tsc` is the step
# most likely to exhaust a small VPS's memory, and its output is static files
# that need no runtime. The API is the opposite — it is built on the server, by
# Docker, because that is where it runs.
#
# Why a release directory and not rsync into place: rsync mutates the live
# directory in flight. For those seconds the site serves a new index.html
# naming assets that have not arrived, or an old one whose assets were just
# deleted — a white screen for whoever loads the page right then. Here the
# upload lands somewhere nobody is looking, and a single rename makes it live.
#
# It also buys two things for free: `current` records which commit is
# deployed, and the previous release is still on disk to roll back to.
set -euo pipefail

TARGET="${1:-}"
REMOTE_ROOT="${2:-/srv/root}"
KEEP="${KEEP:-5}"   # old releases retained, plus whichever one is live

if [[ -z "$TARGET" ]]; then
  echo "usage: $0 user@host [remote-root]   (default remote-root: /srv/root)" >&2
  exit 64
fi

cd "$(dirname "$0")/.."

# The release is named after the commit, so the name has to be true. A dirty
# tree would put unversioned code behind a version number, and the whole point
# of naming releases is being able to answer "what is running?".
if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "${ALLOW_DIRTY:-}" != "1" ]]; then
    echo "error: working tree is dirty — the release name would be a lie." >&2
    echo "       commit first, or re-run with ALLOW_DIRTY=1 to override." >&2
    exit 1
  fi
  echo "warning: dirty tree, releasing anyway (ALLOW_DIRTY=1)" >&2
fi

SHA="$(git rev-parse --short HEAD)"
STAMP="$(date -u +%Y%m%d%H%M%S)"
RELEASE="${STAMP}-${SHA}"   # sorts chronologically, still says which commit

echo "› building $SHA"
# VITE_GRAPHQL_URL is deliberately not set. The client falls back to the
# relative /graphql, which host Nginx serves from the same origin — and it must
# stay same-origin, or the httpOnly SameSite=Lax session cookie is dropped by
# the browser and everyone silently appears logged out.
npm ci
npm run build --workspace=apps/web

if [[ ! -f apps/web/dist/index.html ]]; then
  echo "error: build produced no apps/web/dist/index.html" >&2
  exit 1
fi

echo "› uploading to $TARGET:$REMOTE_ROOT/releases/$RELEASE"
# Piped straight into tar on the far side: no temp file to clean up, and the
# directory does not exist until its contents are already on the way.
tar -czf - -C apps/web/dist . | ssh "$TARGET" "
  set -euo pipefail
  mkdir -p '$REMOTE_ROOT/releases/$RELEASE'
  tar -xzf - -C '$REMOTE_ROOT/releases/$RELEASE'
"

echo "› going live"
ssh "$TARGET" "
  set -euo pipefail
  cd '$REMOTE_ROOT'

  # Nginx resolves \$root per request, so a swap needs no reload. mv -T renames
  # over the existing symlink in one syscall — the difference between this and
  # 'rm current && ln -s' is a window where the site has no document root.
  ln -sfn 'releases/$RELEASE' .current.tmp
  mv -T .current.tmp current

  # Keep the recent ones. Old releases cost nothing and are what a rollback
  # rolls back to; they also keep a stale cached index.html resolving.
  #
  # The live one is excluded explicitly rather than trusted to be newest —
  # after a rollback it is not, and pruning the directory Nginx is serving
  # would take the site down for a cache-miss.
  live=\"\$(basename \"\$(readlink current)\")\"
  ls -1 releases 2>/dev/null | sort | grep -vx \"\$live\" | head -n -$KEEP \
    | while read -r old; do rm -rf \"releases/\$old\"; done
  echo \"  live: \$(readlink current)\"
"

cat <<EOF

Released $RELEASE.

  Roll back:  ssh $TARGET 'cd $REMOTE_ROOT && ls releases/'
              ssh $TARGET 'cd $REMOTE_ROOT && ln -sfn releases/<name> .current.tmp && mv -T .current.tmp current'

The API is deployed separately, on the server:
  ssh $TARGET 'cd $REMOTE_ROOT/app && git pull && docker compose -f docker-compose.prod.yml up -d --build'
EOF
