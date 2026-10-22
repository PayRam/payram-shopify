#!/usr/bin/env bash
# =============================================================================
# Payram Shopify Connector — Self-Hosted Installer
#
# Only requires Docker, curl and openssl on the host. No Node.js needed.
# Runs under the system bash on Linux and macOS (bash 3.2+).
#
# Usage:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/PayRam/payram-shopify/main/setup_payram_shopify.sh)"
#   … --reset            remove the container, volumes and generated files
#   … --help             usage and every environment override
#
# Unattended runs (CI, an agent): every question has an environment override —
# PAYRAM_INSTALL_DIR, SHOPIFY_APP_URL, SHOPIFY_STORE_DOMAIN — and a question
# with nobody to answer it either takes its default or stops and names the
# variable. A first install additionally needs SHOPIFY_API_KEY (the Client ID
# of an app created in the Partner Dashboard) or a terminal; the Shopify login
# itself always needs a person to open the printed link. Values already in .env
# win over the environment on a re-run — edit .env to change them.
#
# Settings that live in .env and are never asked: CONNECTOR_IMAGE (pin a tag or
# @sha256 digest instead of following :latest), CONNECTOR_BIND_ADDRESS (where
# the port is published — see "Where the container listens"), PORT (the port
# the connector listens on; published and probed under the same number).
#
# =============================================================================
set -euo pipefail

# Every file this script creates holds or touches a secret: .env carries the
# Shopify client secret, the key that encrypts stored Payram API keys and the
# database password. Create them owner-only from the first byte. Writing a file
# and chmod-ing it afterwards leaves a window in which it is world-readable.
umask 077

# Service managers, cron and some CI runners start jobs without HOME; under
# `set -u` the default install directory below would abort the run before the
# first message. Ask the account database, else fall back to the current dir.
if [ -z "${HOME:-}" ]; then
  HOME="$(cd ~ 2>/dev/null || true; pwd)"
  export HOME
fi

DEFAULT_DOCKER_IMAGE="payramapp/payram-shopify:latest"
DEFAULT_INSTALL_DIR="$HOME/payram-shopify-connector"
DEFAULT_CONTAINER_PORT=2798
# Only the reverse proxy or tunnel should be able to reach the connector; the
# public entry point is always HTTPS on 443. See "Where the container listens".
DEFAULT_BIND_ADDRESS="127.0.0.1"

# Where prompts read their answers from. Under `curl ... | bash` fd 0 IS the
# script: a plain `read` would consume (and skip) the next line of this file as
# the answer. Do not `exec </dev/tty` either — bash reads a piped script
# incrementally from fd 0, so moving it makes the rest of the installer come
# from the keyboard. Open the terminal on its own fd and read prompts from that.
# Automation (and the regression harness) pipes answers on stdin and sets
# PAYRAM_INSTALLER_ANSWERS_ON_STDIN=1 to opt out.
PROMPT_FD=0
if [ ! -t 0 ] && [ -z "${PAYRAM_INSTALLER_ANSWERS_ON_STDIN:-}" ] && ( exec 3</dev/tty ) 2>/dev/null; then
  exec 3</dev/tty
  PROMPT_FD=3
fi

# ── argument parsing ──────────────────────────────────────────────────────────
RESET_MODE=false
# When this script is piped into `bash -c`, the first post-script token becomes
# `$0` rather than part of `$@`. Include it when it looks like a flag so
# invocations such as `/bin/bash -c "$(curl ...)" --reset` work as expected.
# The ${arr[@]+"${arr[@]}"} form is how an array that may be empty is expanded
# under `set -u` on bash 3.2 (macOS) and 4.0-4.3; a bare "${arr[@]}" aborts
# with "unbound variable" before the first prompt.
INSTALLER_ARGS=("$@")
if [[ "${0:-}" == --* ]]; then
  INSTALLER_ARGS=("$0" ${INSTALLER_ARGS[@]+"${INSTALLER_ARGS[@]}"})
fi

usage() {
  cat <<USAGE
Payram Shopify Connector installer

  /bin/bash -c "\$(curl -fsSL https://raw.githubusercontent.com/PayRam/payram-shopify/main/setup_payram_shopify.sh)" [--reset]

  (no flag)   install, or upgrade an existing install in place (re-run the same command)
  --reset     stop the connector, delete its volumes and generated files
  --help      this text

Environment overrides, for unattended runs (values already in .env win on a re-run):
  PAYRAM_INSTALL_DIR     install directory        (default ~/payram-shopify-connector)
  SHOPIFY_APP_URL        public https:// URL of the connector
  SHOPIFY_STORE_DOMAIN   <store>.myshopify.com
  SHOPIFY_API_KEY        Client ID of an app created in the Partner Dashboard (first install only)
  CONNECTOR_IMAGE        image to run              (default payramapp/payram-shopify:latest)
  NO_COLOR               plain output
USAGE
}

for arg in ${INSTALLER_ARGS[@]+"${INSTALLER_ARGS[@]}"}; do
  case "$arg" in
    --reset) RESET_MODE=true ;;
    --help|-h) usage; exit 0 ;;
    # An unrecognised flag is almost always a typo of --reset; installing
    # instead would be the one thing the person did not ask for.
    -*) echo "Unknown option: ${arg}" >&2; echo "" >&2; usage >&2; exit 2 ;;
  esac
done

# ── colours ──────────────────────────────────────────────────────────────────
# Only when a person is looking. Captured by an agent or written to a log, the
# escape codes are noise around the one line the reader needs. NO_COLOR honoured.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"; RED="\033[31m"; RESET="\033[0m"
else
  BOLD=""; GREEN=""; YELLOW=""; CYAN=""; RED=""; RESET=""
fi

info()  { echo -e "${GREEN}[payram]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[payram]${RESET} $*"; }
step()  { echo -e "\n${CYAN}${BOLD}▶ $*${RESET}"; }
die()   { echo -e "\n${RED}[payram] ERROR:${RESET} $*\n" >&2; exit 1; }

# ── prompts ──────────────────────────────────────────────────────────────────
# ask VAR "question" [may-be-empty]
#
# Every question goes through here so a run with nobody at the keyboard behaves
# predictably. `read` on an exhausted stdin returns 1, and under `set -e` that
# ended the script with no message at all — which is what an agent driving this
# installer used to see. The rules:
#   • VAR already set in the environment  → that is the answer, nothing asked
#     (how automation pre-answers: PAYRAM_INSTALL_DIR=/srv/payram bash setup…)
#   • a line can be read                  → that is the answer
#   • nothing to read, empty is allowed   → empty, which callers take as "default"
#   • nothing to read, an answer required → stop, naming the variable to pre-set
# When answers do not come from a terminal the question is echoed as well, so a
# captured log reads as a transcript (`read -p` prints only to a terminal).
ask() {
  local var="$1" question="$2" answer="" prompt=""
  if [ -n "${!var:-}" ]; then
    echo -e "${question} ${CYAN}${!var}${RESET}  (from environment)"
    return 0
  fi
  if [ -t "$PROMPT_FD" ]; then
    prompt="$(echo -e "${question}") "
  else
    echo -en "${question} "
  fi
  if read -u "$PROMPT_FD" -rp "$prompt" answer; then
    [ -t "$PROMPT_FD" ] || echo "$answer"
  else
    echo ""
    if [ $# -ge 3 ]; then
      warn "No input available — using the default."
    else
      die "No terminal is attached and nothing answered: $(echo -e "${question}")
  Pre-set ${var} in the environment and re-run."
    fi
  fi
  printf -v "$var" '%s' "$answer"
}

# ── banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}"
echo "  ██████╗  █████╗ ██╗   ██╗██████╗  █████╗ ███╗   ███╗"
echo "  ██╔══██╗██╔══██╗╚██╗ ██╔╝██╔══██╗██╔══██╗████╗ ████║"
echo "  ██████╔╝███████║ ╚████╔╝ ██████╔╝███████║██╔████╔██║"
echo "  ██╔═══╝ ██╔══██║  ╚██╔╝  ██╔══██╗██╔══██║██║╚██╔╝██║"
echo "  ██║     ██║  ██║   ██║   ██║  ██║██║  ██║██║ ╚═╝ ██║"
echo "  ╚═╝     ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝"
echo ""
echo "  Shopify Connector — Self-Hosted Setup"
echo -e "${RESET}"

# =============================================================================
# --reset: wipe everything and exit
# =============================================================================
if [ "$RESET_MODE" = true ]; then
  step "Reset — removing all Payram Shopify Connector data"

  ask PAYRAM_INSTALL_DIR "${BOLD}Install directory to reset${RESET} [${DEFAULT_INSTALL_DIR}]:" may-be-empty
  RESET_DIR="${PAYRAM_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
  RESET_DIR="${RESET_DIR/#\~/$HOME}"

  echo ""
  warn "This will:"
  warn "  • Stop and remove container: payram-shopify-connector"
  warn "  • Delete Docker volumes:     payram-shopify-data, payram-shopify-cli-auth"
  warn "  • Delete .env, shopify.app.toml and any leftover deploy files in: ${RESET_DIR}"
  echo ""
  confirm=""
  ask confirm "${RED}${BOLD}Type 'yes' to confirm reset:${RESET}" may-be-empty
  [ "$confirm" != "yes" ] && { info "Reset cancelled."; exit 0; }

  echo ""
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^payram-shopify-connector$'; then
    docker stop payram-shopify-connector >/dev/null 2>&1 || true
    docker rm   payram-shopify-connector >/dev/null 2>&1 || true
    info "Container removed."
  else
    info "No container found — skipping."
  fi

  for vol in payram-shopify-data payram-shopify-cli-auth; do
    if docker volume rm "$vol" >/dev/null 2>&1; then
      info "Volume ${vol} removed."
    else
      info "Volume ${vol} not found — skipping."
    fi
  done

  # .shopify-creds.env / .payram-deploy.sh only exist if an earlier run died
  # mid-deploy; the first holds the Shopify client secret, so a reset must not
  # leave it behind.
  for f in .env shopify.app.toml .shopify-creds.env .payram-deploy.sh; do
    if [ -f "${RESET_DIR}/${f}" ]; then
      rm -f "${RESET_DIR}/${f}" && info "Removed ${RESET_DIR}/${f}"
    fi
  done

  echo ""
  info "Reset complete. Re-run the installer to start fresh."
  exit 0
fi

# =============================================================================
# STEP 1 — Prerequisites
# =============================================================================
step "Checking prerequisites"

command -v docker >/dev/null 2>&1 || die "Docker is required but not installed.
  Install from: https://docs.docker.com/get-docker/"
# openssl generates the secrets, curl runs the reachability check. Failing here
# beats failing at step 8 with a bare "command not found" after the merchant
# has already logged in to Shopify.
command -v curl    >/dev/null 2>&1 || die "curl is required but not installed."
command -v openssl >/dev/null 2>&1 || die "openssl is required but not installed."

# `docker info` fails for two unrelated reasons that used to get one message:
# the daemon is down, or (the Linux default) this user may not open its socket.
# Telling someone whose Docker is running fine to "start Docker" sends them
# the wrong way; the usual next move is to retry under sudo, which then puts
# the install directory in /root and ties every future re-run to sudo too.
if ! docker_error="$(docker info 2>&1 >/dev/null)"; then
  docker_error="${docker_error%%$'\n'*}"
  case "$docker_error" in
    *ermission\ denied*)
      die "Docker is running, but this user is not allowed to use it:
  ${docker_error}
  Add yourself to the docker group, then log out and back in:
      sudo usermod -aG docker ${SUDO_USER:-$(id -un)}
  (or run this installer with sudo every time — the install directory and .env
  are then owned by root)." ;;
    *)
      die "Docker is installed but not running. Start Docker and try again.
  (docker info said: ${docker_error})" ;;
  esac
fi
if [ -n "${SUDO_USER:-}" ]; then
  warn "Running under sudo: the files go to ${DEFAULT_INSTALL_DIR} owned by root,"
  warn "and every re-run needs sudo as well."
fi

info "docker $(docker --version | awk '{print $3}' | tr -d ',')"

# =============================================================================
# STEP 2 — Install directory
# =============================================================================
step "Install location"

ask PAYRAM_INSTALL_DIR "${BOLD}Install directory${RESET} [${DEFAULT_INSTALL_DIR}]:" may-be-empty
INSTALL_DIR="${PAYRAM_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

mkdir -p "$INSTALL_DIR"
# Resolve to an absolute path before anything records it. The .env path, the
# Docker bind mount and the credentials hand-off all assume one; a relative
# answer such as ./connector would point somewhere else after the cd below.
# (CDPATH unset in the subshell: with it set, `cd connector` can land in a
# same-named directory elsewhere and echo that path into the result.)
INSTALL_DIR="$(unset CDPATH; cd -- "$INSTALL_DIR" && pwd -P)" || die "Cannot enter ${INSTALL_DIR}."
cd "$INSTALL_DIR"

# =============================================================================
# Helpers for .env
# =============================================================================
ENV_FILE="${INSTALL_DIR}/.env"

# Earlier installers created .env with the default umask (world-readable).
# Tighten it on every run, not only on creation, so existing installs are
# fixed the next time the merchant upgrades.
[ -f "$ENV_FILE" ] || : > "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Docker's --env-file hands each line to the container verbatim. Two things a
# hand edit commonly introduces therefore end up INSIDE the variable: a \r from
# a Windows editor, and quotes around the value (the dotenv habit). The app then
# fails on an app URL that ends in a carriage return or starts with a quote,
# and nothing in its log says why. Read the file the way the container will
# see it, remember what needs fixing, and rewrite those lines after loading.
ENV_HAS_CR=false
ENV_QUOTED_KEYS=""
load_env() {
  local line key value
  # `|| [ -n "$line" ]`: a last line without a newline is still a line.
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" != "${line%$'\r'}" ]; then
      line="${line%$'\r'}"
      ENV_HAS_CR=true
    fi
    case "$line" in ''|\#*) continue ;; esac
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$value" == \"*\" || "$value" == \'*\' ]] && [ "${#value}" -ge 2 ]; then
      value="${value:1:${#value}-2}"
      ENV_QUOTED_KEYS="${ENV_QUOTED_KEYS} ${key}"
    fi
    export "$key=$value" 2>/dev/null || true
  done < "$ENV_FILE"
}

# Replace-or-append KEY=VALUE. The value is written verbatim rather than through
# sed, so a database password containing | & or \ can neither corrupt the file
# nor be misread as a pattern. The rewrite goes through a temp file in the same
# directory and a rename, so an interrupted run cannot leave a truncated .env.
set_env() {
  local var="$1" val="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  {
    grep -v "^${var}=" "$ENV_FILE" 2>/dev/null || true
    printf '%s=%s\n' "$var" "$val"
  } > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
  export "${var}=${val}"
}

load_env

if [ "$ENV_HAS_CR" = true ] || [ -n "$ENV_QUOTED_KEYS" ]; then
  warn "Normalising ${ENV_FILE}:${ENV_HAS_CR:+ Windows line endings}${ENV_QUOTED_KEYS:+ quoted values (${ENV_QUOTED_KEYS# })}"
  warn "— Docker would pass both into the container as part of the value."
  if [ "$ENV_HAS_CR" = true ]; then
    env_tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
    tr -d '\r' < "$ENV_FILE" > "$env_tmp"
    chmod 600 "$env_tmp"
    mv -f "$env_tmp" "$ENV_FILE"
  fi
  for key in $ENV_QUOTED_KEYS; do
    set_env "$key" "${!key}"
  done
fi

# CONNECTOR_IMAGE pins the image — a version tag or an @sha256 digest — instead
# of following :latest. From the environment on a first run it is written to
# .env, so the pin holds on every re-run until the line is removed. Hosts that
# must not move until someone decides so get a pin; everyone else gets :latest.
DOCKER_IMAGE="${CONNECTOR_IMAGE:-$DEFAULT_DOCKER_IMAGE}"
if [ -n "${CONNECTOR_IMAGE:-}" ]; then
  grep -q '^CONNECTOR_IMAGE=' "$ENV_FILE" || set_env CONNECTOR_IMAGE "$CONNECTOR_IMAGE"
  info "Image pinned by CONNECTOR_IMAGE: ${DOCKER_IMAGE} (remove the line from .env to follow :latest)"
fi

# PORT is read from .env only, never from the caller's environment: CI runners
# and PaaS shells commonly export an unrelated PORT. Inside the container the
# entrypoint listens on it, so publish and probe the same number on the host.
env_port="$(grep '^PORT=' "$ENV_FILE" | cut -d= -f2- || true)"
CONTAINER_PORT="${env_port:-$DEFAULT_CONTAINER_PORT}"
if ! [[ "$CONTAINER_PORT" =~ ^[0-9]+$ ]] || [ "$CONTAINER_PORT" -lt 1 ] || [ "$CONTAINER_PORT" -gt 65535 ]; then
  die "PORT in ${ENV_FILE} is '${CONTAINER_PORT}', which is not a port number."
fi

# A Shopify secret already on disk means this is a re-run of an existing
# install. Step 8 uses that to keep outstanding payment links valid.
PREVIOUS_API_SECRET="${SHOPIFY_API_SECRET:-}"

# =============================================================================
# STEP 3 — App URL (needed before app creation)
# =============================================================================
step "Server URL"

warn "This must be the public HTTPS URL where this Shopify connector is reachable."
warn "If using Cloudflare Tunnel, the URL changes on every restart — update it here."
warn "Examples: https://your-tunnel.trycloudflare.com  or  https://payram.yourstore.com"
echo ""

# _read_app_url VAR — asks until VAR holds an https:// URL. It fills the
# caller's variable rather than echoing the answer: with no terminal attached,
# ask() writes the question to stdout too, and on a fresh install the variable
# is SHOPIFY_APP_URL itself, so an unattended run that stops here is told to
# pre-set the name it actually needs.
# _app_url_problem URL — prints why URL cannot be the app URL; nothing if it can.
# The connector owns a whole hostname: Shopify calls /auth, /webhooks and
# /api/payram/… directly under it and the app proxy adds no prefix, so a URL
# with a path would "work" in the browser and 404 for every Shopify callback.
_app_url_problem() {
  local url="$1" host="${1#https://}"
  if [ -z "$url" ]; then
    echo "URL cannot be empty. Enter the full https:// address."
  elif [[ "$url" != https://* ]]; then
    echo "URL must start with https:// — got: ${url}"
  elif [[ "$host" == */* || "$host" == *\?* || "$host" == *\#* ]]; then
    echo "The connector must be served at the root of its hostname — no path. Got: ${url}
  Use https://${host%%[/?#]*} and route that whole hostname to the connector."
  elif [[ "$host" != *.* || "$host" == localhost* || "$host" == 127.* ]]; then
    echo "Shopify and your buyers must reach this URL from the internet — got: ${url}"
  fi
}

_read_app_url() {
  local var="$1" problem
  while true; do
    ask "$var" "${BOLD}Public HTTPS App URL (no trailing slash):${RESET}"
    printf -v "$var" '%s' "${!var//[[:space:]]/}"
    printf -v "$var" '%s' "${!var%/}"
    problem="$(_app_url_problem "${!var}")"
    [ -z "$problem" ] && return 0
    warn "$problem"
    # '%s' with an empty argument, not an empty format: on bash 3.2 the
    # latter is a no-op and the rejected answer would be asked again forever.
    printf -v "$var" '%s' ''
  done
}

if [ -z "${SHOPIFY_APP_URL:-}" ]; then
  _read_app_url SHOPIFY_APP_URL
  set_env SHOPIFY_APP_URL "$SHOPIFY_APP_URL"
else
  echo -e "  Current App URL: ${CYAN}${SHOPIFY_APP_URL}${RESET}"
  app_url_update=""
  ask app_url_update "${BOLD}Press Enter to keep it, or type a new URL:${RESET}" may-be-empty
  app_url_update="${app_url_update//[[:space:]]/}"
  app_url_update="${app_url_update%/}"
  if [ -n "$app_url_update" ]; then
    problem="$(_app_url_problem "$app_url_update")"
    if [ -n "$problem" ]; then
      warn "$problem"
      app_url_update=""
      _read_app_url app_url_update
    fi
    set_env SHOPIFY_APP_URL "$app_url_update"
    SHOPIFY_APP_URL="$app_url_update"
    info "App URL updated to: ${SHOPIFY_APP_URL}"
  else
    info "Keeping existing App URL: ${SHOPIFY_APP_URL}"
  fi
fi

# Who answers the Shopify CLI? Logging in happens in a browser — the CLI prints
# the link, and the image's xdg-open stub makes sure of that on a headless box.
# Choosing the organisation and creating the app happen HERE, in the terminal,
# and an unattended run has nobody to answer: it would sit on that question
# forever. Say so now, before the image pull and the login, and say what the
# unattended path is.
HAS_TERMINAL=false
if [ -t 0 ] || [ "$PROMPT_FD" = 3 ]; then HAS_TERMINAL=true; fi
if [ -z "${SHOPIFY_API_KEY:-}" ] && [ "$HAS_TERMINAL" != true ]; then
  die "First-time setup needs a terminal: the Shopify CLI asks which organisation to use and whether to create the app, and nobody is here to answer.
  Either run this once from an interactive terminal, or create the app in the Shopify Partner Dashboard first and pre-set SHOPIFY_API_KEY=<its Client ID> — the login link is then the only step that needs a person, and the installer prints it."
fi

# =============================================================================
# STEP 4 — Image
# =============================================================================
step "Pulling Docker image"
info "Pulling ${DOCKER_IMAGE} ..."
docker pull "$DOCKER_IMAGE" || die "Could not pull ${DOCKER_IMAGE}.
  Check this machine's network access (and Docker Hub's pull rate limit), then re-run."
# Say which build this is. The image bakes its version into the environment
# (PAYRAM_VERSION) and the registry digest pins the exact bytes — the two things
# support asks for first, and the only way to tell two ":latest" pulls apart.
IMAGE_VERSION="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DOCKER_IMAGE" 2>/dev/null | sed -n 's/^PAYRAM_VERSION=//p')"
IMAGE_DIGEST="$(docker image inspect -f '{{index .RepoDigests 0}}' "$DOCKER_IMAGE" 2>/dev/null || true)"
IMAGE_DIGEST="${IMAGE_DIGEST##*@sha256:}"
info "Connector ${IMAGE_VERSION:-(version not recorded in image)}${IMAGE_DIGEST:+ — image sha256:${IMAGE_DIGEST:0:12}}"

# =============================================================================
# STEP 5 — Shopify app credentials (via CLI)
# =============================================================================
step "Shopify app credentials & extension deploy"

# Persistent volume for CLI auth state — survives between docker run invocations
docker volume create payram-shopify-cli-auth >/dev/null 2>&1 || true

# Write shopify.app.toml.
# client_id is empty on first run (CLI will link to new/existing app interactively).
# client_id is set on re-runs so the CLI deploys to the known app without prompting.
#
# SCOPES ARE DECLARED IN THREE PLACES AND ALL THREE MUST AGREE:
#   1. this generated toml  -> what the app declares to Shopify at deploy time
#   2. set_env SCOPES below -> what the running server requests during OAuth
#   3. repo shopify.app.toml -> the checked-in reference (overwritten by 1)
# Changing only some of them fails silently: the merchant grants one set and the
# server expects another, and the mismatch only shows up when a call needing the
# missing scope returns 403 in production.
printf '%s\n' \
  'name = "payram-checkout-plugin"' \
  "client_id = \"${SHOPIFY_API_KEY:-}\"" \
  "application_url = \"${SHOPIFY_APP_URL}\"" \
  'embedded = true' \
  '' \
  '[access_scopes]' \
  'scopes = "read_orders,write_orders,read_customers,write_customers,write_app_proxy,write_gift_cards"' \
  '' \
  '[auth]' \
  'redirect_urls = [' \
  "  \"${SHOPIFY_APP_URL}/auth/callback\"," \
  "  \"${SHOPIFY_APP_URL}/auth/shopify/callback\"," \
  "  \"${SHOPIFY_APP_URL}/api/auth/callback\"," \
  ']' \
  '' \
  '[webhooks]' \
  'api_version = "2026-01"' \
  '' \
  '  [[webhooks.subscriptions]]' \
  '  topics = ["app/uninstalled"]' \
  '  uri = "/webhooks"' \
  '' \
  '  [[webhooks.subscriptions]]' \
  '  topics = ["app/scopes_update"]' \
  '  uri = "/webhooks"' \
  '' \
  '[pos]' \
  'embedded = false' \
  '' \
  '[app_proxy]' \
  'url = "/api/payram"' \
  'prefix = "apps"' \
  'subpath = "payram-checkout-plugin"' \
  > "${INSTALL_DIR}/shopify.app.toml"

if [ -z "${SHOPIFY_API_KEY:-}" ]; then
  info "A Shopify login link will be printed below — open it in any browser."
  warn "Choose 'Create new app' when prompted for the app."
  echo ""
else
  info "Re-using existing credentials — redeploying extension to update."
  if [ "$HAS_TERMINAL" = true ]; then
    info "If the login has expired, a new login link is printed; open it in any browser."
  else
    warn "ACTION REQUIRED if the Shopify login has expired: a line starting"
    warn "'Open this link to start the auth process' and a verification code appear"
    warn "below. Whoever supervises this run must open that link and sign in; the"
    warn "installer waits until they do."
  fi
  echo ""
fi

DEPLOY_SCRIPT="${INSTALL_DIR}/.payram-deploy.sh"
CREDS_FILE="${INSTALL_DIR}/.shopify-creds.env"
# The credentials dump must not outlive this run, whichever way the run ends.
# A deploy that dies after `env pull` used to leave the Shopify client secret
# sitting in the install directory.
cleanup_deploy_files() { rm -f "$DEPLOY_SCRIPT" "$CREDS_FILE"; }
trap cleanup_deploy_files EXIT

cat > "$DEPLOY_SCRIPT" <<'EOF'
#!/bin/sh
set -e
umask 077
APP_URL="${SHOPIFY_APP_URL%/}"
if [ -z "$APP_URL" ]; then
  echo "[payram-deploy] SHOPIFY_APP_URL is required" >&2
  exit 1
fi

sed -i "s|__PAYRAM_REDIRECT_BASE_URL__|${APP_URL}|g" /app/extensions/thank-you-block/src/Checkout.tsx
cp /workspace/shopify.app.toml /app/shopify.app.toml
CLIENT_ID_BEFORE=$(grep '^client_id' /app/shopify.app.toml | sed 's/.*= *//' | tr -d '"' | tr -d "'")
# Save our desired toml (with app_proxy) before the link step overwrites it.
# With an empty client_id the CLI treats the config as unlinked, runs 'app
# config link' inside deploy, and that pulls the remote config (no proxy)
# over the toml. A non-empty client_id is all it checks for "linked" (cli
# 3.94, active-config.ts), so on a re-run the toml is never touched.
cp /app/shopify.app.toml /app/shopify.app.desired.toml
# Deploy: login if needed, link on a first run, then app config + extension.
npx shopify app deploy --allow-updates
if [ -z "$CLIENT_ID_BEFORE" ]; then
  # First run only: put our toml back with the client_id the link produced
  # and deploy once more so Shopify holds the app_proxy section. On a re-run
  # the deploy above already carried it, and a second one would only add a
  # duplicate app version — and a minute — to every upgrade.
  LINKED_CLIENT_ID=$(grep '^client_id' /app/shopify.app.toml | sed 's/.*= *//' | tr -d '"' | tr -d "'")
  cp /app/shopify.app.desired.toml /app/shopify.app.toml
  if [ -n "$LINKED_CLIENT_ID" ]; then
    sed -i "s/^client_id = .*/client_id = \"${LINKED_CLIENT_ID}\"/" /app/shopify.app.toml
  fi
  echo '[payram-deploy] Second deploy app_proxy section:'
  grep -A3 '^\[app_proxy\]' /app/shopify.app.toml || true
  npx shopify app deploy --allow-updates
fi
npx shopify app env pull
# This container runs as root; the merchant's shell does not. Hand the files
# back owned by the invoking user so they can be read with mode 600 — the
# previous workaround was to make the client secret world-readable (0644).
cp /app/.env /workspace/.shopify-creds.env
cp /app/shopify.app.toml /workspace/shopify.app.toml
chown "${HOST_UID}:${HOST_GID}" /workspace/.shopify-creds.env /workspace/shopify.app.toml
chmod 600 /workspace/.shopify-creds.env
echo '[payram-deploy] SUCCESS'
EOF
chmod 700 "$DEPLOY_SCRIPT"

# Who should own the files the deploy container hands back. Normally the
# invoking user. Under rootless Docker the container's root already IS the
# invoking user on the host, and chown-ing to our numeric uid would map it to a
# subordinate uid we cannot read — so there the right owner is root (0).
DEPLOY_OWNER_UID="$(id -u)"
DEPLOY_OWNER_GID="$(id -g)"
if docker info --format '{{join .SecurityOptions ","}}' 2>/dev/null | grep -q 'rootless'; then
  DEPLOY_OWNER_UID=0
  DEPLOY_OWNER_GID=0
fi

# Single Docker run: handles auth (fresh or expired), deploys app + extension,
# pulls credentials. Works identically on first run and re-runs.
#
# XDG_CONFIG_HOME: the CLI keeps its login in $XDG_CONFIG_HOME/shopify-cli-kit-
# nodejs (default ~/.config/…), NOT in ~/.config/shopify where this volume used
# to be mounted alone. The volume stayed empty, and every re-run demanded a
# fresh browser login. Pointing the CLI's config root at the volume is what
# makes "If the login has expired" the exception rather than the rule.
#
# CLOUD_SHELL: when the CLI needs a login it normally prints a verification
# code, says "Press any key to open the login page on your browser", and does
# not start waiting for the login until a key is pressed (cli-kit
# device-authorization.ts). Inside a container the browser can never open; the
# image's xdg-open stub only prints the URL. And an unattended run has nobody
# to press the key, so it would hang there. The CLI treats CLOUD_SHELL as a
# cloud IDE and prints the login link straight away instead, then polls.
# The install directory is bind-mounted into the deploy container. Two hosts
# refuse that silently: SELinux in enforcing mode (Fedora, RHEL, Rocky) labels
# the directory so the container gets "permission denied" on its own script —
# `:z` asks Docker to relabel it as shared — and Docker Desktop on macOS only
# shares a few top-level directories, failing the mount for anything else.
WORKSPACE_MOUNT="${INSTALL_DIR}:/workspace"
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" = Enforcing ]; then
  WORKSPACE_MOUNT="${WORKSPACE_MOUNT}:z"
fi
if [ "$(uname -s)" = Darwin ]; then
  case "$INSTALL_DIR" in
    /Users/*|/Volumes/*|/private/*|/tmp/*|/var/folders/*) ;;
    *) warn "Docker Desktop shares only /Users, /Volumes, /private and /tmp by default."
       warn "If the next step fails to mount ${INSTALL_DIR}, add it under"
       warn "Docker Desktop → Settings → Resources → File sharing, and re-run." ;;
  esac
fi

DOCKER_DEPLOY_ARGS=(
  docker run --rm -it
  --user root
  -e "SHOPIFY_APP_URL=${SHOPIFY_APP_URL}"
  -e "HOST_UID=${DEPLOY_OWNER_UID}"
  -e "HOST_GID=${DEPLOY_OWNER_GID}"
  -e XDG_CONFIG_HOME=/root/.config/shopify
  -e CLOUD_SHELL=1
  -v payram-shopify-cli-auth:/root/.config/shopify
  -v "$WORKSPACE_MOUNT"
  "$DOCKER_IMAGE"
  sh /workspace/.payram-deploy.sh
)

if [ -t 0 ]; then
  "${DOCKER_DEPLOY_ARGS[@]}" || die "App deploy failed. See output above."
elif [ "$PROMPT_FD" = 3 ]; then
  # Piped script, but we hold the terminal on fd 3: hand it to docker -it.
  "${DOCKER_DEPLOY_ARGS[@]}" <&3 || die "App deploy failed. See output above."
else
  command -v script >/dev/null 2>&1 || die "This installer needs a TTY for Shopify login. Install 'script' (util-linux) or run it from an interactive terminal."
  printf -v DOCKER_DEPLOY_CMD '%q ' "${DOCKER_DEPLOY_ARGS[@]}"
  # Two different programs answer to `script`. util-linux (Linux) takes the
  # command via -c and runs it with $SHELL; BSD/macOS takes it positionally
  # after the file and rejects -c outright. Only util-linux knows --version.
  # The command is %q-quoted for bash, so it must run under bash either way.
  if script --version >/dev/null 2>&1; then
    SHELL="$BASH" script -qec "$DOCKER_DEPLOY_CMD" /dev/null || die "App deploy failed. See output above."
  else
    script -qe /dev/null "$BASH" -c "$DOCKER_DEPLOY_CMD" || die "App deploy failed. See output above."
  fi
fi

rm -f "$DEPLOY_SCRIPT"

[ ! -f "${CREDS_FILE}" ] && die "Credentials file not found after deploy."

NEW_API_KEY=$(grep    '^SHOPIFY_API_KEY='    "${CREDS_FILE}" | cut -d'=' -f2- | tr -d '"\r')
NEW_API_SECRET=$(grep '^SHOPIFY_API_SECRET=' "${CREDS_FILE}" | cut -d'=' -f2- | tr -d '"\r')
rm -f "${CREDS_FILE}"

[ -z "${NEW_API_KEY}" ]    && die "Could not read SHOPIFY_API_KEY from credentials file."
[ -z "${NEW_API_SECRET}" ] && die "Could not read SHOPIFY_API_SECRET from credentials file."

set_env SHOPIFY_API_KEY    "${NEW_API_KEY}"
set_env SHOPIFY_API_SECRET "${NEW_API_SECRET}"

info "App and extension deployed successfully."
info "  API Key: ${NEW_API_KEY}"

# Normalize SCOPES so existing installs pick up the app proxy permission too.
set_env SCOPES "read_orders,write_orders,read_customers,write_customers,write_app_proxy,write_gift_cards"

# =============================================================================
# STEP 6 — Shopify store domain
# =============================================================================
step "Shopify store"

# Shopify's install flow (/auth?shop=…) accepts only the store's permanent
# <handle>.myshopify.com address, never the custom storefront domain. Accept
# what people actually paste — the admin URL (admin.shopify.com/store/<handle>),
# a storefront URL with a path, upper case, or just the handle — and reduce it.
_normalize_store_domain() {
  local d="$1"
  d="${d//[[:space:]]/}"
  d="$(printf '%s' "$d" | tr '[:upper:]' '[:lower:]')"
  d="${d#https://}"
  d="${d#http://}"
  d="${d#admin.shopify.com/store/}"
  d="${d%%/*}"
  if [ -n "$d" ] && [[ "$d" != *.* ]]; then
    d="${d}.myshopify.com"
  fi
  echo "$d"
}
_is_store_domain() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]*\.myshopify\.com$ ]]; }

if [ -n "${SHOPIFY_STORE_DOMAIN:-}" ] && ! _is_store_domain "$SHOPIFY_STORE_DOMAIN"; then
  # Older installers stored whatever was typed, custom domains included; the
  # install URL built from that is refused by Shopify with no useful message.
  warn "SHOPIFY_STORE_DOMAIN in .env is ${SHOPIFY_STORE_DOMAIN}, which Shopify will not accept in the install URL."
  SHOPIFY_STORE_DOMAIN=""
fi
if [ -z "${SHOPIFY_STORE_DOMAIN:-}" ]; then
  # Asked, not discovered. This used to run `shopify store list` in a container
  # first — a command the CLI does not have — so every install sat through a
  # 20-second timeout and then "Could not fetch store list" before asking anyway.
  while true; do
    ask SHOPIFY_STORE_DOMAIN "${BOLD}Shopify store domain${RESET} (e.g. your-store.myshopify.com):"
    SHOPIFY_STORE_DOMAIN=$(_normalize_store_domain "$SHOPIFY_STORE_DOMAIN")
    _is_store_domain "$SHOPIFY_STORE_DOMAIN" && break
    warn "Shopify needs the store's .myshopify.com address${SHOPIFY_STORE_DOMAIN:+ — got: ${SHOPIFY_STORE_DOMAIN}}."
    warn "Find it in Shopify Admin → Settings → Domains, or paste your admin URL"
    warn "(admin.shopify.com/store/<handle>) and the address is worked out from it."
    SHOPIFY_STORE_DOMAIN=""
  done
  set_env SHOPIFY_STORE_DOMAIN "$SHOPIFY_STORE_DOMAIN"
  info "Store domain: ${SHOPIFY_STORE_DOMAIN}"
else
  info "SHOPIFY_STORE_DOMAIN already set (${SHOPIFY_STORE_DOMAIN})"
fi

# =============================================================================
# STEP 7 — Database
# =============================================================================
step "Database"

# The image's Prisma client is generated for SQLite only (prisma/schema.prisma:
# provider = "sqlite"). This step used to recommend "postgresql://… for
# production"; a merchant who took that advice got a container that crash-
# looped at `prisma migrate deploy` with "the URL must start with the protocol
# file:", and nothing here said why. The database lives in the
# payram-shopify-data volume — back that volume up along with .env.
if [ -z "${DATABASE_URL:-}" ]; then
  set_env DATABASE_URL "file:/data/prod.sqlite"
  info "SQLite at /data/prod.sqlite, in the payram-shopify-data volume."
elif [[ "$DATABASE_URL" != file:* ]]; then
  die "DATABASE_URL uses ${DATABASE_URL%%:*}:… but this image supports SQLite only (file:…).
  The container would fail at startup while running its migrations. Set
  DATABASE_URL=file:/data/prod.sqlite in ${ENV_FILE} (or delete the line) and re-run."
else
  info "DATABASE_URL already set (SQLite)"
fi

# =============================================================================
# STEP 8 — Secrets
# =============================================================================
step "Secrets"

if [ -z "${ENCRYPTION_KEY:-}" ]; then
  set_env ENCRYPTION_KEY "$(openssl rand -hex 32)"
  warn "Auto-generated ENCRYPTION_KEY written to .env"
  warn "Back this up — losing it makes stored merchant API keys unrecoverable."
elif [[ "$ENCRYPTION_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
  info "ENCRYPTION_KEY already set"
else
  # The app wants exactly 32 bytes as hex and throws on anything else — at the
  # first Settings save, not at startup, so the container looks healthy and the
  # merchant finds out when they try to enter their Payram API key.
  die "ENCRYPTION_KEY in ${ENV_FILE} is not a 64-character hex string (it has ${#ENCRYPTION_KEY} characters).
  The connector cannot encrypt or decrypt Payram API keys with it. Generate one with
      openssl rand -hex 32
  and put it in .env. Any API key saved under the old value must be re-entered in the app's Settings."
fi

# Payment links (/pay/{token}) are signed with PAYMENT_LINK_SECRET and, when it
# is absent, with SHOPIFY_API_SECRET. That fallback means rotating the Shopify
# credentials silently voids every outstanding link — including ones held by
# buyers who have already part-paid. Pin the signer explicitly:
#   • fresh install  → a new random secret;
#   • existing install → the Shopify secret the links were already signed
#     with, so nothing a buyer is holding stops working.
if [ -z "${PAYMENT_LINK_SECRET:-}" ]; then
  if [ -n "$PREVIOUS_API_SECRET" ]; then
    set_env PAYMENT_LINK_SECRET "$PREVIOUS_API_SECRET"
    info "PAYMENT_LINK_SECRET pinned to the signer your existing payment links use."
  else
    set_env PAYMENT_LINK_SECRET "$(openssl rand -hex 32)"
    info "Auto-generated PAYMENT_LINK_SECRET written to .env"
  fi
  warn "Back this up too — losing it invalidates every outstanding payment link."
else
  info "PAYMENT_LINK_SECRET already set"
fi

# =============================================================================
# STEP 9 — Start the container
# =============================================================================
step "Starting the connector"

# Create a named volume for SQLite persistence (ignored if using Postgres)
docker volume create payram-shopify-data >/dev/null 2>&1 || true

# ── Where the container listens on the host ──────────────────────────────────
# The connector must never be the public entry point: Shopify and buyers reach
# it through the HTTPS front door, and nothing else should. New installs bind
# to loopback. A re-run keeps whatever the container it replaces had, so an
# upgrade never silently cuts off a proxy that reaches it another way; the
# merchant moves to loopback by setting CONNECTOR_BIND_ADDRESS=127.0.0.1 in
# .env once their proxy talks to the container directly.
#
# CONNECTOR_BIND_ADDRESS is an address, or one of two words:
#   all   — published on every interface, IPv4 and IPv6 (a bare `-p 2798:2798`;
#           an explicit 0.0.0.0 would be IPv4 only, which is not the same thing)
#   none  — not published at all; reachable only over Docker networks (the
#           containerised-proxy topology)
#
# `docker inspect` rather than `docker port` because the latter reports nothing
# for a container that happens to be stopped. Each binding is emitted with an
# `ip=` prefix so "no bindings" (empty output) is distinguishable from "one
# binding with an empty HostIp" (which is how Docker records a bare -p).
if [ -z "${CONNECTOR_BIND_ADDRESS:-}" ]; then
  CONNECTOR_BIND_ADDRESS="$DEFAULT_BIND_ADDRESS"
  if existing_bindings=$(docker inspect \
       -f '{{range .HostConfig.PortBindings}}{{range .}}ip={{.HostIp}}{{"\n"}}{{end}}{{end}}' \
       payram-shopify-connector 2>/dev/null); then
    first_binding="${existing_bindings%%$'\n'*}"
    if [ -z "$first_binding" ]; then
      CONNECTOR_BIND_ADDRESS="none"
    else
      first_binding="${first_binding#ip=}"
      CONNECTOR_BIND_ADDRESS="${first_binding:-all}"
    fi
    if [ "$CONNECTOR_BIND_ADDRESS" != "$DEFAULT_BIND_ADDRESS" ]; then
      warn "Keeping port ${CONTAINER_PORT} as the existing container had it (CONNECTOR_BIND_ADDRESS=${CONNECTOR_BIND_ADDRESS})."
      warn "Once your proxy reaches the container directly, set CONNECTOR_BIND_ADDRESS=127.0.0.1"
      warn "in ${ENV_FILE} and re-run this installer."
    fi
  elif [ -n "$PREVIOUS_API_SECRET" ]; then
    # An existing install, but no container to read the binding from (removed
    # by hand, e.g. following the README's manual upgrade). Say what is about
    # to change rather than letting the reachability check guess at the cause.
    warn "No existing container to read the port binding from — using ${DEFAULT_BIND_ADDRESS}."
    warn "If your proxy reached the connector via this host's IP, set CONNECTOR_BIND_ADDRESS"
    warn "in ${ENV_FILE} (an address, 'all' or 'none') and re-run this installer."
  fi
  set_env CONNECTOR_BIND_ADDRESS "$CONNECTOR_BIND_ADDRESS"
fi

# Normalise whatever the value is, detected or hand-set: Docker prints IPv6
# addresses bare but only accepts them bracketed in -p.
case "$CONNECTOR_BIND_ADDRESS" in
  \[*\]|all|none) ;;
  *:*) CONNECTOR_BIND_ADDRESS="[${CONNECTOR_BIND_ADDRESS}]" ;;
esac
PUBLISH_ARGS=()
case "$CONNECTOR_BIND_ADDRESS" in
  none) ;;
  all)  PUBLISH_ARGS=(-p "${CONTAINER_PORT}:${CONTAINER_PORT}") ;;
  *)    PUBLISH_ARGS=(-p "${CONNECTOR_BIND_ADDRESS}:${CONTAINER_PORT}:${CONTAINER_PORT}") ;;
esac

# Re-creating the container drops any Docker networks it was attached to —
# which is exactly how a containerised proxy reaches it. Remember them now and
# re-attach after the new container is up. (`|| true`: grep exits 1 when the
# container does not exist or sits on the default bridge only.)
EXTRA_NETWORKS=$(docker inspect \
  -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' \
  payram-shopify-connector 2>/dev/null | grep -vx -e bridge -e host -e none || true)

case "$CONNECTOR_BIND_ADDRESS" in
  none) BIND_DESCRIPTION="not published — Docker networks only" ;;
  all)  BIND_DESCRIPTION="every interface, IPv4 and IPv6" ;;
  *)    BIND_DESCRIPTION="${CONNECTOR_BIND_ADDRESS} only" ;;
esac
# One screen that shows what is about to run. It is where a typo in the URL
# or the wrong store gets caught, and in an unattended log it is the record.
echo ""
echo -e "  ${BOLD}Starting with:${RESET}"
echo -e "    Install directory   ${INSTALL_DIR}"
echo -e "    App URL             ${SHOPIFY_APP_URL}"
echo -e "    Store               ${SHOPIFY_STORE_DOMAIN}"
echo -e "    Image               ${DOCKER_IMAGE}${IMAGE_VERSION:+  (connector ${IMAGE_VERSION})}"
echo -e "    Port ${CONTAINER_PORT}           ${BIND_DESCRIPTION}"
echo -e "    Database            SQLite, volume payram-shopify-data"
echo ""

# Replace the existing container, but keep it until the new one exists. If
# `docker run` is refused — the port taken by something else, a bad line in
# .env — the old container goes back under its name and is started again, so
# a failed upgrade leaves the merchant where they were rather than with nothing.
REPLACED_CONTAINER=""
if docker ps -a --format '{{.Names}}' | grep -q '^payram-shopify-connector$'; then
  warn "Existing container found — stopping and replacing it ..."
  docker stop payram-shopify-connector >/dev/null
  # A leftover from a run whose restore failed would make this rename refuse.
  docker rm -f payram-shopify-connector-replaced >/dev/null 2>&1 || true
  docker rename payram-shopify-connector payram-shopify-connector-replaced >/dev/null
  REPLACED_CONTAINER=payram-shopify-connector-replaced
fi

if ! run_error="$(docker run -d \
    --name payram-shopify-connector \
    --env-file "${ENV_FILE}" \
    ${PUBLISH_ARGS[@]+"${PUBLISH_ARGS[@]}"} \
    -v payram-shopify-data:/data \
    --restart unless-stopped \
    "$DOCKER_IMAGE" 2>&1 >/dev/null)"; then
  warn "Docker refused to start the connector:"
  warn "  ${run_error}"
  if [ -n "$REPLACED_CONTAINER" ]; then
    docker rm -f payram-shopify-connector >/dev/null 2>&1 || true
    if docker rename "$REPLACED_CONTAINER" payram-shopify-connector >/dev/null 2>&1 \
       && docker start payram-shopify-connector >/dev/null 2>&1; then
      warn "Your previous container is back and running — nothing has changed for buyers."
    else
      warn "Could not restore the previous container; it is still there as ${REPLACED_CONTAINER}."
    fi
  fi
  case "$run_error" in
    *"port is already allocated"*|*"address already in use"*)
      die "Port ${CONTAINER_PORT} (${BIND_DESCRIPTION}) is in use by something else.
  Find it with:  sudo lsof -iTCP:${CONTAINER_PORT} -sTCP:LISTEN    (or: docker ps)
  Stop it, or set CONNECTOR_BIND_ADDRESS in ${ENV_FILE} to another address, and re-run." ;;
    *)
      die "Fix the error above and re-run this installer." ;;
  esac
fi
[ -z "$REPLACED_CONTAINER" ] || docker rm "$REPLACED_CONTAINER" >/dev/null 2>&1 || true

for net in $EXTRA_NETWORKS; do
  if docker network connect "$net" payram-shopify-connector >/dev/null 2>&1; then
    info "Re-attached to Docker network ${net}."
  else
    warn "Could not re-attach to Docker network ${net} — run: docker network connect ${net} payram-shopify-connector"
  fi
done

case "$CONNECTOR_BIND_ADDRESS" in
  none) info "Container started — port ${CONTAINER_PORT} not published; reachable over Docker networks only." ;;
  all)  info "Container started — listening on port ${CONTAINER_PORT} on all interfaces." ;;
  *)    info "Container started — listening on ${CONNECTOR_BIND_ADDRESS}:${CONTAINER_PORT}." ;;
esac

# =============================================================================
# STEP 10 — Verify the connector is reachable at the URL Shopify will call
#
# Binding port 2798 is not the same as being reachable. The merchant points a
# hostname at this container with their own reverse proxy, and if that hostname
# has no server block, nginx answers it from its DEFAULT server instead — on a
# box that already runs the Payram dashboard, that means every connector URL
# returns the dashboard's 404 while the installer cheerfully reports success.
# The first person to find out is a buyer staring at a 404 at checkout.
# =============================================================================
step "Verifying the connector is reachable"

HEALTH_MARKER="payram-shopify-connector"
APP_URL="${SHOPIFY_APP_URL%/}"
APP_HOST="${APP_URL#https://}"; APP_HOST="${APP_HOST%%/*}"
URL_REACHABLE=false

# ── 1. Did the container itself come up? ─────────────────────────────────────
CONTAINER_HEALTHY=false
info "Waiting for the container to start ..."
# With the port unpublished there is nothing on the host to probe; ask the
# container directly instead so the check still means "the app came up".
case "$CONNECTOR_BIND_ADDRESS" in
  none) LOCAL_PROBE=(docker exec payram-shopify-connector wget -qO- "http://127.0.0.1:${CONTAINER_PORT}/healthz") ;;
  all)  LOCAL_PROBE=(curl -fsS --max-time 3 "http://127.0.0.1:${CONTAINER_PORT}/healthz") ;;
  *)    LOCAL_PROBE=(curl -fsS --max-time 3 "http://${CONNECTOR_BIND_ADDRESS}:${CONTAINER_PORT}/healthz") ;;
esac
for _ in $(seq 1 30); do
  if "${LOCAL_PROBE[@]}" 2>/dev/null | grep -q "$HEALTH_MARKER"; then
    CONTAINER_HEALTHY=true
    break
  fi
  sleep 1
done

if [ "$CONTAINER_HEALTHY" != true ]; then
  warn "The connector is NOT answering on port ${CONTAINER_PORT} after 30s."
  echo ""
  warn "Last 30 lines of container log:"
  docker logs --tail 30 payram-shopify-connector 2>&1 | sed 's/^/    /' || true
  echo ""
  warn "Fix the error above, then re-run this installer."
else
  info "Container is answering on port ${CONTAINER_PORT}."

  # ── 2. Does the public URL actually arrive at THIS container? ─────────────
  if curl -fsSL --max-time 10 "${APP_URL}/healthz" 2>/dev/null | grep -q "$HEALTH_MARKER"; then
    info "${APP_URL} reaches this connector. ✓"
    URL_REACHABLE=true
  else
    echo ""
    echo -e "${BOLD}${YELLOW}────────────────────────────────────────────────────────────${RESET}"
    echo -e "${BOLD}${YELLOW}  Could not confirm ${APP_URL} reaches this connector${RESET}"
    echo -e "${BOLD}${YELLOW}────────────────────────────────────────────────────────────${RESET}"
    echo ""
    warn "The container is running, but a request to"
    warn "  ${BOLD}${APP_URL}/healthz${RESET}"
    warn "did not come back from it. Until that URL reaches this container,"
    warn "${BOLD}installing the app and every buyer payment link will return 404.${RESET}"
    echo ""
    # Who owns the public front door decides what the fix even is.
    #
    # On a single-server PayRam install the `payram` container publishes 80/443
    # and its bundled nginx is a CATCH-ALL (`listen ... default_server`,
    # `server_name _`) with no conf.d include. It therefore answers for any new
    # hostname, and there is nowhere inside that image to add a vhost that would
    # survive an upgrade. Telling such a merchant to write an nginx block in
    # /etc/nginx is wrong twice over: there is no nginx on the host, and the port
    # it would need is already taken.
    # `|| true`: with pipefail, a grep that matches nothing (no container owns
    # 443) would otherwise abort the installer in the middle of this message.
    FRONT_DOOR=$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null \
      | grep -E '\|.*:443->' \
      | grep -v '^payram-shopify-connector|' \
      | head -1 | cut -d'|' -f1 || true)

    if [ -n "$FRONT_DOOR" ]; then
      warn "Cause: the container ${BOLD}${FRONT_DOOR}${RESET} already owns port 443 on this"
      warn "server, and PayRam's bundled nginx is a ${BOLD}catch-all${RESET} — it answers for"
      warn "${BOLD}every${RESET} hostname, so ${APP_HOST} is being served the PayRam dashboard."
      echo ""
      warn "${BOLD}Do not add an nginx config inside that container.${RESET} Its config is baked"
      warn "into the image and is replaced on every PayRam upgrade."
      echo ""
      echo -e "  ${CYAN}What you need${RESET} is one front door that routes by hostname:"
      echo ""
      echo -e "      :443  ──  front door  ──┬──  ${FRONT_DOOR} container      (PayRam dashboard)"
      echo -e "                              └──  127.0.0.1:${CONTAINER_PORT}           (this connector)"
      echo ""
      echo -e "  ${CYAN}Three ways to get there${RESET} — pick based on your tolerance for restarting"
      echo -e "  the gateway:"
      echo ""
      echo -e "    ${BOLD}1. Containerised proxy${RESET} (Caddy/nginx/Traefik on 80/443). Put both"
      echo -e "       containers on a shared Docker network with no published ports. Routing"
      echo -e "       lives in your config, so it survives PayRam upgrades. Requires"
      echo -e "       re-creating the ${FRONT_DOOR} container without -p 80/-p 443."
      echo -e "       The connector's port is not reachable from other containers via the"
      echo -e "       host IP (CONNECTOR_BIND_ADDRESS=${CONNECTOR_BIND_ADDRESS}); put it on a shared network:"
      echo -e "         docker network create payram-edge"
      echo -e "         docker network connect payram-edge payram-shopify-connector"
      echo -e "       and proxy to http://payram-shopify-connector:${CONTAINER_PORT}"
      echo -e "    ${BOLD}2. Host proxy${RESET} (Caddy is simplest — it gets certificates for both"
      echo -e "       hostnames automatically). Same requirement: free up 80/443 first."
      echo -e "    ${BOLD}3. Cloudflare Tunnel${RESET} for ${APP_HOST} only, pointed at"
      echo -e "       http://localhost:${CONTAINER_PORT}. Needs no host ports and leaves the ${FRONT_DOOR}"
      echo -e "       container untouched — but your DNS must be on Cloudflare."
      echo ""
      echo -e "  ${YELLOW}Before re-creating the ${FRONT_DOOR} container, save its current${RESET}"
      echo -e "  ${YELLOW}configuration — it holds the gateway's environment and volumes:${RESET}"
      echo -e "      docker inspect ${FRONT_DOOR} > ~/${FRONT_DOOR}-container-backup.json"
      echo ""
      echo -e "  ${CYAN}Full step-by-step diagnostic${RESET} (paste into any AI assistant; it runs"
      echo -e "  discovery on your server before suggesting anything):"
      echo -e "      ${BOLD}docs/REVERSE-PROXY-DIAGNOSTIC-PROMPT.md${RESET} in the connector repo"
    elif [ -d /etc/nginx ]; then
      warn "Cause: nginx on this host has no entry for ${BOLD}${APP_HOST}${RESET}, so it is"
      warn "serving that hostname from its ${BOLD}default${RESET} server block instead."
      echo ""
      echo -e "  ${CYAN}Fix${RESET} — save as /etc/nginx/sites-available/${APP_HOST}"
      echo -e "  and symlink it into sites-enabled:"
      echo ""
      cat <<NGINX
    server {
        listen 80;
        server_name ${APP_HOST};

        location / {
            proxy_pass         http://127.0.0.1:${CONTAINER_PORT};
            proxy_http_version 1.1;
            proxy_set_header   Host              \$host;
            proxy_set_header   X-Real-IP         \$remote_addr;
            proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto \$scheme;
            proxy_set_header   Upgrade           \$http_upgrade;
            proxy_set_header   Connection        "upgrade";
        }
    }
NGINX
      echo ""
      echo -e "  ${CYAN}Then:${RESET}"
      echo -e "    ln -s /etc/nginx/sites-available/${APP_HOST} /etc/nginx/sites-enabled/"
      echo -e "    nginx -t && systemctl reload nginx"
      echo -e "    certbot --nginx -d ${APP_HOST}        ${YELLOW}# adds HTTPS${RESET}"
    else
      warn "Cause: nothing on this server is routing ${BOLD}${APP_HOST}${RESET} to port ${CONTAINER_PORT}."
      echo ""
      echo -e "  No reverse proxy was found on the host. You need something that"
      echo -e "  terminates HTTPS for ${APP_HOST} and forwards to ${BOLD}127.0.0.1:${CONTAINER_PORT}${RESET} —"
      echo -e "  Caddy (gets certificates automatically), nginx + certbot, or a"
      echo -e "  Cloudflare Tunnel pointed at http://localhost:${CONTAINER_PORT}."
      echo ""
      echo -e "  ${CYAN}Full step-by-step diagnostic${RESET} (paste into any AI assistant):"
      echo -e "      ${BOLD}docs/REVERSE-PROXY-DIAGNOSTIC-PROMPT.md${RESET} in the connector repo"
    fi

    echo ""
    echo -e "  ${CYAN}Verify once routing is in place:${RESET} curl ${APP_URL}/healthz"
    echo -e "    Expected: ${BOLD}{\"app\":\"payram-shopify-connector\",\"ok\":true}${RESET}"
    echo ""
    warn "Using a Cloudflare Tunnel already? Check it points at http://localhost:${CONTAINER_PORT}"
    warn "and is running. If the tunnel blocks this server from calling its own"
    warn "public hostname, the check above can fail even though buyers can reach"
    warn "it — confirm with the curl from your laptop before changing anything."
  fi
fi

# =============================================================================
# Done
# =============================================================================
echo ""
# Only claim success for what was actually verified. Handing out an install URL
# that returns 404 costs a merchant a support round-trip and a lost sale.
if [ "$URL_REACHABLE" = true ]; then
  echo -e "${BOLD}${GREEN}════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}${GREEN}  Payram Shopify Connector is running!${RESET}"
  echo -e "${BOLD}${GREEN}════════════════════════════════════════════${RESET}"
else
  echo -e "${BOLD}${YELLOW}════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}${YELLOW}  Installed — but not reachable yet${RESET}"
  echo -e "${BOLD}${YELLOW}════════════════════════════════════════════${RESET}"
  echo ""
  echo -e "  ${YELLOW}Point ${BOLD}${APP_HOST:-your domain}${RESET}${YELLOW} at this container first (see above).${RESET}"
  echo -e "  ${YELLOW}The steps below will return 404 until that is done.${RESET}"
fi
echo ""
echo -e "  ${CYAN}1.${RESET} Install the app on your Shopify store:"
echo -e "       ${BOLD}${SHOPIFY_APP_URL:-https://YOUR_DOMAIN}/auth?shop=${SHOPIFY_STORE_DOMAIN:-your-store.myshopify.com}${RESET}"
echo -e "       ${YELLOW}Live store rather than a development store? First open the Partner${RESET}"
echo -e "       ${YELLOW}Dashboard → Apps → payram-checkout-plugin → Distribution, choose${RESET}"
echo -e "       ${YELLOW}Custom distribution and enter ${SHOPIFY_STORE_DOMAIN:-your store domain}.${RESET}"
echo -e "       ${YELLOW}Shopify refuses to install an undistributed app on a live store.${RESET}"
echo ""
echo -e "  ${CYAN}2.${RESET} ${BOLD}In your Payram dashboard → project → Webhooks, add:${RESET}"
echo -e "       ${BOLD}${SHOPIFY_APP_URL:-https://YOUR_DOMAIN}/api/payram/webhook${RESET}"
echo -e "       ${YELLOW}Without this, payments are never reported back and orders${RESET}"
echo -e "       ${YELLOW}stay unpaid in Shopify.${RESET}"
echo ""
echo -e "  ${CYAN}3.${RESET} In Shopify Admin → Settings → Payments → Manual payment methods"
echo -e "       add: 'Pay with Crypto via Payram'"
echo ""
echo -e "  ${CYAN}4.${RESET} In Shopify Admin → Online Store → Checkout → Customize"
echo -e "       → Thank You page → Add block → Payram Thank You Block."
echo -e "       ${GREEN}No additional configuration needed — the block auto-connects${RESET}"
echo -e "       ${GREEN}via the App Proxy. Just add and save.${RESET}"
echo ""
echo -e "  ${CYAN}Optional:${RESET} update notices are OFF by default. Enable them in the"
echo -e "       Payram app to be told when a fix ships. It is a daily read-only"
echo -e "       check against GitHub — nothing about your store is sent."
echo ""
echo -e "  ${CYAN}Manage container:${RESET}"
echo -e "       docker logs payram-shopify-connector"
echo -e "       docker stop payram-shopify-connector"
echo -e "       docker start payram-shopify-connector"
echo -e "       Upgrade:  re-run the install command — everything in .env is kept."
echo -e "       Back up:  ${ENV_FILE} and the payram-shopify-data volume."
echo ""
