#!/usr/bin/env bash
# =============================================================================
# Payram Shopify Connector — Self-Hosted Installer  (v2)
#
# Only requires Docker. No Node.js needed on the host.
#
# Usage:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/PayRam/payram-shopify/main/setup_payram_shopify.sh)"
#
# =============================================================================
set -euo pipefail

DOCKER_IMAGE="mason0816/payram-shopify-test:latest"
DEFAULT_INSTALL_DIR="$HOME/payram-shopify-connector"

# ── argument parsing ──────────────────────────────────────────────────────────
RESET_MODE=false
for arg in "$@"; do
  case "$arg" in
    --reset) RESET_MODE=true ;;
  esac
done

# ── colours ──────────────────────────────────────────────────────────────────
BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RED="\033[31m"
RESET="\033[0m"

info()  { echo -e "${GREEN}[payram]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[payram]${RESET} $*"; }
step()  { echo -e "\n${CYAN}${BOLD}▶ $*${RESET}"; }
die()   { echo -e "\n${RED}[payram] ERROR:${RESET} $*\n" >&2; exit 1; }

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

  read -rp "$(echo -e "${BOLD}Install directory to reset${RESET} [${DEFAULT_INSTALL_DIR}]: ")" RESET_DIR
  RESET_DIR="${RESET_DIR:-$DEFAULT_INSTALL_DIR}"
  RESET_DIR="${RESET_DIR/#\~/$HOME}"

  echo ""
  warn "This will:"
  warn "  • Stop and remove container: payram-shopify-connector"
  warn "  • Delete Docker volumes:     payram-shopify-data, payram-shopify-cli-auth"
  warn "  • Delete .env and shopify.app.toml in: ${RESET_DIR}"
  echo ""
  read -rp "$(echo -e "${RED}${BOLD}Type 'yes' to confirm reset:${RESET} ")" confirm
  [ "$confirm" != "yes" ] && { info "Reset cancelled."; exit 0; }

  echo ""
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^payram-shopify-connector$'; then
    docker stop payram-shopify-connector >/dev/null 2>&1 || true
    docker rm   payram-shopify-connector >/dev/null 2>&1 || true
    info "Container removed."
  else
    info "No container found — skipping."
  fi

  docker volume rm payram-shopify-data      >/dev/null 2>&1 && info "Volume payram-shopify-data removed."      || info "Volume payram-shopify-data not found — skipping."
  docker volume rm payram-shopify-cli-auth  >/dev/null 2>&1 && info "Volume payram-shopify-cli-auth removed."  || info "Volume payram-shopify-cli-auth not found — skipping."

  rm -f "${RESET_DIR}/.env" && info "Removed ${RESET_DIR}/.env" || true
  rm -f "${RESET_DIR}/shopify.app.toml" && info "Removed ${RESET_DIR}/shopify.app.toml" || true

  echo ""
  info "Reset complete. Re-run the installer to start fresh."
  exit 0
fi

# =============================================================================
# STEP 1 — Prerequisites (Docker only)
# =============================================================================
# =============================================================================
step "Checking prerequisites"

command -v docker >/dev/null 2>&1 || die "Docker is required but not installed.
  Install from: https://docs.docker.com/get-docker/"

docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker and try again."

info "docker $(docker --version | awk '{print $3}' | tr -d ',')"

# =============================================================================
# STEP 2 — Install directory
# =============================================================================
step "Install location"

read -rp "$(echo -e "${BOLD}Install directory${RESET} [${DEFAULT_INSTALL_DIR}]: ")" INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# =============================================================================
# Helpers for .env
# =============================================================================
ENV_FILE="${INSTALL_DIR}/.env"

[ ! -f "$ENV_FILE" ] && touch "$ENV_FILE"

load_env() {
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    value="${value%\"}"
    value="${value#\"}"
    export "$key=$value" 2>/dev/null || true
  done < "$ENV_FILE"
}

set_env() {
  local var="$1" val="$2"
  if grep -q "^${var}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${var}=.*|${var}=${val}|" "$ENV_FILE"
  else
    echo "${var}=${val}" >> "$ENV_FILE"
  fi
  export "${var}=${val}"
}

load_env

# =============================================================================
# STEP 3 — App URL (needed before app creation)
# =============================================================================
step "Server URL"

warn "This must be the public HTTPS URL where this Shopify connector is reachable."
warn "If using Cloudflare Tunnel, the URL changes on every restart — update it here."
warn "Examples: https://your-tunnel.trycloudflare.com  or  https://payram.yourstore.com"
echo ""

_read_app_url() {
  while true; do
    read -rp "$(echo -e "${BOLD}Public HTTPS App URL (no trailing slash):${RESET} ")" app_url_input
    app_url_input="${app_url_input%/}"
    if [ -z "$app_url_input" ]; then
      warn "URL cannot be empty. Enter the full https:// address."
    elif [[ "$app_url_input" != https://* ]]; then
      warn "URL must start with https:// — got: ${app_url_input}"
    else
      break
    fi
  done
  echo "$app_url_input"
}

if [ -z "${SHOPIFY_APP_URL:-}" ]; then
  SHOPIFY_APP_URL=$(_read_app_url)
  set_env SHOPIFY_APP_URL "$SHOPIFY_APP_URL"
else
  echo -e "  Current App URL: ${CYAN}${SHOPIFY_APP_URL}${RESET}"
  read -rp "$(echo -e "${BOLD}Press Enter to keep it, or type a new URL:${RESET} ")" app_url_update
  app_url_update="${app_url_update%/}"
  if [ -n "$app_url_update" ]; then
    if [[ "$app_url_update" != https://* ]]; then
      warn "URL must start with https:// — got: ${app_url_update}"
      app_url_update=$(_read_app_url)
    fi
    set_env SHOPIFY_APP_URL "$app_url_update"
    SHOPIFY_APP_URL="$app_url_update"
    info "App URL updated to: ${SHOPIFY_APP_URL}"
  else
    info "Keeping existing App URL: ${SHOPIFY_APP_URL}"
  fi
fi

step "Pulling Docker image"
info "Pulling ${DOCKER_IMAGE} ..."
docker pull "$DOCKER_IMAGE"

# =============================================================================
# STEP 5 — Shopify app credentials (via CLI)
# =============================================================================
step "Shopify app credentials & extension deploy"

# Persistent volume for CLI auth state — survives between docker run invocations
docker volume create payram-shopify-cli-auth >/dev/null 2>&1 || true

# Write shopify.app.toml.
# client_id is empty on first run (CLI will link to new/existing app interactively).
# client_id is set on re-runs so the CLI deploys to the known app without prompting.
printf '%s\n' \
  'name = "payram-checkout-plugin"' \
  "client_id = \"${SHOPIFY_API_KEY:-}\"" \
  "application_url = \"${SHOPIFY_APP_URL}\"" \
  'embedded = true' \
  '' \
  '[access_scopes]' \
  'scopes = "read_orders,write_orders,read_customers"' \
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
  '[pos]' \
  'embedded = false' \
  '' \
  '[app_proxy]' \
  "url = \"${SHOPIFY_APP_URL}\"" \
  'prefix = "apps"' \
  'subpath = "payram-checkout-plugin"' \
  > "${INSTALL_DIR}/shopify.app.toml"

if [ -z "${SHOPIFY_API_KEY:-}" ]; then
  info "A browser login URL will appear below — open it to authenticate."
  warn "Choose 'Create new app' when prompted for the app."
  echo ""
else
  info "Re-using existing credentials — redeploying extension to update."
  info "If auth has expired, a new browser login URL will appear."
  echo ""
fi

# Single Docker run: handles auth (fresh or expired), deploys app + extension,
# pulls credentials. Works identically on first run and re-runs.
docker run --rm -it \
  --user root \
  -v payram-shopify-cli-auth:/root/.config/shopify \
  -v "${INSTALL_DIR}:/workspace" \
  "$DOCKER_IMAGE" \
  sh -c "
    set -e
    cp /workspace/shopify.app.toml /app/shopify.app.toml
    npx shopify app config push --force
    npx shopify app deploy --allow-updates
    npx shopify app env pull
    cp /app/.env /workspace/.shopify-creds.env
    chmod 644 /workspace/.shopify-creds.env
    cp /app/shopify.app.toml /workspace/shopify.app.toml
    echo '[payram-deploy] SUCCESS'
  " || die "App deploy failed. See output above."

CREDS_FILE="${INSTALL_DIR}/.shopify-creds.env"
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

# Ensure SCOPES is set
if ! grep -q "^SCOPES=" "$ENV_FILE" 2>/dev/null; then
  set_env SCOPES "read_orders,write_orders,read_customers"
fi

# =============================================================================
# STEP 5b — Shopify store domain
# =============================================================================
step "Shopify store"

_normalize_store_domain() {
  local d="$1"
  d="${d// /}"
  d="${d#https://}"
  d="${d#http://}"
  d="${d%/}"
  if [[ "$d" != *.* ]]; then
    d="${d}.myshopify.com"
  fi
  echo "$d"
}

if [ -z "${SHOPIFY_STORE_DOMAIN:-}" ]; then
  # Try to list available stores via the authenticated CLI session
  info "Fetching your Shopify stores ..."
  STORES_RAW=$(docker run --rm \
    --user root \
    -v payram-shopify-cli-auth:/root/.config/shopify \
    "$DOCKER_IMAGE" \
    sh -c 'timeout 20 npx shopify store list 2>/dev/null || true' 2>/dev/null || true)

  # Extract .myshopify.com domains from CLI table output
  mapfile -t STORES_ARRAY < <(echo "$STORES_RAW" | grep -oE '[a-zA-Z0-9-]+\.myshopify\.com' | sort -u)

  store_domain_input=""

  if [ "${#STORES_ARRAY[@]}" -gt 0 ]; then
    echo ""
    echo -e "  ${BOLD}Your Shopify stores:${RESET}"
    for i in "${!STORES_ARRAY[@]}"; do
      echo -e "    ${CYAN}$((i+1))${RESET}) ${STORES_ARRAY[$i]}"
    done
    echo ""
    read -rp "$(echo -e "${BOLD}Select store number (or type domain manually):${RESET} ")" store_choice
    if [[ "$store_choice" =~ ^[0-9]+$ ]] && \
       [ "$store_choice" -ge 1 ] && \
       [ "$store_choice" -le "${#STORES_ARRAY[@]}" ]; then
      store_domain_input="${STORES_ARRAY[$((store_choice-1))]}"
    else
      store_domain_input="$store_choice"
    fi
  else
    warn "Could not fetch store list — enter domain manually."
    read -rp "$(echo -e "${BOLD}Shopify store domain${RESET} (e.g. your-store.myshopify.com): ")" store_domain_input
  fi

  store_domain_input=$(_normalize_store_domain "$store_domain_input")
  [ -z "$store_domain_input" ] && die "Store domain cannot be empty."
  set_env SHOPIFY_STORE_DOMAIN "$store_domain_input"
  info "Store domain: ${store_domain_input}"
else
  info "SHOPIFY_STORE_DOMAIN already set (${SHOPIFY_STORE_DOMAIN})"
fi

# =============================================================================
# STEP 5 — Database
# =============================================================================
step "Database"

warn "Default is SQLite — fine for small stores. For production use Postgres:"
warn "  postgresql://user:password@host:5432/dbname"
echo ""

if [ -z "${DATABASE_URL:-}" ]; then
  read -rp "$(echo -e "${BOLD}DATABASE_URL${RESET} [Enter for SQLite default]: ")" db_input
  if [ -z "$db_input" ]; then
    db_input="file:/data/prod.sqlite"
    info "Using SQLite at /data/prod.sqlite (mounted into the container)"
  fi
  set_env DATABASE_URL "$db_input"
else
  info "DATABASE_URL already set"
fi

# =============================================================================
# STEP 6 — Encryption key
# =============================================================================
step "Encryption key"

if [ -z "${ENCRYPTION_KEY:-}" ]; then
  # openssl is available on all Linux/macOS systems — no Node required
  enc_key=$(openssl rand -hex 32)
  set_env ENCRYPTION_KEY "$enc_key"
  warn "Auto-generated ENCRYPTION_KEY written to .env"
  warn "Back this up — losing it makes stored merchant API keys unrecoverable."
else
  info "ENCRYPTION_KEY already set"
fi

# =============================================================================
# STEP 7 — Start the container
# =============================================================================
step "Starting the connector"

# Stop + remove any existing container with the same name
if docker ps -a --format '{{.Names}}' | grep -q '^payram-shopify-connector$'; then
  warn "Existing container found — stopping and replacing it ..."
  docker stop payram-shopify-connector >/dev/null
  docker rm payram-shopify-connector >/dev/null
fi

# Create a named volume for SQLite persistence (ignored if using Postgres)
docker volume create payram-shopify-data >/dev/null 2>&1 || true

docker run -d \
  --name payram-shopify-connector \
  --env-file "${ENV_FILE}" \
  -p 3000:3000 \
  -v payram-shopify-data:/data \
  --restart unless-stopped \
  "$DOCKER_IMAGE"

info "Container started."

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${BOLD}${GREEN}════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Payram Shopify Connector is running!${RESET}"
echo -e "${BOLD}${GREEN}════════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${CYAN}1.${RESET} Install the app on your Shopify store:"
echo -e "       ${BOLD}${SHOPIFY_APP_URL:-https://YOUR_DOMAIN}/auth?shop=${SHOPIFY_STORE_DOMAIN:-your-store.myshopify.com}${RESET}"
echo ""
echo -e "  ${CYAN}2.${RESET} In Shopify Admin → Settings → Payments → Manual payment methods"
echo -e "       add: 'Pay with Crypto via Payram'"
echo ""
echo -e "  ${CYAN}3.${RESET} In Shopify Admin → Online Store → Checkout → Customize"
echo -e "       → Thank You page → Add block → Payram Thank You Block."
echo -e "       ${GREEN}No additional configuration needed — the block auto-connects${RESET}"
echo -e "       ${GREEN}via the App Proxy. Just add and save.${RESET}"
echo ""
echo -e "  ${CYAN}Manage container:${RESET}"
echo -e "       docker logs payram-shopify-connector"
echo -e "       docker stop payram-shopify-connector"
echo -e "       docker start payram-shopify-connector"
echo ""
