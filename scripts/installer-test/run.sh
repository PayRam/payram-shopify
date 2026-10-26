#!/usr/bin/env bash
# =============================================================================
# Installer regression test.
#
# Runs setup_payram_shopify.sh end to end against fake `docker`, `curl`,
# `script` and `openssl` binaries (./bin), feeding prompt answers on stdin, and
# asserts what landed on disk and which docker commands were issued. No real
# containers are touched. Scenarios:
#   A  unattended first install (Client ID pre-set), relative dir, hostile secret
#   A0 unattended first install with no Client ID → refused before the pull
#   B  legacy upgrade: 0644 .env, no link secret, bare -p on all interfaces
#   C  loopback upgrade, under a BSD/macOS `script`
#   E  rootless Docker with an IPv6 binding
#   F  unpublished connector on a custom network
#   G  hand-set IPv6 address, install dir pre-answered from the environment
#   H  existing install whose container was already removed
#   I  .env carries a Postgres URL → refused, password not echoed
#   J  stdin runs dry before a required answer → stops and names the variable
#   D  --reset as an argument, as $0 (the bash -c form), and with stdin at EOF
#   K  --help prints usage and touches nothing; an unknown flag refuses to install
#   L  Docker socket permission denied → named as such, not as "Docker not running"
#   M  .env with Windows line endings and quoted values is normalised before use
#   N  SELinux enforcing → the deploy workspace mount carries :z
#   O  URL with a path and a custom store domain are re-asked; admin URL paste accepted
#   P  docker run refused (port taken) → previous container restored, cause named
#   Q  CONNECTOR_IMAGE from the environment pins the image, and the pin holds on a re-run
#   R  PORT in .env is published and probed; a PORT in the caller's environment is ignored
#   S  a hand-set ENCRYPTION_KEY that is not 64 hex characters is refused
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
# A re-run's .env, minus whatever a scenario wants to vary.
write_env() { printf '%s\n' "SHOPIFY_API_KEY=k" "SHOPIFY_API_SECRET=s" "SHOPIFY_APP_URL=https://$1.example.com" \
  "SHOPIFY_STORE_DOMAIN=$1.myshopify.com" "DATABASE_URL=file:/data/prod.sqlite" "ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" "PAYMENT_LINK_SECRET=pls" "${@:2}"; }
run_installer() { PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" "$INSTALLER" "$@" > "$WORK/out.txt" 2>&1; }
new_work() { WORK=$(mktemp -d "$TMP/work.XXXXXX"); cd "$WORK" || exit 1; export FAKE_LOG="$WORK/calls.log"; : > "$FAKE_LOG"
  unset FAKE_EXISTING_BIND FAKE_URL_UNREACHABLE FAKE_EXTRA_NETWORKS FAKE_ROOTLESS FAKE_SCRIPT_FLAVOR FAKE_DOCKER_DENIED FAKE_SELINUX FAKE_RUN_FAILS \
        PAYRAM_INSTALL_DIR SHOPIFY_API_KEY CONNECTOR_IMAGE; }

echo "=== $($BASH_BIN --version | head -1)"

# ── Scenario A: unattended first install — Client ID pre-set, relative dir, hostile secret
new_work
printf '%s\n' './conn-rel' 'https://shop.example.com/' 'Demo-Store' \
  | SHOPIFY_API_KEY=preseeded-client-id run_installer
rc=$?
echo "--- A: unattended first install (exit $rc)"
E="$WORK/conn-rel/.env"
check "exit 0"                              "[ $rc -eq 0 ]"
check ".env at absolute resolved path"      "[ -f '$E' ]"
check ".env mode 600"                       "[ \"\$(mode '$E')\" = 600 ]"
check "pre-set Client ID went into the toml" "grep -q 'client_id = \"preseeded-client-id\"' '$WORK/conn-rel/shopify.app.toml'"
check "real key from env pull wins in .env"  "[ \"\$(envval SHOPIFY_API_KEY '$E')\" = fakekey123 ]"
check "API secret with | & \\ verbatim"     "[ \"\$(envval SHOPIFY_API_SECRET '$E')\" = 'fakesecret|with&nasty\\chars' ]"
check "store domain normalised, lower-cased" "[ \"\$(envval SHOPIFY_STORE_DOMAIN '$E')\" = demo-store.myshopify.com ]"
check "no store-list container was run"     "! grep -q 'store list' '$FAKE_LOG'"
check "SQLite chosen without a question"    "[ \"\$(envval DATABASE_URL '$E')\" = file:/data/prod.sqlite ] && ! grep -q 'DATABASE_URL \[' '$WORK/out.txt'"
check "ENCRYPTION_KEY is 64 hex"            "envval ENCRYPTION_KEY '$E' | grep -Eq '$hex64'"
check "PAYMENT_LINK_SECRET is 64 hex"       "envval PAYMENT_LINK_SECRET '$E' | grep -Eq '$hex64'"
check "PAYMENT_LINK_SECRET != API secret"   "[ \"\$(envval PAYMENT_LINK_SECRET '$E')\" != \"\$(envval SHOPIFY_API_SECRET '$E')\" ]"
check "bind address loopback in .env"       "[ \"\$(envval CONNECTOR_BIND_ADDRESS '$E')\" = 127.0.0.1 ]"
check "docker run -p 127.0.0.1:2798:2798"   "grep -q -- '-p 127.0.0.1:2798:2798' '$FAKE_LOG'"
check "workspace mount is absolute, resolved" "grep -q -- \"-v \$(cd '$WORK/conn-rel' && pwd -P):/workspace\" '$FAKE_LOG'"
check "HOST_UID passed to deploy container" "grep -q -- \"HOST_UID=\$(id -u)\" '$FAKE_LOG'"
check "CLI config root points into the auth volume" "grep -q -- '-e XDG_CONFIG_HOME=/root/.config/shopify ' '$FAKE_LOG' && grep -q -- '-v payram-shopify-cli-auth:/root/.config/shopify ' '$FAKE_LOG'"
check "util-linux script invoked with -c"   "grep -q '^script -qec ' '$FAKE_LOG'"
check "CLI told to print the login link, not wait for a key" "grep -q -- '-e CLOUD_SHELL=1 ' '$FAKE_LOG'"
check "no duplicate keys in .env"           "[ \"\$(cut -d= -f1 '$E' | sort | uniq -d | wc -l | tr -d ' ')\" = 0 ]"
check "creds file removed"                  "[ ! -f '$WORK/conn-rel/.shopify-creds.env' ]"
check "deploy script removed"               "[ ! -f '$WORK/conn-rel/.payram-deploy.sh' ]"
check "no stray .env temp files"            "[ -z \"\$(ls '$WORK/conn-rel'/.env.* 2>/dev/null)\" ]"
check "no colour codes when stdout is not a terminal" "! grep -q \$'\\033' '$WORK/out.txt'"
check "questions appear in the transcript"  "grep -q 'Shopify store domain' '$WORK/out.txt' && grep -q 'Public HTTPS App URL' '$WORK/out.txt'"
check "login hand-off announced for unattended run" "grep -q 'ACTION REQUIRED' '$WORK/out.txt'"
check "live-store distribution note shown"  "grep -q 'Custom distribution' '$WORK/out.txt'"
check "banner: running"                     "grep -q 'is running!' '$WORK/out.txt'"
check "connector version and digest shown"  "grep -q 'Connector 1.4.2' '$WORK/out.txt' && grep -q 'sha256:0123456789ab' '$WORK/out.txt'"
check "pre-start summary shown"             "grep -q 'Starting with:' '$WORK/out.txt' && grep -q 'Store  *demo-store.myshopify.com' '$WORK/out.txt'"
check "first run: deploy script deploys twice, gated on an empty client_id" "[ \"\$(grep -c 'shopify app deploy' '$FAKE_LOG.deploy.sh')\" = 2 ] && grep -q 'if \[ -z \"\$CLIENT_ID_BEFORE\" \]' '$FAKE_LOG.deploy.sh'"
check "replaced container not expected on a first install" "! grep -q '^docker rename' '$FAKE_LOG'"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario A0: unattended first install with no Client ID → refused before anything is pulled
new_work
printf '%s\n' './conn-a0' 'https://shop.example.com' | run_installer
rc=$?
echo "--- A0: unattended first install, no Client ID (exit $rc)"
check "non-zero exit"                       "[ $rc -ne 0 ]"
check "explains what is needed"             "grep -q 'First-time setup needs a terminal' '$WORK/out.txt' && grep -q 'SHOPIFY_API_KEY' '$WORK/out.txt'"
check "stopped before the image pull"       "! grep -q '^docker pull' '$FAKE_LOG'"

# ── Scenario B: legacy re-run — 0644 .env, no link secret, old container on all interfaces
new_work; mkdir conn-legacy
export FAKE_EXISTING_BIND="" FAKE_URL_UNREACHABLE=1
E="$WORK/conn-legacy/.env"
printf '%s\n' 'SHOPIFY_API_KEY=oldkey' 'SHOPIFY_API_SECRET=oldsecret' 'SHOPIFY_APP_URL=https://old.example.com' \
  'SHOPIFY_STORE_DOMAIN=old.myshopify.com' 'DATABASE_URL=file:/data/prod.sqlite' \
  'ENCRYPTION_KEY=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' 'SCOPES=read_orders' > "$E"; chmod 644 "$E"
printf '%s\n' "$WORK/conn-legacy" '' | run_installer
rc=$?
echo "--- B: legacy re-run (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check ".env tightened to 600"               "[ \"\$(mode '$E')\" = 600 ]"
check "link secret pinned to OLD api secret" "[ \"\$(envval PAYMENT_LINK_SECRET '$E')\" = oldsecret ]"
check "ENCRYPTION_KEY untouched"            "[ \"\$(envval ENCRYPTION_KEY '$E')\" = deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef ]"
check "bare -p preserved as bare -p (v4+v6)" "grep -q -- '-p 2798:2798 ' '$FAKE_LOG' && ! grep -q -- '0.0.0.0' '$FAKE_LOG'"
check "recorded as CONNECTOR_BIND_ADDRESS=all" "[ \"\$(envval CONNECTOR_BIND_ADDRESS '$E')\" = all ]"
check "warned about keeping all-interfaces" "grep -q 'CONNECTOR_BIND_ADDRESS=all' '$WORK/out.txt'"
check "old container stopped, kept until the new one is up, then removed" "grep -q '^docker stop payram-shopify-connector' '$FAKE_LOG' && grep -q '^docker rename payram-shopify-connector payram-shopify-connector-replaced' '$FAKE_LOG' && grep -q '^docker rm payram-shopify-connector-replaced' '$FAKE_LOG'"
check "rename happened before the new run"  "[ \"\$(grep -n '^docker rename' '$FAKE_LOG' | head -1 | cut -d: -f1)\" -lt \"\$(grep -n '^docker run -d' '$FAKE_LOG' | cut -d: -f1)\" ]"
check "inspect ran before stop"             "[ \"\$(grep -n '^docker inspect' '$FAKE_LOG' | head -1 | cut -d: -f1)\" -lt \"\$(grep -n '^docker stop' '$FAKE_LOG' | cut -d: -f1)\" ]"
check "app URL kept"                        "[ \"\$(envval SHOPIFY_APP_URL '$E')\" = https://old.example.com ]"
check "banner: not reachable"               "grep -q 'not reachable yet' '$WORK/out.txt'"
# The installer picks its routing advice from the real host (/etc/nginx), so
# the expected advice depends on where this test runs: GitHub's Ubuntu runners
# have nginx installed, a developer laptop usually does not.
if [ -d /etc/nginx ]; then
  check "nginx routing advice shown (host has nginx)" "grep -q 'nginx on this host has no entry' '$WORK/out.txt' && ! grep -q 'No reverse proxy was found' '$WORK/out.txt'"
else
  check "generic routing advice shown"      "grep -q 'No reverse proxy was found' '$WORK/out.txt'"
fi
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario C: existing loopback container → stays loopback, no warning; BSD/macOS `script`
new_work; mkdir conn-c
export FAKE_EXISTING_BIND="127.0.0.1" FAKE_SCRIPT_FLAVOR=bsd
E="$WORK/conn-c/.env"; write_env c > "$E"
printf '%s\n' "$WORK/conn-c" '' | run_installer
rc=$?
echo "--- C: loopback re-run under BSD script (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "bind stays loopback"                 "grep -q -- '-p 127.0.0.1:2798:2798' '$FAKE_LOG'"
check "no all-interfaces warning"           "! grep -q 'Keeping port' '$WORK/out.txt'"
check "existing link secret untouched"      "[ \"\$(envval PAYMENT_LINK_SECRET '$E')\" = pls ]"
check "BSD script form used (-qe FILE CMD)" "grep -q '^script -qe /dev/null .*bash -c ' '$FAKE_LOG' && ! grep -q '^script -qec' '$FAKE_LOG'"
check "deploy still ran"                    "grep -q '^docker run --rm -it' '$FAKE_LOG'"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario E: rootless Docker → files handed back to root (= host user); IPv6 bind preserved bracketed
new_work; mkdir conn-e
export FAKE_EXISTING_BIND="::1" FAKE_ROOTLESS=1
E="$WORK/conn-e/.env"; write_env e > "$E"
printf '%s\n' "$WORK/conn-e" '' | run_installer
rc=$?
echo "--- E: rootless + IPv6 re-run (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "deploy owner is root under rootless" "grep -q -- 'HOST_UID=0 ' '$FAKE_LOG' && grep -q -- 'HOST_GID=0 ' '$FAKE_LOG'"
check "IPv6 bind preserved and bracketed"   "grep -q -- '-p \[::1\]:2798:2798' '$FAKE_LOG'"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario F: unpublished port + custom network (containerised-proxy topology) survive a re-run
new_work; mkdir conn-f
export FAKE_EXISTING_BIND="none" FAKE_EXTRA_NETWORKS="payram-edge"
E="$WORK/conn-f/.env"; write_env f > "$E"
printf '%s\n' "$WORK/conn-f" '' | run_installer
rc=$?
echo "--- F: unpublished + network re-run (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "no -p on the new container"          "! grep '^docker run -d' '$FAKE_LOG' | grep -q -- ' -p '"
check "recorded as none"                    "[ \"\$(envval CONNECTOR_BIND_ADDRESS '$E')\" = none ]"
check "re-attached to payram-edge"          "grep -q '^docker network connect payram-edge payram-shopify-connector' '$FAKE_LOG'"
check "health probed via docker exec"       "grep -q '^docker exec payram-shopify-connector wget' '$FAKE_LOG'"
check "banner: running"                     "grep -q 'is running!' '$WORK/out.txt'"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario G: hand-set bare IPv6 in .env is bracketed; install dir pre-answered from the environment
new_work; mkdir conn-g
E="$WORK/conn-g/.env"; write_env g 'CONNECTOR_BIND_ADDRESS=::1' > "$E"
printf '%s\n' '' | PAYRAM_INSTALL_DIR="$WORK/conn-g" run_installer
rc=$?
echo "--- G: hand-set IPv6, dir from environment (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "bracketed in -p"                     "grep -q -- '-p \[::1\]:2798:2798' '$FAKE_LOG'"
check "install dir taken from environment"  "grep -q 'conn-g  (from environment)' '$WORK/out.txt'"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario H: existing install, container already removed → loopback, but say so
new_work; mkdir conn-h
E="$WORK/conn-h/.env"; write_env h > "$E"
printf '%s\n' "$WORK/conn-h" '' | run_installer
rc=$?
echo "--- H: existing install, no container (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "defaults to loopback"                "grep -q -- '-p 127.0.0.1:2798:2798' '$FAKE_LOG'"
check "warns that the binding is new"       "grep -q 'No existing container to read the port binding' '$WORK/out.txt'"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario I: a Postgres DATABASE_URL in .env → refused with the reason, password never printed
new_work; mkdir conn-i
E="$WORK/conn-i/.env"; write_env i | grep -v '^DATABASE_URL=' > "$E"; echo 'DATABASE_URL=postgresql://u:topsecretpw@db:5432/x' >> "$E"
printf '%s\n' "$WORK/conn-i" '' | run_installer
rc=$?
echo "--- I: Postgres URL in .env (exit $rc)"
check "non-zero exit"                       "[ $rc -ne 0 ]"
check "says SQLite only"                    "grep -q 'SQLite only' '$WORK/out.txt'"
check "password not echoed"                 "! grep -q 'topsecretpw' '$WORK/out.txt'"
check "no container started"                "! grep -q '^docker run -d' '$FAKE_LOG'"

# ── Scenario J: stdin runs dry before a required answer → clear stop, variable named
new_work
printf '%s\n' './conn-j' | SHOPIFY_API_KEY=preseeded-client-id run_installer
rc=$?
echo "--- J: EOF before a required answer (exit $rc)"
check "non-zero exit"                       "[ $rc -ne 0 ]"
check "names the real variable to pre-set"  "grep -q 'Pre-set SHOPIFY_APP_URL ' '$WORK/out.txt'"
check "the unanswered question is in the log" "grep -q 'nothing answered: Public HTTPS App URL' '$WORK/out.txt'"

# ── Scenario D: --reset parsed as a normal argument, as $0 (the bash -c "$(curl …)" --reset form), and at EOF
new_work
printf '%s\n' "$WORK/x" 'no' | run_installer --reset
check "D: --reset as argument reaches confirm and cancels" "grep -q 'Reset cancelled' '$WORK/out.txt'"
printf '%s\n' "$WORK/x" 'no' | PATH="$S/bin:$PATH" HOME="$WORK" "$BASH_BIN" -c "$(cat "$INSTALLER")" --reset > "$WORK/out0.txt" 2>&1
check "D: --reset as \$0 (bash -c form) reaches confirm and cancels" "grep -q 'Reset cancelled' '$WORK/out0.txt'"
printf '%s\n' "$WORK/x" | run_installer --reset
rc=$?
check "D: --reset with stdin at EOF cancels cleanly (exit $rc)" "[ $rc -eq 0 ] && grep -q 'Reset cancelled' '$WORK/out.txt' && ! grep -q '^docker rm' '$FAKE_LOG'"

# ── Scenario K: --help and an unknown flag never reach Docker
new_work
run_installer --help; rc=$?
echo "--- K: --help (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "usage lists the overrides"           "grep -q 'PAYRAM_INSTALL_DIR' '$WORK/out.txt' && grep -q -- '--reset' '$WORK/out.txt'"
check "no docker call"                      "! grep -q '^docker' '$FAKE_LOG'"
printf '%s\n' './never' | run_installer --rest; rc=$?
check "K: unknown flag refused (exit $rc)"  "[ $rc -ne 0 ] && grep -q 'Unknown option: --rest' '$WORK/out.txt' && ! grep -q '^docker' '$FAKE_LOG'"

# ── Scenario L: docker socket not accessible to this user
new_work
export FAKE_DOCKER_DENIED=1
printf '%s\n' './conn-l' | run_installer; rc=$?
echo "--- L: docker permission denied (exit $rc)"
check "non-zero exit"                       "[ $rc -ne 0 ]"
check "names the permission problem"        "grep -q 'not allowed to use it' '$WORK/out.txt' && grep -q 'usermod -aG docker' '$WORK/out.txt'"
check "does not claim Docker is down"       "! grep -q 'not running' '$WORK/out.txt'"

# ── Scenario M: hand-edited .env — CRLF line endings and quoted values
new_work; mkdir conn-m
export FAKE_EXISTING_BIND="127.0.0.1"
E="$WORK/conn-m/.env"
write_env m | sed 's|^SHOPIFY_APP_URL=\(.*\)$|SHOPIFY_APP_URL="\1"|' | sed "s|^SHOPIFY_STORE_DOMAIN=\(.*\)\$|SHOPIFY_STORE_DOMAIN='\1'|" | sed $'s/$/\r/' > "$E"
printf '%s\n' "$WORK/conn-m" '' | run_installer; rc=$?
echo "--- M: CRLF + quoted .env (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "no carriage returns left"            "! grep -q \$'\r' '$E'"
check "double quotes stripped"              "[ \"\$(envval SHOPIFY_APP_URL '$E')\" = https://m.example.com ]"
check "single quotes stripped"              "[ \"\$(envval SHOPIFY_STORE_DOMAIN '$E')\" = m.myshopify.com ]"
check "other values intact"                 "[ \"\$(envval PAYMENT_LINK_SECRET '$E')\" = pls ]"
check "said what it normalised"             "grep -q 'Normalising' '$WORK/out.txt' && grep -q 'Windows line endings' '$WORK/out.txt' && grep -q 'SHOPIFY_APP_URL' '$WORK/out.txt'"
check "deploy got the clean URL"            "grep -q -- '-e SHOPIFY_APP_URL=https://m.example.com ' '$FAKE_LOG'"
check "no duplicate keys in .env"           "[ \"\$(cut -d= -f1 '$E' | sort | uniq -d | wc -l | tr -d ' ')\" = 0 ]"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario N: SELinux enforcing relabels the workspace mount
new_work; mkdir conn-n
export FAKE_EXISTING_BIND="127.0.0.1" FAKE_SELINUX=Enforcing
E="$WORK/conn-n/.env"; write_env n > "$E"
printf '%s\n' "$WORK/conn-n" '' | run_installer; rc=$?
echo "--- N: SELinux enforcing (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "workspace mounted with :z"           "grep -q -- \":/workspace:z \" '$FAKE_LOG'"
check "creds still handed back"             "[ \"\$(envval SHOPIFY_API_KEY '$E')\" = fakekey123 ]"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario O: what people paste — URL with a path, custom storefront domain, the admin URL
new_work
printf '%s\n' './conn-o' 'https://shop.example.com/pay' ' https://Shop.example.com ' 'www.mystore.com' 'https://admin.shopify.com/store/My-Store/settings/payments' \
  | SHOPIFY_API_KEY=preseeded-client-id run_installer; rc=$?
echo "--- O: pasted values (exit $rc)"
E="$WORK/conn-o/.env"
check "exit 0"                              "[ $rc -eq 0 ]"
check "URL with a path rejected with the fix" "grep -q 'root of its hostname' '$WORK/out.txt' && grep -q 'Use https://shop.example.com ' '$WORK/out.txt'"
check "spaces around the URL ignored"       "[ \"\$(envval SHOPIFY_APP_URL '$E')\" = https://Shop.example.com ]"
check "custom domain rejected"              "grep -q 'myshopify.com address — got: www.mystore.com' '$WORK/out.txt'"
check "admin URL reduced to the store"      "[ \"\$(envval SHOPIFY_STORE_DOMAIN '$E')\" = my-store.myshopify.com ]"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario P: docker run refused on the re-run → old container back, cause named
new_work; mkdir conn-p
export FAKE_EXISTING_BIND="127.0.0.1" FAKE_RUN_FAILS=1
E="$WORK/conn-p/.env"; write_env p > "$E"
printf '%s\n' "$WORK/conn-p" '' | run_installer; rc=$?
echo "--- P: docker run refused (exit $rc)"
check "non-zero exit"                       "[ $rc -ne 0 ]"
check "previous container renamed back and started" "grep -q '^docker rename payram-shopify-connector-replaced payram-shopify-connector' '$FAKE_LOG' && grep -q '^docker start payram-shopify-connector' '$FAKE_LOG'"
check "says the previous container is back" "grep -q 'previous container is back' '$WORK/out.txt'"
check "names the port clash and how to find it" "grep -q 'in use by something else' '$WORK/out.txt' && grep -q 'lsof -iTCP:2798' '$WORK/out.txt'"
check "no success banner"                   "! grep -q 'is running!' '$WORK/out.txt'"

# ── Scenario Q: image pin — set once in the environment, then honoured from .env
new_work
printf '%s\n' './conn-q' 'https://q.example.com' 'q-store' \
  | CONNECTOR_IMAGE=payramapp/payram-shopify:1.4.2 SHOPIFY_API_KEY=preseeded-client-id run_installer; rc=$?
echo "--- Q: image pinned (exit $rc)"
E="$WORK/conn-q/.env"
check "exit 0"                              "[ $rc -eq 0 ]"
check "pinned image pulled and run"         "grep -q '^docker pull payramapp/payram-shopify:1.4.2' '$FAKE_LOG' && grep '^docker run -d' '$FAKE_LOG' | grep -q 'payramapp/payram-shopify:1.4.2$'"
check "pin recorded in .env"                "[ \"\$(envval CONNECTOR_IMAGE '$E')\" = payramapp/payram-shopify:1.4.2 ]"
check "says it is pinned"                   "grep -q 'Image pinned by CONNECTOR_IMAGE' '$WORK/out.txt'"
: > "$FAKE_LOG"; export FAKE_EXISTING_BIND="127.0.0.1"
printf '%s\n' '' | PAYRAM_INSTALL_DIR="$WORK/conn-q" run_installer; rc=$?
check "Q: re-run without the variable keeps the pin (exit $rc)" "[ $rc -eq 0 ] && grep -q '^docker pull payramapp/payram-shopify:1.4.2' '$FAKE_LOG' && ! grep -q ':latest' '$FAKE_LOG'"

# ── Scenario R: PORT from .env, not from the environment
new_work; mkdir conn-r
export FAKE_EXISTING_BIND="127.0.0.1"
E="$WORK/conn-r/.env"; write_env r 'PORT=3000' > "$E"
printf '%s\n' "$WORK/conn-r" '' | PORT=4444 run_installer; rc=$?
echo "--- R: custom PORT (exit $rc)"
check "exit 0"                              "[ $rc -eq 0 ]"
check "published as 3000:3000"              "grep -q -- '-p 127.0.0.1:3000:3000' '$FAKE_LOG'"
check "probed on 3000"                      "grep -q 'curl .*127.0.0.1:3000/healthz' '$FAKE_LOG'"
check "caller's PORT ignored"               "! grep -q '4444' '$FAKE_LOG' && ! grep -q '4444' '$WORK/out.txt'"
check "no literal 2798 left in the output"  "! grep -q '2798' '$WORK/out.txt'"
[ $rc -ne 0 ] && tail -20 "$WORK/out.txt"

# ── Scenario S: a bad hand-set ENCRYPTION_KEY is refused before anything starts
new_work; mkdir conn-s
E="$WORK/conn-s/.env"; write_env s | sed 's/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=not-a-key/' > "$E"
printf '%s\n' "$WORK/conn-s" '' | run_installer; rc=$?
echo "--- S: bad ENCRYPTION_KEY (exit $rc)"
check "non-zero exit"                       "[ $rc -ne 0 ]"
check "says what is wrong and how to fix"   "grep -q 'not a 64-character hex string' '$WORK/out.txt' && grep -q 'openssl rand -hex 32' '$WORK/out.txt'"
check "no container started"                "! grep -q '^docker run -d' '$FAKE_LOG'"

cd "$S" || exit 1
if [ $fail -eq 0 ]; then echo "ALL PASSED"; else echo "SOME FAILED"; exit 1; fi
