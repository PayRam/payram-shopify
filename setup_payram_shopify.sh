#!/usr/bin/env bash
# =============================================================================
# Payram Shopify Connector — Self-Hosted Installer
#
# Clones the repo, configures credentials via Shopify CLI (no copy-pasting),
# runs database migrations, builds the app, and starts the server.
#
# Usage (run without cloning first):
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/PayRam/payram-shopify/main/setup_payram_shopify.sh)"
#
# =============================================================================
set -euo pipefail

REPO_URL="https://github.com/PayRam/payram-shopify.git"
DEFAULT_INSTALL_DIR="$HOME/payram-shopify-connector"

# ── colours ──────────────────────────────────────────────────────────────────
BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RED="\033[31m"
RESET="\033[0m"

info()   { echo -e "${GREEN}[payram]${RESET} $*"; }
warn()   { echo -e "${YELLOW}[payram]${RESET} $*"; }
step()   { echo -e "\n${CYAN}${BOLD}▶ $*${RESET}"; }
die()    { echo -e "\n${RED}[payram] ERROR:${RESET} $*\n" >&2; exit 1; }

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
# STEP 1 — Prerequisites
# =============================================================================
step "Checking prerequisites"

check_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed. $2"
}

check_cmd git  "Install from https://git-scm.com"
check_cmd node "Install Node.js >= 18 from https://nodejs.org"
check_cmd npm  "npm is bundled with Node.js"

NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node))")
[ "$NODE_MAJOR" -lt 18 ] && die "Node.js >= 18 required (found $(node --version))"

info "node $(node --version)  npm $(npm --version)  git $(git --version | awk '{print $3}')"

if command -v docker >/dev/null 2>&1; then
  info "docker $(docker --version | awk '{print $3}' | tr -d ',')"
  HAS_DOCKER=true
else
  warn "Docker not found — the app will run directly with Node."
  HAS_DOCKER=false
fi

# =============================================================================
# STEP 2 — Clone / update the repository
# =============================================================================
step "Installing Payram Shopify Connector"

read -rp "$(echo -e "${BOLD}Install directory${RESET} [${DEFAULT_INSTALL_DIR}]: ")" INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

if [ -d "$INSTALL_DIR/.git" ]; then
  warn "Directory already exists — pulling latest changes ..."
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR")" ]; then
  die "Directory '$INSTALL_DIR' exists and is not empty. Choose a different path or remove it first."
else
  info "Cloning $REPO_URL → $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# =============================================================================
# STEP 3 — Install npm dependencies (includes @shopify/cli)
# =============================================================================
step "Installing dependencies"
npm install --prefer-offline

# =============================================================================
# Helpers for reading/writing .env
# =============================================================================
[ ! -f .env ] && cp .env.example .env

load_env() {
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    value="${value%\"}"
    value="${value#\"}"
    export "$key=$value" 2>/dev/null || true
  done < .env
}

set_env() {
  local var="$1" val="$2"
  if grep -q "^${var}=" .env 2>/dev/null; then
    sed -i "s|^${var}=.*|${var}=${val}|" .env
  else
    echo "${var}=${val}" >> .env
  fi
  export "${var}=${val}"
}

load_env

# =============================================================================
# STEP 4 — Shopify authentication + app linking
# =============================================================================
step "Connecting to Shopify"

if [ -z "${SHOPIFY_API_KEY:-}" ]; then
  info "Logging in to your Shopify Partner account ..."
  info "(A browser window will open — complete the login there.)"
  npx shopify auth login

  echo ""
  info "Linking this project to a Shopify app ..."
  info "(Select an existing app or create a new one when prompted.)"
  npx shopify app config link

  echo ""
  info "Pulling app credentials into .env ..."
  npx shopify app env pull --env-file .env
  load_env

  [ -z "${SHOPIFY_API_KEY:-}" ] && die "SHOPIFY_API_KEY was not set after 'shopify app env pull'. Check the output above."
  info "Shopify credentials written to .env"
else
  info "SHOPIFY_API_KEY already set — skipping Shopify auth."
fi

# =============================================================================
# STEP 5 — App URL
# =============================================================================
step "Server URL"

warn "This must be the public HTTPS URL where this server will be reachable."
warn "Add these as allowed redirect URLs in your Shopify app settings:"
warn "  <URL>/auth/callback"
warn "  <URL>/auth/shopify/callback"
warn "  <URL>/api/auth/callback"
echo ""

if [ -z "${SHOPIFY_APP_URL:-}" ]; then
  read -rp "$(echo -e "${BOLD}Public HTTPS App URL (no trailing slash):${RESET} ")" app_url_input
  [ -z "$app_url_input" ] && die "SHOPIFY_APP_URL cannot be empty."
  set_env SHOPIFY_APP_URL "$app_url_input"
else
  info "SHOPIFY_APP_URL already set (${SHOPIFY_APP_URL})"
fi

# Patch placeholder in shopify.app.toml if still present
if grep -q "{{ APPLICATION_URL }}" shopify.app.toml 2>/dev/null; then
  sed -i "s|{{ APPLICATION_URL }}|${SHOPIFY_APP_URL}|g" shopify.app.toml
fi

# =============================================================================
# STEP 6 — Database
# =============================================================================
step "Database"

warn "Default is SQLite — fine for low traffic. For production use Postgres:"
warn "  postgresql://user:password@host:5432/dbname"
echo ""

if [ -z "${DATABASE_URL:-}" ]; then
  read -rp "$(echo -e "${BOLD}DATABASE_URL${RESET} [Enter for SQLite default]: ")" db_input
  if [ -z "$db_input" ]; then
    db_input="file:prod.sqlite"
    info "Using SQLite: $db_input"
  fi
  set_env DATABASE_URL "$db_input"
else
  info "DATABASE_URL already set"
fi

# =============================================================================
# STEP 7 — Encryption key
# =============================================================================
step "Encryption key"

if [ -z "${ENCRYPTION_KEY:-}" ]; then
  enc_key=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  set_env ENCRYPTION_KEY "$enc_key"
  warn "Auto-generated ENCRYPTION_KEY written to .env."
  warn "Back this up — losing it makes stored merchant API keys unrecoverable."
else
  info "ENCRYPTION_KEY already set"
fi

# =============================================================================
# STEP 8 — Database migrations + build
# =============================================================================
step "Running database migrations"
npx prisma migrate deploy
npx prisma generate

step "Building the application"
NODE_ENV=production npm run build

# =============================================================================
# STEP 9 — Deploy Shopify extension
# =============================================================================
step "Deploying checkout UI extension"
info "Publishing the Thank You Block extension to Shopify's CDN ..."
npx shopify app deploy

# =============================================================================
# STEP 10 — Optional Docker build + start
# =============================================================================
if [ "$HAS_DOCKER" = true ]; then
  echo ""
  read -rp "$(echo -e "${BOLD}Build and run as a Docker container? [y/N]:${RESET} ")" use_docker
  if [[ "${use_docker,,}" == "y" ]]; then
    step "Building Docker image"
    docker build \
      --build-arg SHOPIFY_API_KEY="${SHOPIFY_API_KEY:-}" \
      --build-arg SHOPIFY_APP_URL="${SHOPIFY_APP_URL:-}" \
      -t payram-shopify-connector:latest \
      .

    step "Starting Docker container"
    docker run -d \
      --name payram-shopify-connector \
      --env-file "${INSTALL_DIR}/.env" \
      -p 3000:3000 \
      --restart unless-stopped \
      payram-shopify-connector:latest

    info "Container started. Check status with: docker logs payram-shopify-connector"
    STARTED_WITH_DOCKER=true
  fi
fi

if [ "${STARTED_WITH_DOCKER:-false}" != "true" ]; then
  step "Starting server"
  info "Starting on port ${PORT:-3000} ..."
  [ -f .env ] && { set -o allexport; source .env; set +o allexport; }
  npx prisma migrate deploy
  exec node_modules/.bin/remix-serve ./build/server/index.js
fi

# =============================================================================
# Final instructions (only reached if Docker was used)
# =============================================================================
echo ""
echo -e "${BOLD}${GREEN}════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Payram Shopify Connector is running!${RESET}"
echo -e "${BOLD}${GREEN}════════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${CYAN}1.${RESET} Install the app on your Shopify store:"
echo -e "       ${SHOPIFY_APP_URL}/auth?shop=your-store.myshopify.com"
echo ""
echo -e "  ${CYAN}2.${RESET} In Shopify Admin → Online Store → Checkout → Customize"
echo -e "       → Thank You page → Add block → Payram Thank You Block."
echo -e "       Set 'App backend base URL' to: ${SHOPIFY_APP_URL}"
echo ""
