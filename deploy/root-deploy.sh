#!/usr/bin/env bash
# The reference copy of /usr/local/sbin/root-deploy: the one script CI's deploy user may run, as
# root, through sudo, with no arguments. A push to main reaches it over SSH (deploy/README.md,
# "Server setup for CI").
#
# Its input is the web build, on stdin: a gzipped tar holding `COMMIT` (the 40-hex commit the
# runner built) and `web/` (that commit's apps/web/dist). The runner builds the SPA because
# `vite build` is the step most likely to exhaust this box's memory, the same reason
# release-web.sh builds on your machine. The box then deploys exactly that commit, never a newer
# tip, so the API and the web always come from one commit:
#
#   read the stream into releases/.incoming-*, fast-forward the checkout to COMMIT, dump the
#   database if the commit adds a migration, build the API image here, `up -d --wait`, `nginx -t`,
#   swap `current` to the new release, then run deploy/checks.sh as an unprivileged user.
#
# It never changes Nginx, the compose file, .env or itself. If any of them changed it stops
# before it changes anything, and the founder does that part by hand (deploy/README.md).
#
# Exit codes
#   0  deployed, every check passed
#   2  stopped, and nothing was changed: the lock is held, no build came in, the tree is dirty,
#      the commit is not on main or is older than the checkout, or a file this script never
#      installs changed (README: "What each exit code means")
#   1  failed after the checkout or the containers may have changed; the site is left as it is
#      (no rollback: migrations run at boot, so old code against a migrated database is worse)
#
# Nothing here prints a secret, because the log of the run is public. It never sources .env, never
# prints a line of it, and never traces its commands.
set -euo pipefail

# ── Overrides, for the test harness only ──
# Every path and command the script takes from its environment is in this block. On the box
# sudo's env_reset strips the deploy user's environment, so none of these can be set from outside
# the SSH session; the defaults below are what runs there.
ROOT="${ROOTAPP_ROOT:-/opt/stacks/root}"
DIR="${ROOTAPP_DIR:-$ROOT/app}"
REPO_URL="${ROOTAPP_REPO_URL:-https://github.com/rishe-eco/root-app.git}"
LOCK="${ROOTAPP_LOCK:-/run/root-deploy.lock}"
INSTALLED="${ROOTAPP_INSTALLED:-/usr/local/sbin/root-deploy}"
CONTAINER="${ROOTAPP_CONTAINER:-root-api-1}"
CHECK_USER="${ROOTAPP_CHECK_USER:-nobody}"
FLOCK="${ROOTAPP_FLOCK:-flock}"
DOCKER="${ROOTAPP_DOCKER:-docker}"
NGINX="${ROOTAPP_NGINX:-nginx}"
RUNUSER="${ROOTAPP_RUNUSER:-runuser}"
BASH_BIN="${ROOTAPP_BASH:-bash}"
# ── end of overrides ──

COMPOSE=(-f docker-compose.prod.yml)
HEALTH_WAIT=180
KEEP_RELEASES=5   # old web releases kept, plus the live one (as release-web.sh)
KEEP_DUMPS=5      # pre-migration dumps kept
MAX_STREAM=200M   # a web build is a few MB; anything near this is not one
# Compose and git never ask a question: a prompt would hang a job with no terminal.
export GIT_TERMINAL_PROMPT=0

die() {
  echo "FAILED (exit 1): $1" >&2
  exit 1
}

halt() {
  echo "STOP (exit 2, nothing changed): $1"
  echo "  By hand: $2"
  exit 2
}

# prune <dir> <keep> <pattern> <spare> <remove command...>: removes all but the newest <keep> names
# matching <pattern>, never <spare>. Names start with a UTC stamp, so sorting them sorts by age, and
# a dot name (an incoming build) never matches. Process substitution, so finding nothing to prune
# is not a failure under pipefail.
prune() {
  local dir=$1 keep=$2 pattern=$3 spare=$4 names i
  shift 4
  mapfile -t names < <(find "$dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | grep -E "$pattern" | grep -vxF -- "${spare:-/}" | sort)
  for ((i = 0; i < ${#names[@]} - keep; i++)); do
    "$@" "$dir/${names[i]}"
  done
}

# ── 1. The lock ──
# One deploy at a time. The file is in /run, which only root can write, not in the world-writable
# /run/lock, where another account on this shared box could plant it first and hold it.
exec 9>"$LOCK"
if ! "$FLOCK" -n 9; then
  halt "another deploy holds $LOCK" "wait for it to finish, then re-run the job"
fi

# The checkout and the releases belong to the account that cloned them (README, First time), and
# git refuses a repository another user owns. So git and tar run as that owner, never as root:
# nothing from the stream is ever unpacked with root's rights.
OWNER=$(stat -c %U "$DIR") || halt "no checkout at $DIR" "clone it (README, First time)"
# With the owner's own HOME: sudo leaves root's, which git would try, and fail, to read.
OWNER_HOME=$(getent passwd "$OWNER" | cut -d: -f6)
as_owner() { "$RUNUSER" -u "$OWNER" -- env HOME="${OWNER_HOME:-/nonexistent}" "$@"; }
git_() { as_owner git -C "$DIR" "$@"; }

# ── 2. The web build, from stdin ──
# Read whole before anything else, so a half-sent stream changes nothing. It lands under releases/
# with a dot name, which nothing serves and the prune below never matches.
if [ -t 0 ]; then
  halt "no web build on stdin (this script is run by CI, which sends one)" \
    "re-run the job on GitHub (Actions, Run workflow); to deploy without CI, see README, Deploying by hand"
fi
as_owner mkdir -p "$ROOT/releases"
INCOMING=$(as_owner mktemp -d "$ROOT/releases/.incoming-XXXXXX")
trap 'rm -rf "$INCOMING"' EXIT
head -c "$MAX_STREAM" | as_owner tar -xzf - --no-same-owner --no-same-permissions -C "$INCOMING" \
  || halt "the web build on stdin is not a gzipped tar" "re-run the job; if it repeats, read the job's Deploy step"
[ -z "$(head -c 1)" ] || halt "the web build on stdin is over $MAX_STREAM" "read the job's build step"

SHA=$(tr -d '\n' < "$INCOMING/COMMIT" 2>/dev/null || true)
case "$SHA" in
  *[!0-9a-f]* | "") halt "the stream's COMMIT is missing or not a commit id" "re-run the job" ;;
esac
[ "${#SHA}" = 40 ] || halt "the stream's COMMIT is not a full 40-hex commit id" "re-run the job"
[ -f "$INCOMING/web/index.html" ] || halt "the stream has no web/index.html" "read the job's build step"
SHORT=${SHA:0:7}
echo "web build for $SHA received"

cd "$DIR"

# ── 3. A clean tree ──
# Untracked files (.env and its neighbours) are ignored on purpose: they are not the repository's,
# and a merge that would overwrite one refuses on its own.
if [ -n "$(git_ status --porcelain --untracked-files=no)" ]; then
  halt "the checkout in $DIR has uncommitted changes" \
    "look at \`git status\` there, then commit, stash or discard them, and re-run the job"
fi

# ── 4. Fetch, and place the commit ──
# Anonymous HTTPS by URL, so the clone's own remote (and whatever key it needs) is never used.
git_ fetch --quiet "$REPO_URL" main \
  || halt "git fetch $REPO_URL main failed" "check the box's network, then re-run the job"
TIP=$(git_ rev-parse 'FETCH_HEAD^{commit}')
OLD=$(git_ rev-parse HEAD)
if ! { git_ cat-file -e "$SHA^{commit}" 2>/dev/null && git_ merge-base --is-ancestor "$SHA" "$TIP"; }; then
  halt "$SHA is not on main" "only main deploys; re-run the job from main"
fi
if ! git_ merge-base --is-ancestor "$OLD" "$SHA"; then
  if git_ merge-base --is-ancestor "$SHA" "$OLD"; then
    halt "$SHA is older than the checkout's $OLD (a re-run of an old job)" \
      "re-run the newest job, or Run workflow on main; to go back, see README, Rolling back by hand"
  fi
  halt "$SHA is not a fast-forward of the checkout's $OLD (history was rewritten, or the checkout moved by hand)" \
    "look at \`git log\` in $DIR against main, and decide there"
fi

# ── 5. The files this script never changes ──
# Each is compared between what is checked out and the commit, so a by-hand step that also pulls
# (README, What each exit code means) makes the re-run pass. Nginx's live files can't be compared
# with the repository's: certbot rewrote the site and the domain was put in by hand.
STOPPED=""
note() { STOPPED="$STOPPED"$'\n'"STOP (exit 2, nothing changed): $1"$'\n'"  By hand: $2"; }
git_ diff --quiet "$OLD" "$SHA" -- deploy/nginx \
  || note "deploy/nginx/ changed between $OLD and $SHA" \
    "bring the change into the live Nginx files (README, What each exit code means), then re-run the job"
git_ diff --quiet "$OLD" "$SHA" -- docker-compose.prod.yml \
  || note "docker-compose.prod.yml changed between $OLD and $SHA" \
    "deploy the API by hand (README, Deploying by hand), then re-run the job"
git_ diff --quiet "$OLD" "$SHA" -- .env.production.example \
  || note ".env.production.example changed between $OLD and $SHA" \
    "add what the new lines need to $DIR/.env, pull the checkout, then re-run the job"
git_ show "$SHA:deploy/root-deploy.sh" | cmp -s - "$INSTALLED" \
  || note "deploy/root-deploy.sh in $SHA differs from the installed $INSTALLED" \
    "pull the checkout, reinstall the script (README, Server setup for CI, step 5), then re-run the job"
if [ -n "$STOPPED" ]; then
  echo "${STOPPED#$'\n'}"
  exit 2
fi

# ── 6. Move the checkout ──
# Already there (a re-run): the rest still runs. The build is cached and `up -d` changes nothing,
# so a re-run gives a verdict on what is running, and an earlier failed build can't pass for a
# deploy.
if [ "$OLD" != "$SHA" ]; then
  git_ merge --quiet --ff-only "$SHA" || die "step checkout: git merge --ff-only $SHA"
  echo "checkout moved: $OLD -> $SHA"
else
  echo "checkout already at $SHA"
fi

# ── 7. A dump, when the commit brings a migration ──
# The API migrates at boot and there is no going back after. The dump runs inside the db
# container, from its own environment, so this script never learns the database's password.
if ! git_ diff --quiet "$OLD" "$SHA" -- apps/api/prisma/migrations; then
  mkdir -p "$ROOT/backups" && chmod 0700 "$ROOT/backups"
  DUMP="$ROOT/backups/pre-migrate-$(date -u +%Y%m%d%H%M%S)-$SHORT.sql.gz"
  # shellcheck disable=SC2016 # expanded by the container's shell, from its own environment
  ( umask 077
    "$DOCKER" compose "${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
      | gzip > "$DUMP" ) \
    || { rm -f "$DUMP"; die "step dump: pg_dump before the migration failed; nothing was built"; }
  [ -s "$DUMP" ] || { rm -f "$DUMP"; die "step dump: the pre-migration dump is empty; nothing was built"; }
  echo "database dumped to $DUMP"
  prune "$ROOT/backups" "$KEEP_DUMPS" '^pre-migrate-' "" rm -f
fi

# ── 8. Build ──
# A failed build leaves the running container untouched: nothing is stopped before it succeeds.
"$DOCKER" compose "${COMPOSE[@]}" build api || die "step build: docker compose build failed; the old container keeps serving"

# ── 9. Up, and wait ──
"$DOCKER" compose "${COMPOSE[@]}" up -d --wait --wait-timeout "$HEALTH_WAIT" \
  || die "step up: docker compose up -d --wait did not finish within ${HEALTH_WAIT}s (\`docker compose logs api\` says why)"

# ── 10. Health, then Nginx ──
HEALTH=$("$DOCKER" inspect --format '{{.State.Health.Status}}' "$CONTAINER") \
  || die "step health: docker inspect $CONTAINER failed"
[ "$HEALTH" = healthy ] || die "step health: $CONTAINER is '$HEALTH', not healthy"
"$NGINX" -t || die "step nginx: nginx -t failed (this script only reads it, and never reloads)"

# ── 11. The web release ──
# The same swap as release-web.sh: one rename makes it live, Nginx resolves `current` per request,
# and the live release is never pruned, even after a rollback made it not the newest.
RELEASE="$(date -u +%Y%m%d%H%M%S)-$SHORT"
# Two runs within one second (a quick re-run) would share the name.
if [ -e "$ROOT/releases/$RELEASE" ]; then RELEASE="$RELEASE-$$"; fi
as_owner chmod 0755 "$INCOMING/web"
as_owner mv -T "$INCOMING/web" "$ROOT/releases/$RELEASE" || die "step web: could not place releases/$RELEASE"
as_owner ln -sfn "releases/$RELEASE" "$ROOT/.current.tmp" || die "step web: could not make the link"
as_owner mv -T "$ROOT/.current.tmp" "$ROOT/current" || die "step web: could not swap current"
echo "web live: releases/$RELEASE"
prune "$ROOT/releases" "$KEEP_RELEASES" '^[0-9]' "$(basename "$(readlink "$ROOT/current")")" as_owner rm -rf

# ── 12. The checks, as an unprivileged user ──
# Repository code runs here, so it runs without any right of its own. They live in the repo, so a
# new check needs no reinstall of this script.
"$RUNUSER" -u "$CHECK_USER" -- "$BASH_BIN" "$DIR/deploy/checks.sh" "$ROOT/current" \
  || die "step checks: deploy/checks.sh failed (see the FAILED line above); the site is left on the new release"

# ── 13. The verdict ──
echo "DEPLOYED $(git_ rev-parse HEAD)"
