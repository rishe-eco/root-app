#!/usr/bin/env bash
# Runs deploy/root-deploy.sh against a scratch box: a bare "origin", a checkout, a web root, and
# stubs for flock, docker, nginx and runuser. Each case asserts the exit code, what the log says,
# and what changed on disk. CI runs it on every push (.github/workflows/deploy.yml); by hand:
#
#   bash deploy/test/root-deploy.test.sh
#
# It needs bash, git and GNU coreutils (Linux, or a Linux container on Windows: Git Bash's ln
# makes copies, not symlinks).
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/root-deploy.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# Out of the repository, so no git command here ever reads or touches it.
cd "$WORK"
PASS=0

# ── The scratch box ──

STUBS="$WORK/stubs"
mkdir -p "$STUBS"
# Each stub logs its argv to $WORK/calls, and fails when the case asks it to.
cat > "$STUBS/flock" <<'EOF'
#!/usr/bin/env bash
[ -z "${STUB_LOCK_HELD:-}" ]
EOF
cat > "$STUBS/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_CALLS"
case "$*" in
  *" build "* | *" build") [ -z "${STUB_BUILD_FAILS:-}" ] ;;
  *"exec -T db"*) echo "-- a dump of the database" ;;
  inspect*) echo "${STUB_HEALTH:-healthy}" ;;
  *) true ;;
esac
EOF
cat > "$STUBS/nginx" <<'EOF'
#!/usr/bin/env bash
echo "nginx $*" >> "$STUB_CALLS"
EOF
# runuser -u <user> -- <command...>: here, the same user.
cat > "$STUBS/runuser" <<'EOF'
#!/usr/bin/env bash
[ "$1" = -u ] && [ "$3" = -- ] || { echo "runuser stub: unexpected $*" >&2; exit 64; }
shift 3
exec "$@"
EOF
chmod +x "$STUBS"/*

export STUB_CALLS="$WORK/calls"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_NOSYSTEM=1 HOME="$WORK/home"
mkdir -p "$HOME"
git config --global init.defaultBranch main
git config --global advice.detachedHead false

ORIGIN="$WORK/origin.git"
SEED="$WORK/seed"
ROOT="$WORK/srv"
INSTALLED="$WORK/sbin/root-deploy"

# commit <message> <path> <content>: one commit on the seed's main, pushed to origin. Prints its id.
commit() {
  mkdir -p "$(dirname "$SEED/$2")"
  printf '%s\n' "$3" > "$SEED/$2"
  git -C "$SEED" add -A >/dev/null
  git -C "$SEED" commit -qm "$1"
  git -C "$SEED" push -q origin HEAD:main
  git -C "$SEED" rev-parse HEAD
}

fresh_box() {
  rm -rf "$ORIGIN" "$SEED" "$ROOT" "$WORK/sbin" "$STUB_CALLS"
  git init -q --bare "$ORIGIN"
  git init -q "$SEED"
  git -C "$SEED" remote add origin "$ORIGIN"
  mkdir -p "$SEED/deploy/nginx" "$SEED/apps/api/prisma/migrations/0001_init"
  cp "$SCRIPT" "$SEED/deploy/root-deploy.sh"
  # The checks, as the fixture's: they log what they were given, and fail on request.
  cat > "$SEED/deploy/checks.sh" <<'EOF'
echo "checks $*" >> "$STUB_CALLS"
[ -z "${STUB_CHECKS_FAIL:-}" ] || { echo "FAILED check_stub: asked to"; exit 1; }
EOF
  echo 'server {}' > "$SEED/deploy/nginx/root.conf"
  echo 'services: {}' > "$SEED/docker-compose.prod.yml"
  echo 'JWT_SECRET=' > "$SEED/.env.production.example"
  echo 'CREATE TABLE a ();' > "$SEED/apps/api/prisma/migrations/0001_init/migration.sql"
  BASE=$(commit "base" apps/api/src/index.ts "v1")
  mkdir -p "$ROOT" "$WORK/sbin"
  git clone -q "$ORIGIN" "$ROOT/app"
  cp "$SCRIPT" "$INSTALLED"
  : > "$STUB_CALLS"
}

# stream <sha> [index content]: the web build CI sends for that commit.
stream() {
  local pkg="$WORK/pkg"
  rm -rf "$pkg"
  mkdir -p "$pkg/web/assets"
  printf '%s\n' "$1" > "$pkg/COMMIT"
  printf '%s\n' "${2:-<html>$1</html>}" > "$pkg/web/index.html"
  echo "console.log(1)" > "$pkg/web/assets/index-abc.js"
  tar -czf "$WORK/web.tgz" -C "$pkg" COMMIT web
}

# deploy [stdin file]: runs the script as CI would. Sets OUT and CODE.
deploy() {
  set +e
  OUT=$(ROOTAPP_ROOT="$ROOT" ROOTAPP_REPO_URL="$ORIGIN" ROOTAPP_LOCK="$WORK/lock" \
    ROOTAPP_INSTALLED="$INSTALLED" ROOTAPP_CHECK_USER=nobody \
    ROOTAPP_FLOCK="$STUBS/flock" ROOTAPP_DOCKER="$STUBS/docker" ROOTAPP_NGINX="$STUBS/nginx" \
    ROOTAPP_RUNUSER="$STUBS/runuser" bash "$SCRIPT" < "${1:-$WORK/web.tgz}" 2>&1)
  CODE=$?
  set -e
}

# ── Assertions ──

CASE=""
bad() {
  echo "not ok - $CASE: $*"
  echo "--- output (exit $CODE) ---"
  echo "$OUT"
  echo "--- calls ---"
  cat "$STUB_CALLS" 2>/dev/null || true
  exit 1
}
expect_code() { [ "$CODE" = "$1" ] || bad "exit $CODE, expected $1"; }
expect_out() { grep -qF -- "$1" <<<"$OUT" || bad "output lacks: $1"; }
expect_called() { grep -qF -- "$1" "$STUB_CALLS" || bad "no call: $1"; }
expect_not_called() { ! grep -qF -- "$1" "$STUB_CALLS" || bad "unexpected call: $1"; }
expect_head() { [ "$(git -C "$ROOT/app" rev-parse HEAD)" = "$1" ] || bad "checkout is not at $1"; }
live() { basename "$(readlink "$ROOT/current" 2>/dev/null || echo none)"; }
expect_live_sha() { [[ "$(live)" == *-"${1:0:7}" ]] || bad "current is '$(live)', not a release of ${1:0:7}"; }
expect_no_incoming() {
  [ -z "$(find "$ROOT/releases" -maxdepth 1 -name '.incoming-*' 2>/dev/null)" ] || bad "an .incoming-* was left"
}
ok() {
  expect_no_incoming
  PASS=$((PASS + 1))
  echo "ok - $CASE"
}

# A first deploy, so later cases start from a live release.
first_deploy() {
  C1=$(commit "app change" apps/api/src/index.ts "v2")
  stream "$C1"
  deploy
  [ "$CODE" = 0 ] || bad "the first deploy failed"
  : > "$STUB_CALLS"
}

# ── The cases ──

CASE="deploys the commit it was sent: checkout, build, up, health, nginx -t, web, checks"
fresh_box
C1=$(commit "app change" apps/api/src/index.ts "v2")
stream "$C1"
deploy
expect_code 0
expect_out "DEPLOYED $C1"
expect_head "$C1"
expect_live_sha "$C1"
[ "$(cat "$ROOT/current/index.html")" = "<html>$C1</html>" ] || bad "current/index.html is not the sent build"
[ -f "$ROOT/current/assets/index-abc.js" ] || bad "the assets did not arrive"
[ ! -e "$ROOT/current/COMMIT" ] || bad "COMMIT is served from the web root"
expect_called "docker compose -f docker-compose.prod.yml build api"
expect_called "docker compose -f docker-compose.prod.yml up -d --wait --wait-timeout 180"
expect_called "docker inspect"
expect_called "nginx -t"
expect_called "checks $ROOT/current"
expect_not_called "exec -T db"
expect_not_called "reload"
ok

CASE="a re-run of the same commit deploys again, and says the checkout was current"
stream "$C1"
deploy
expect_code 0
expect_out "checkout already at $C1"
expect_out "DEPLOYED $C1"
ok

CASE="the deploy does not deploy a newer tip of main: only the commit it was sent"
C2=$(commit "newer" apps/api/src/index.ts "v3")
commit "newest" apps/api/src/index.ts "v4" >/dev/null
stream "$C2"
deploy
expect_code 0
expect_out "DEPLOYED $C2"
expect_head "$C2"
ok

CASE="an older commit than the checkout stops, changing nothing"
LIVE_BEFORE=$(live)
stream "$C1"
deploy
expect_code 2
expect_out "is older than the checkout"
expect_head "$C2"
[ "$(live)" = "$LIVE_BEFORE" ] || bad "current moved"
ok

CASE="a commit that is not on main stops"
git -C "$SEED" switch -q -c side
SIDE=$(git -C "$SEED" commit -q --allow-empty -m side && git -C "$SEED" rev-parse HEAD)
git -C "$SEED" push -q origin side
git -C "$SEED" switch -q main
stream "$SIDE"
deploy
expect_code 2
expect_out "is not on main"
expect_head "$C2"
ok

CASE="a commit unknown to origin stops"
stream "0123456789abcdef0123456789abcdef01234567"
deploy
expect_code 2
expect_out "is not on main"
ok

for stop in "deploy/nginx/root.conf|deploy/nginx/ changed" \
            "docker-compose.prod.yml|docker-compose.prod.yml changed" \
            ".env.production.example|.env.production.example changed"; do
  file=${stop%%|*}
  CASE="a change to $file stops before anything changes"
  fresh_box
  first_deploy
  LIVE_BEFORE=$(live)
  C=$(commit "touch $file" "$file" "changed")
  stream "$C"
  deploy
  expect_code 2
  expect_out "${stop#*|}"
  expect_out "By hand:"
  expect_head "$C1"
  [ "$(live)" = "$LIVE_BEFORE" ] || bad "current moved"
  expect_not_called "docker"
  ok
done

CASE="a commit whose deploy script differs from the installed one stops"
fresh_box
first_deploy
C=$(commit "script change" deploy/root-deploy.sh "#!/bin/sh")
stream "$C"
deploy
expect_code 2
expect_out "differs from the installed"
expect_head "$C1"
ok

CASE="several stop files are all named in one run"
fresh_box
first_deploy
commit "nginx" deploy/nginx/root.conf "a" >/dev/null
C=$(commit "compose" docker-compose.prod.yml "b")
stream "$C"
deploy
expect_code 2
expect_out "deploy/nginx/ changed"
expect_out "docker-compose.prod.yml changed"
ok

CASE="a commit with a migration dumps the database first, into a 0700 directory"
fresh_box
first_deploy
C=$(commit "migration" apps/api/prisma/migrations/0002_b/migration.sql "CREATE TABLE b ();")
stream "$C"
deploy
expect_code 0
expect_out "database dumped to $ROOT/backups/pre-migrate-"
expect_called "exec -T db sh -c pg_dump"
dump=$(find "$ROOT/backups" -name "pre-migrate-*-${C:0:7}.sql.gz")
[ -n "$dump" ] || bad "no dump file"
[ "$(gzip -dc "$dump")" = "-- a dump of the database" ] || bad "the dump is not the db's output"
[ "$(stat -c %a "$ROOT/backups")" = 700 ] || bad "backups/ is not 0700"
# The dump comes before the build.
[ "$(grep -n 'exec -T db' "$STUB_CALLS" | cut -d: -f1)" -lt "$(grep -n ' build ' "$STUB_CALLS" | cut -d: -f1)" ] \
  || bad "the dump ran after the build"
ok

CASE="a dirty checkout stops"
fresh_box
first_deploy
echo "local edit" >> "$ROOT/app/apps/api/src/index.ts"
C=$(commit "next" apps/api/src/index.ts "v9")
stream "$C"
deploy
expect_code 2
expect_out "has uncommitted changes"
ok

CASE="a held lock stops"
fresh_box
stream "$BASE"
STUB_LOCK_HELD=1 deploy
expect_code 2
expect_out "another deploy holds"
ok

CASE="a stream that is not a gzipped tar stops"
fresh_box
echo "not a tar" > "$WORK/junk"
deploy "$WORK/junk"
expect_code 2
expect_out "is not a gzipped tar"
ok

CASE="a stream whose COMMIT is not a full commit id stops"
fresh_box
stream "abc123"
deploy
expect_code 2
expect_out "COMMIT is not a full 40-hex commit id"
stream "../../etc/passwd"
deploy
expect_code 2
expect_out "not a commit id"
ok

CASE="a failed build exits 1 and leaves the old release live"
fresh_box
first_deploy
LIVE_BEFORE=$(live)
C=$(commit "next" apps/api/src/index.ts "v9")
stream "$C"
STUB_BUILD_FAILS=1 deploy
expect_code 1
expect_out "step build"
expect_not_called "up -d"
[ "$(live)" = "$LIVE_BEFORE" ] || bad "current moved"
ok

CASE="an unhealthy API exits 1 and leaves the old release live"
fresh_box
first_deploy
LIVE_BEFORE=$(live)
C=$(commit "next" apps/api/src/index.ts "v9")
stream "$C"
STUB_HEALTH=unhealthy deploy
expect_code 1
expect_out "step health"
[ "$(live)" = "$LIVE_BEFORE" ] || bad "current moved"
ok

CASE="failed checks exit 1, with the new release live"
fresh_box
first_deploy
C=$(commit "next" apps/api/src/index.ts "v9")
stream "$C"
STUB_CHECKS_FAIL=1 deploy
expect_code 1
expect_out "FAILED check_stub"
expect_out "step checks"
expect_live_sha "$C"
ok

CASE="old releases are pruned to five, and the live one is never pruned"
fresh_box
mkdir -p "$ROOT/releases"
for n in 1 2 3 4 5 6 7 8; do mkdir "$ROOT/releases/2026010${n}000000-old000$n"; done
# A rollback made an old one live.
ln -sfn "releases/20260101000000-old0001" "$ROOT/current"
C1=$(commit "app change" apps/api/src/index.ts "v2")
stream "$C1"
deploy
expect_code 0
# Kept: the newest five other than the new live one (old0004..old0008), plus the new live one.
count=$(find "$ROOT/releases" -mindepth 1 -maxdepth 1 ! -name '.*' | wc -l)
[ "$count" = 6 ] || bad "$count releases kept, expected 6"
[ -d "$ROOT/releases/20260108000000-old0008" ] || bad "the newest old release was pruned"
[ ! -d "$ROOT/releases/20260103000000-old0003" ] || bad "an old release was kept"
ok

echo "$PASS cases passed"
