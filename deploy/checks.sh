#!/usr/bin/env bash
# The checks after every deploy: the one list. Run by root-deploy as an unprivileged user from the
# new checkout, and by hand from the box:
#
#   bash deploy/checks.sh <live web dir> [origin]
#   bash /srv/root/app/deploy/checks.sh /srv/root/current
#
# A change that adds a deploy check adds it here, in its own diff, so nobody reinstalls the
# root-owned script to get it. It needs only bash, curl, grep, sed, tr and cmp, and it never reads
# the server's .env. It stops at the first failure and names the check by function, so the
# Actions log (which is public) says which one.
#
# Everything it sends is a GET, except one anonymous `{ __typename }` POST to /graphql, which
# reads nothing and writes nothing.
set -uo pipefail

LIVE="${1:-}"
ORIGIN="${2:-https://m-root.com}"
HERE=$(cd "$(dirname "$0")" && pwd)

if [ -z "$LIVE" ] || [ ! -f "$LIVE/index.html" ]; then
  echo "usage: checks.sh <live web dir, holding index.html> [origin]" >&2
  exit 64
fi

# The CSP the box must send is the one in the committed snippet. Read from it, so a snippet that
# was edited here but never copied to /etc/nginx/snippets/ fails this check (README, After any
# deploy that touches Nginx).
CSP=$(sed -n 's/^[[:space:]]*add_header Content-Security-Policy "\(.*\)" always;[[:space:]]*$/\1/p' \
  "$HERE/nginx/security-headers.conf" | head -n 1)
[ -n "$CSP" ] || { echo "checks.sh: no CSP line in $HERE/nginx/security-headers.conf" >&2; exit 64; }
HOST="${ORIGIN#https://}"
MAX_TIME=20

# ── Helpers ──

CHECK=""
fail() {
  echo "FAILED $CHECK: $*"
  exit 1
}

# The last response, split into its headers and its body, with the carriage returns removed from
# the headers. Plain variables and here-strings, never a pipe into "grep -q": under pipefail, grep
# quitting on its first match would kill the writer with SIGPIPE and fail the check for nothing.
HEADERS=""
BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT

# fetch <curl args...>: the body to a file (compared byte for byte), the headers to a variable.
fetch() {
  HEADERS=$(curl -s --max-time "$MAX_TIME" -D - -o "$BODY_FILE" "$@" | tr -d '\r') || fail "no answer from $*"
  [ -n "$HEADERS" ] || fail "empty answer from $*"
  # After a redirect-free request there is one header block; keep only the last, to be safe.
  HEADERS=${HEADERS##*$'\n\n'HTTP/}
  case "$HEADERS" in HTTP/*) ;; *) HEADERS="HTTP/$HEADERS" ;; esac
}

status_of() { sed -n '1s/^HTTP\/[0-9.]* \([0-9][0-9]*\).*$/\1/p' <<<"$HEADERS"; }

# header <name>: the first value, or nothing. The name is matched case-insensitively.
header() { sed -n "/^$1:/I{s/^[^:]*:[[:space:]]*//;p;q}" <<<"$HEADERS"; }
has_header() { grep -qi "^$1:" <<<"$HEADERS"; }

expect_status() {
  local got
  got=$(status_of)
  [ "$got" = "$1" ] || fail "expected status $1, got '${got:-none}'"
}

expect_header() {
  local got
  got=$(header "$1")
  [ "$got" = "$2" ] || fail "header $1 is '${got:-absent}', expected '$2'"
}

expect_header_has() {
  local got
  got=$(header "$1")
  grep -qF -- "$2" <<<"$got" || fail "header $1 is '${got:-absent}', expected it to hold '$2'"
}

expect_no_cookie() { ! has_header set-cookie || fail "a Set-Cookie header is present"; }

# The portal's own headers, from the snippet: on every HTML response.
expect_portal_headers() {
  expect_header content-security-policy "$CSP"
  expect_header x-frame-options DENY
  expect_header x-content-type-options nosniff
  expect_header referrer-policy strict-origin-when-cross-origin
}

# ── The checks ──

# The site's root serves the release that was just made live, byte for byte, with the headers.
check_index_is_the_new_release() {
  CHECK=${FUNCNAME[0]}
  fetch "$ORIGIN/"
  expect_status 200
  expect_portal_headers
  expect_header cache-control no-cache
  expect_no_cookie
  cmp -s "$BODY_FILE" "$LIVE/index.html" || fail "/ is not $LIVE/index.html (is Nginx's root $LIVE?)"
}

# A client-side route falls back to the same index.html.
check_deep_link_falls_back() {
  CHECK=${FUNCNAME[0]}
  fetch "$ORIGIN/fa/portal"
  expect_status 200
  expect_portal_headers
  cmp -s "$BODY_FILE" "$LIVE/index.html" || fail "/fa/portal is not the SPA's index.html"
}

# The script the index names is served, cached for good.
check_asset_is_served() {
  CHECK=${FUNCNAME[0]}
  local asset
  asset=$(grep -o '/assets/[^"]*\.js' "$LIVE/index.html" | head -n 1)
  [ -n "$asset" ] || fail "$LIVE/index.html names no /assets/*.js"
  fetch "$ORIGIN$asset"
  expect_status 200
  expect_header_has cache-control immutable
  cmp -s "$BODY_FILE" "$LIVE$asset" || fail "$asset is not the release's own file"
}

# The API answers through Nginx, on the same origin.
check_graphql_answers() {
  CHECK=${FUNCNAME[0]}
  fetch -X POST -H 'Content-Type: application/json' --data '{"query":"{ __typename }"}' "$ORIGIN/graphql"
  expect_status 200
  expect_no_cookie
  grep -qF '"__typename":"Query"' "$BODY_FILE" || fail "the body is not { __typename: Query }"
}

# A climb out of /public-files/ reaches nothing private (README, First time, step 4). Nginx
# resolves the `..` before it picks a location, so the answer is a refusal or the SPA's own
# index.html, never anything from storage.
check_private_files_not_aliased() {
  CHECK=${FUNCNAME[0]}
  fetch --path-as-is "$ORIGIN/public-files/../private/"
  case "$(status_of)" in
    400 | 404) ;;
    200) cmp -s "$BODY_FILE" "$LIVE/index.html" || fail "a 200 that is not the SPA's index.html" ;;
    *) fail "expected 400, 404 or the SPA's index.html, got '$(status_of)'" ;;
  esac
}

# Plain HTTP goes to HTTPS.
check_http_redirects() {
  CHECK=${FUNCNAME[0]}
  fetch "http://$HOST/"
  expect_status 301
  expect_header location "https://$HOST/"
}

check_index_is_the_new_release
check_deep_link_falls_back
check_asset_is_served
check_graphql_answers
check_private_files_not_aliased
check_http_redirects
echo "checks passed: $ORIGIN serves $(basename "$(readlink -f "$LIVE")")"
