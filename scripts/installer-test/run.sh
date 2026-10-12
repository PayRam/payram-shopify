#!/usr/bin/env bash
# =============================================================================
# Installer regression test.
#
# Runs setup_payram_shopify.sh end to end against fake `docker`, `curl`,
# `script` and `openssl` binaries (./bin), feeding prompt answers on stdin, and
# asserts what landed on disk and which docker commands were issued. No real
# containers are touched. Scenarios: a fresh install from a relative path with
# a hostile database URL; an upgrade of a legacy install (0644 .env, no link
# secret, bare -p on all interfaces); an upgrade of a loopback install; rootless
# Docker with an IPv6 binding; an unpublished connector on a custom network; a
# hand-set IPv6 address; an existing install whose container was already
# removed; and --reset both as an argument and as $0 (the bash -c form).
#
# Usage:  scripts/installer-test/run.sh [bash-binary]     (default: bash)
#   npm run test:installer
#   Under Linux/bash 5:
#   docker run --rm -v "$PWD:/repo:ro" -w /repo bash:5.2 scripts/installer-test/run.sh
#
# The installer has to work under macOS' /bin/bash 3.2 as well as modern bash,
# which is why this takes the interpreter as an argument.
# =============================================================================
set -u
BASH_BIN="${1:-bash}"
S="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$(cd "$S/../.." && pwd)/setup_payram_shopify.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/payram-installer-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail=0
# Answers are piped on stdin; tell the installer not to look for a terminal.
export PAYRAM_INSTALLER_ANSWERS_ON_STDIN=1
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
hex64='^[0-9a-f]{64}$'
envval() { grep "^$1=" "$2" | cut -d= -f2-; }
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

echo "=== $($BASH_BIN --version | head -1)"

# ── Scenario A: fresh install, relative dir, nasty DB URL ─────────────────────
WORK=$(mktemp -d "$TMP/work.XXXXXX"); cd "$WORK" || exit 1
export FAKE_LOG="$WORK/calls.log"; : > "$FAKE_LOG"; unset FAKE_EXISTING_BIND FAKE_URL_UNREACHABLE
DBURL='postgresql://u:p|a&b\c=d@h:5432/db'
printf '%s\n' './conn-rel' 'https://shop.example.com/' '1' "$DBURL" \
  | PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" "$INSTALLER" > "$WORK/out.txt" 2>&1
rc=$?
echo "--- A: fresh install (exit $rc)"
E="$WORK/conn-rel/.env"
check "exit 0"                              "[ $rc -eq 0 ]"
check ".env at absolute resolved path"      "[ -f '$E' ]"
check ".env mode 600"                       "[ \"\$(mode '$E')\" = 600 ]"
check "DATABASE_URL stored verbatim"        "[ \"\$(envval DATABASE_URL '$E')\" = '$DBURL' ]"
check "API secret with | & \\ verbatim"     "[ \"\$(envval SHOPIFY_API_SECRET '$E')\" = 'fakesecret|with&nasty\\chars' ]"
check "ENCRYPTION_KEY is 64 hex"            "envval ENCRYPTION_KEY '$E' | grep -Eq '$hex64'"
check "PAYMENT_LINK_SECRET is 64 hex"       "envval PAYMENT_LINK_SECRET '$E' | grep -Eq '$hex64'"
check "PAYMENT_LINK_SECRET != API secret"   "[ \"\$(envval PAYMENT_LINK_SECRET '$E')\" != \"\$(envval SHOPIFY_API_SECRET '$E')\" ]"
check "bind address loopback in .env"       "[ \"\$(envval CONNECTOR_BIND_ADDRESS '$E')\" = 127.0.0.1 ]"
check "docker run -p 127.0.0.1:2798:2798"   "grep -q -- '-p 127.0.0.1:2798:2798' '$FAKE_LOG'"
check "workspace mount is absolute, resolved" "grep -q -- \"-v \$(cd '$WORK/conn-rel' && pwd -P):/workspace\" '$FAKE_LOG'"
check "HOST_UID passed to deploy container" "grep -q -- \"HOST_UID=\$(id -u)\" '$FAKE_LOG'"
check "no duplicate keys in .env"           "[ \"\$(cut -d= -f1 '$E' | sort | uniq -d | wc -l | tr -d ' ')\" = 0 ]"
check "creds file removed"                  "[ ! -f '$WORK/conn-rel/.shopify-creds.env' ]"
check "deploy script removed"               "[ ! -f '$WORK/conn-rel/.payram-deploy.sh' ]"
check "no stray .env temp files"            "[ -z \"\$(ls '$WORK/conn-rel'/.env.* 2>/dev/null)\" ]"
check "banner: running"                     "grep -q 'is running!' '$WORK/out.txt'"
check "store picked from list"              "[ \"\$(envval SHOPIFY_STORE_DOMAIN '$E')\" = demo-store.myshopify.com ]"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario B: legacy re-run — 0644 .env, no link secret, old container on all interfaces
WORK=$(mktemp -d "$TMP/work.XXXXXX"); cd "$WORK" || exit 1; mkdir conn-legacy
export FAKE_LOG="$WORK/calls.log"; : > "$FAKE_LOG"; export FAKE_EXISTING_BIND="" FAKE_URL_UNREACHABLE=1
E="$WORK/conn-legacy/.env"
printf '%s\n' 'SHOPIFY_API_KEY=oldkey' 'SHOPIFY_API_SECRET=oldsecret' 'SHOPIFY_APP_URL=https://old.example.com' \
  'SHOPIFY_STORE_DOMAIN=old.myshopify.com' 'DATABASE_URL=file:/data/prod.sqlite' \
  'ENCRYPTION_KEY=deadbeef' 'SCOPES=read_orders' > "$E"; chmod 644 "$E"
printf '%s\n' "$WORK/conn-legacy" '' \
  | PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" "$INSTALLER" > "$WORK/out.txt" 2>&1
rc=$?
echo "--- B: legacy re-run (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check ".env tightened to 600"               "[ \"\$(mode '$E')\" = 600 ]"
check "link secret pinned to OLD api secret" "[ \"\$(envval PAYMENT_LINK_SECRET '$E')\" = oldsecret ]"
check "ENCRYPTION_KEY untouched"            "[ \"\$(envval ENCRYPTION_KEY '$E')\" = deadbeef ]"
check "bare -p preserved as bare -p (v4+v6)" "grep -q -- '-p 2798:2798 ' '$FAKE_LOG' && ! grep -q -- '0.0.0.0' '$FAKE_LOG'"
check "recorded as CONNECTOR_BIND_ADDRESS=all" "[ \"\$(envval CONNECTOR_BIND_ADDRESS '$E')\" = all ]"
check "warned about keeping all-interfaces" "grep -q 'CONNECTOR_BIND_ADDRESS=all' '$WORK/out.txt'"
check "old container stopped and removed"   "grep -q '^docker stop payram-shopify-connector' '$FAKE_LOG' && grep -q '^docker rm payram-shopify-connector' '$FAKE_LOG'"
check "inspect ran before stop"             "[ \"\$(grep -n '^docker inspect' '$FAKE_LOG' | head -1 | cut -d: -f1)\" -lt \"\$(grep -n '^docker stop' '$FAKE_LOG' | cut -d: -f1)\" ]"
check "app URL kept"                        "[ \"\$(envval SHOPIFY_APP_URL '$E')\" = https://old.example.com ]"
check "banner: not reachable"               "grep -q 'not reachable yet' '$WORK/out.txt'"
check "generic routing advice shown"        "grep -q 'No reverse proxy was found' '$WORK/out.txt'"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario C: existing loopback container → stays loopback, no warning
WORK=$(mktemp -d "$TMP/work.XXXXXX"); cd "$WORK" || exit 1; mkdir conn-c
export FAKE_LOG="$WORK/calls.log"; : > "$FAKE_LOG"; export FAKE_EXISTING_BIND="127.0.0.1"; unset FAKE_URL_UNREACHABLE
E="$WORK/conn-c/.env"
printf '%s\n' 'SHOPIFY_API_KEY=k' 'SHOPIFY_API_SECRET=s' 'SHOPIFY_APP_URL=https://c.example.com' \
  'SHOPIFY_STORE_DOMAIN=c.myshopify.com' 'DATABASE_URL=file:/data/prod.sqlite' 'ENCRYPTION_KEY=ek' 'PAYMENT_LINK_SECRET=pls' > "$E"
printf '%s\n' "$WORK/conn-c" '' | PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" "$INSTALLER" > "$WORK/out.txt" 2>&1
rc=$?
echo "--- C: loopback re-run (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "bind stays loopback"                 "grep -q -- '-p 127.0.0.1:2798:2798' '$FAKE_LOG'"
check "no all-interfaces warning"           "! grep -q 'Keeping port' '$WORK/out.txt'"
check "existing link secret untouched"      "[ \"\$(envval PAYMENT_LINK_SECRET '$E')\" = pls ]"

# ── Scenario E: rootless Docker → files handed back to root (= host user); IPv6 bind preserved bracketed
WORK=$(mktemp -d "$TMP/work.XXXXXX"); cd "$WORK" || exit 1; mkdir conn-e
export FAKE_LOG="$WORK/calls.log"; : > "$FAKE_LOG"; export FAKE_EXISTING_BIND="::1" FAKE_ROOTLESS=1; unset FAKE_URL_UNREACHABLE
E="$WORK/conn-e/.env"
printf '%s\n' 'SHOPIFY_API_KEY=k' 'SHOPIFY_API_SECRET=s' 'SHOPIFY_APP_URL=https://e.example.com' \
  'SHOPIFY_STORE_DOMAIN=e.myshopify.com' 'DATABASE_URL=file:/data/prod.sqlite' 'ENCRYPTION_KEY=ek' 'PAYMENT_LINK_SECRET=pls' > "$E"
printf '%s\n' "$WORK/conn-e" '' | PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" "$INSTALLER" > "$WORK/out.txt" 2>&1
rc=$?
echo "--- E: rootless + IPv6 re-run (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "deploy owner is root under rootless" "grep -q -- 'HOST_UID=0 ' '$FAKE_LOG' && grep -q -- 'HOST_GID=0 ' '$FAKE_LOG'"
check "IPv6 bind preserved and bracketed"   "grep -q -- '-p \[::1\]:2798:2798' '$FAKE_LOG'"
unset FAKE_ROOTLESS
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario F: unpublished port + custom network (containerised-proxy topology) survive a re-run
WORK=$(mktemp -d "$TMP/work.XXXXXX"); cd "$WORK" || exit 1; mkdir conn-f
export FAKE_LOG="$WORK/calls.log"; : > "$FAKE_LOG"; export FAKE_EXISTING_BIND="none" FAKE_EXTRA_NETWORKS="payram-edge"; unset FAKE_URL_UNREACHABLE
E="$WORK/conn-f/.env"
printf '%s\n' 'SHOPIFY_API_KEY=k' 'SHOPIFY_API_SECRET=s' 'SHOPIFY_APP_URL=https://f.example.com' \
  'SHOPIFY_STORE_DOMAIN=f.myshopify.com' 'DATABASE_URL=file:/data/prod.sqlite' 'ENCRYPTION_KEY=ek' 'PAYMENT_LINK_SECRET=pls' > "$E"
printf '%s\n' "$WORK/conn-f" '' | PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" "$INSTALLER" > "$WORK/out.txt" 2>&1
rc=$?
echo "--- F: unpublished + network re-run (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "no -p on the new container"          "! grep '^docker run -d' '$FAKE_LOG' | grep -q -- ' -p '"
check "recorded as none"                    "[ \"\$(envval CONNECTOR_BIND_ADDRESS '$E')\" = none ]"
check "re-attached to payram-edge"          "grep -q '^docker network connect payram-edge payram-shopify-connector' '$FAKE_LOG'"
check "health probed via docker exec"       "grep -q '^docker exec payram-shopify-connector wget' '$FAKE_LOG'"
check "banner: running"                     "grep -q 'is running!' '$WORK/out.txt'"
unset FAKE_EXTRA_NETWORKS
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario G: hand-set bare IPv6 in .env is bracketed before docker run
WORK=$(mktemp -d "$TMP/work.XXXXXX"); cd "$WORK" || exit 1; mkdir conn-g
export FAKE_LOG="$WORK/calls.log"; : > "$FAKE_LOG"; unset FAKE_EXISTING_BIND
E="$WORK/conn-g/.env"
printf '%s\n' 'SHOPIFY_API_KEY=k' 'SHOPIFY_API_SECRET=s' 'SHOPIFY_APP_URL=https://g.example.com' \
  'SHOPIFY_STORE_DOMAIN=g.myshopify.com' 'DATABASE_URL=file:/data/prod.sqlite' 'ENCRYPTION_KEY=ek' 'PAYMENT_LINK_SECRET=pls' 'CONNECTOR_BIND_ADDRESS=::1' > "$E"
printf '%s\n' "$WORK/conn-g" '' | PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" "$INSTALLER" > "$WORK/out.txt" 2>&1
rc=$?
echo "--- G: hand-set IPv6 (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "bracketed in -p"                     "grep -q -- '-p \[::1\]:2798:2798' '$FAKE_LOG'"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario H: existing install, container already removed → loopback, but say so
WORK=$(mktemp -d "$TMP/work.XXXXXX"); cd "$WORK" || exit 1; mkdir conn-h
export FAKE_LOG="$WORK/calls.log"; : > "$FAKE_LOG"; unset FAKE_EXISTING_BIND
E="$WORK/conn-h/.env"
printf '%s\n' 'SHOPIFY_API_KEY=k' 'SHOPIFY_API_SECRET=s' 'SHOPIFY_APP_URL=https://h.example.com' \
  'SHOPIFY_STORE_DOMAIN=h.myshopify.com' 'DATABASE_URL=file:/data/prod.sqlite' 'ENCRYPTION_KEY=ek' 'PAYMENT_LINK_SECRET=pls' > "$E"
printf '%s\n' "$WORK/conn-h" '' | PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" "$INSTALLER" > "$WORK/out.txt" 2>&1
rc=$?
echo "--- H: existing install, no container (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "defaults to loopback"                "grep -q -- '-p 127.0.0.1:2798:2798' '$FAKE_LOG'"
check "warns that the binding is new"       "grep -q 'No existing container to read the port binding' '$WORK/out.txt'"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario D: --reset parsed as a normal argument AND as \$0 (the bash -c "\$(curl …)" --reset form)
WORK=$(mktemp -d "$TMP/work.XXXXXX"); cd "$WORK" || exit 1
export FAKE_LOG="$WORK/calls.log"; : > "$FAKE_LOG"; unset FAKE_EXISTING_BIND
printf '%s\n' "$WORK/x" 'no' | PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" "$INSTALLER" --reset > "$WORK/out.txt" 2>&1
check "D: --reset as argument reaches confirm and cancels" "grep -q 'Reset cancelled' '$WORK/out.txt'"
printf '%s\n' "$WORK/x" 'no' | PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" -c "$(cat "$INSTALLER")" --reset > "$WORK/out0.txt" 2>&1
check "D: --reset as \$0 (bash -c form) reaches confirm and cancels" "grep -q 'Reset cancelled' '$WORK/out0.txt'"

cd "$S" || exit 1
if [ $fail -eq 0 ]; then echo "ALL PASSED"; else echo "SOME FAILED"; exit 1; fi
