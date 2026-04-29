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

warn "This must be the public HTTPS URL where this server will be reachable."
warn "Examples: https://payram.yourstore.com  or  https://your-server.example.com"
echo ""

if [ -z "${SHOPIFY_APP_URL:-}" ]; then
  read -rp "$(echo -e "${BOLD}Public HTTPS App URL (no trailing slash):${RESET} ")" app_url_input
  [ -z "$app_url_input" ] && die "SHOPIFY_APP_URL cannot be empty."
  set_env SHOPIFY_APP_URL "$app_url_input"
else
  info "SHOPIFY_APP_URL already set (${SHOPIFY_APP_URL})"
fi

# =============================================================================
# STEP 4 — Pull Docker image (needed before auth step uses it)
# =============================================================================
step "Pulling Docker image"
info "Pulling ${DOCKER_IMAGE} ..."
docker pull "$DOCKER_IMAGE"

# =============================================================================
# STEP 5 — Shopify app credentials (via CLI)
# =============================================================================
step "Shopify app credentials"

if [ -z "${SHOPIFY_API_KEY:-}" ]; then
  # Persistent volume for CLI auth state — survives between docker run invocations
  docker volume create payram-shopify-cli-auth >/dev/null 2>&1 || true

  # Write a shopify.app.toml with empty client_id to the install dir.
  # shopify app deploy will create the app and write the real client_id back.
  printf '%s\n' \
    'name = "payram-connector"' \
    'client_id = ""' \
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
    > "${INSTALL_DIR}/shopify.app.toml"

  info "A browser login URL will appear below — open it to authenticate."
  info "You will then be asked to select your organization and confirm the app name."
  warn "Choose 'Create new app' when prompted for the app."
  echo ""

  # Single container: auth + deploy + env pull all share the same process/session.
  # env pull writes to /app/.env by default; we copy it to /workspace for extraction.
  docker run --rm -it \
    --user root \
    -v payram-shopify-cli-auth:/root/.config/shopify \
    -v "${INSTALL_DIR}:/workspace" \
    "$DOCKER_IMAGE" \
    sh -c "
      set -e
      cp /workspace/shopify.app.toml /app/shopify.app.toml
      npx shopify app deploy --allow-updates
      npx shopify app env pull
      cp /app/.env /workspace/.shopify-creds.env
      chmod 644 /workspace/.shopify-creds.env
      # Copy updated toml (with real client_id written by CLI) back to workspace
      cp /app/shopify.app.toml /workspace/shopify.app.toml
    " || die "App creation or deploy failed. See output above."

  CREDS_FILE="${INSTALL_DIR}/.shopify-creds.env"
  if [ ! -f "${CREDS_FILE}" ]; then
    die "Credentials file not found after deploy. Check the output above for errors."
  fi

  API_KEY=$(grep    '^SHOPIFY_API_KEY='    "${CREDS_FILE}" | cut -d'=' -f2- | tr -d '"\r')
  API_SECRET=$(grep '^SHOPIFY_API_SECRET=' "${CREDS_FILE}" | cut -d'=' -f2- | tr -d '"\r')
  rm -f "${CREDS_FILE}"

  [ -z "${API_KEY}" ]    && die "Could not read SHOPIFY_API_KEY from credentials file."
  [ -z "${API_SECRET}" ] && die "Could not read SHOPIFY_API_SECRET from credentials file."

  set_env SHOPIFY_API_KEY    "${API_KEY}"
  set_env SHOPIFY_API_SECRET "${API_SECRET}"

  info "App created and extension deployed."
  info "  API Key: ${API_KEY}"
else
  info "SHOPIFY_API_KEY already set — skipping."
fi

# Ensure SCOPES is set
if ! grep -q "^SCOPES=" "$ENV_FILE" 2>/dev/null; then
  set_env SCOPES "read_orders,write_orders,read_customers"
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
echo -e "       ${SHOPIFY_APP_URL:-https://YOUR_DOMAIN}/auth?shop=your-store.myshopify.com"
echo ""
echo -e "  ${CYAN}2.${RESET} In Shopify Admin → Settings → Payments → Manual payment methods"
echo -e "       add: 'Pay with Crypto via Payram'"
echo ""
echo -e "  ${CYAN}3.${RESET} In Shopify Admin → Online Store → Checkout → Customize"
echo -e "       → Thank You page → Add block → Payram Thank You Block."
echo -e "       Set 'App backend base URL' to: ${SHOPIFY_APP_URL:-https://YOUR_DOMAIN}"
echo ""
echo -e "  ${CYAN}Manage container:${RESET}"
echo -e "       docker logs payram-shopify-connector"
echo -e "       docker stop payram-shopify-connector"
echo -e "       docker start payram-shopify-connector"
echo ""
