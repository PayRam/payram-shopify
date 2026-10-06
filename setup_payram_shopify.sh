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

DOCKER_IMAGE="payramapp/payram-shopify:latest"
DEFAULT_INSTALL_DIR="$HOME/payram-shopify-connector"

# ── argument parsing ──────────────────────────────────────────────────────────
RESET_MODE=false
# When this script is piped into `bash -c`, the first post-script token becomes
# `$0` rather than part of `$@`. Include it when it looks like a flag so
# invocations such as `/bin/bash -c "$(curl ...)" --reset` work as expected.
INSTALLER_ARGS=("$@")
if [[ "${0:-}" == --* ]]; then
  INSTALLER_ARGS=("$0" "${INSTALLER_ARGS[@]}")
fi

for arg in "${INSTALLER_ARGS[@]}"; do
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
  '[pos]' \
  'embedded = false' \
  '' \
  '[app_proxy]' \
  'url = "/api/payram"' \
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

DEPLOY_SCRIPT="${INSTALL_DIR}/.payram-deploy.sh"
cat > "$DEPLOY_SCRIPT" <<'EOF'
#!/bin/sh
set -e
APP_URL="${SHOPIFY_APP_URL%/}"
if [ -z "$APP_URL" ]; then
  echo "[payram-deploy] SHOPIFY_APP_URL is required" >&2
  exit 1
fi

sed -i "s|__PAYRAM_REDIRECT_BASE_URL__|${APP_URL}|g" /app/extensions/thank-you-block/src/Checkout.tsx
cp /workspace/shopify.app.toml /app/shopify.app.toml
# Save our desired toml (with app_proxy) before the link step overwrites it.
# shopify app deploy internally runs 'app config link' on first run, which
# pulls the remote config (no proxy) and overwrites the toml.
cp /app/shopify.app.toml /app/shopify.app.desired.toml
# First deploy: handles interactive auth + link (may overwrite toml) + extension deploy
npx shopify app deploy --allow-updates
# Extract the client_id that was written to the toml during linking.
LINKED_CLIENT_ID=$(grep '^client_id' /app/shopify.app.toml | sed 's/.*= *//' | tr -d '"' | tr -d "'")
# Restore our desired toml with the proxy section, and inject the real client_id
# so the second deploy is fully non-interactive.
cp /app/shopify.app.desired.toml /app/shopify.app.toml
if [ -n "$LINKED_CLIENT_ID" ]; then
  sed -i "s/^client_id = .*/client_id = \"${LINKED_CLIENT_ID}\"/" /app/shopify.app.toml
fi
# Second deploy: non-interactive (auth cached, client_id set).
# Print the exact proxy config we are about to deploy so the installer output
# shows whether the correct app_proxy block is present before Shopify sees it.
echo '[payram-deploy] Second deploy app_proxy section:'
grep -A3 '^\[app_proxy\]' /app/shopify.app.toml || true
npx shopify app deploy --allow-updates
npx shopify app env pull
cp /app/.env /workspace/.shopify-creds.env
chmod 644 /workspace/.shopify-creds.env
cp /app/shopify.app.toml /workspace/shopify.app.toml
echo '[payram-deploy] SUCCESS'
EOF
chmod 700 "$DEPLOY_SCRIPT"

# Single Docker run: handles auth (fresh or expired), deploys app + extension,
# pulls credentials. Works identically on first run and re-runs.
DOCKER_DEPLOY_ARGS=(
  docker run --rm -it
  --user root
  -e "SHOPIFY_APP_URL=${SHOPIFY_APP_URL}"
  -v payram-shopify-cli-auth:/root/.config/shopify
  -v "${INSTALL_DIR}:/workspace"
  "$DOCKER_IMAGE"
  sh /workspace/.payram-deploy.sh
)

if [ -t 0 ]; then
  "${DOCKER_DEPLOY_ARGS[@]}" || die "App deploy failed. See output above."
else
  command -v script >/dev/null 2>&1 || die "This installer needs a TTY for Shopify login. Install 'script' (util-linux) or run it from an interactive terminal."
  printf -v DOCKER_DEPLOY_CMD '%q ' "${DOCKER_DEPLOY_ARGS[@]}"
  script -qec "$DOCKER_DEPLOY_CMD" /dev/null || die "App deploy failed. See output above."
fi

rm -f "$DEPLOY_SCRIPT"

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

# Normalize SCOPES so existing installs pick up the app proxy permission too.
set_env SCOPES "read_orders,write_orders,read_customers,write_customers,write_app_proxy,write_gift_cards"

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
  -p 2798:2798 \
  -v payram-shopify-data:/data \
  --restart unless-stopped \
  "$DOCKER_IMAGE"

info "Container started."

# =============================================================================
# STEP 7 — Verify the connector is reachable at the URL Shopify will call
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
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:2798/healthz" 2>/dev/null | grep -q "$HEALTH_MARKER"; then
    CONTAINER_HEALTHY=true
    break
  fi
  sleep 1
done

if [ "$CONTAINER_HEALTHY" != true ]; then
  warn "The connector is NOT answering on http://127.0.0.1:2798 after 30s."
  echo ""
  warn "Last 30 lines of container log:"
  docker logs --tail 30 payram-shopify-connector 2>&1 | sed 's/^/    /' || true
  echo ""
  warn "Fix the error above, then re-run this installer."
else
  info "Container is answering on port 2798."

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
    FRONT_DOOR=""
    if command -v docker >/dev/null 2>&1; then
      FRONT_DOOR=$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null \
        | grep -E '\|.*:443->' \
        | grep -v '^payram-shopify-connector|' \
        | head -1 | cut -d'|' -f1)
    fi

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
      echo -e "                              └──  127.0.0.1:2798           (this connector)"
      echo ""
      echo -e "  ${CYAN}Three ways to get there${RESET} — pick based on your tolerance for restarting"
      echo -e "  the gateway:"
      echo ""
      echo -e "    ${BOLD}1. Containerised proxy${RESET} (Caddy/nginx/Traefik on 80/443). Put both"
      echo -e "       containers on a shared Docker network with no published ports. Routing"
      echo -e "       lives in your config, so it survives PayRam upgrades. Requires"
      echo -e "       re-creating the ${FRONT_DOOR} container without -p 80/-p 443."
      echo -e "    ${BOLD}2. Host proxy${RESET} (Caddy is simplest — it gets certificates for both"
      echo -e "       hostnames automatically). Same requirement: free up 80/443 first."
      echo -e "    ${BOLD}3. Cloudflare Tunnel${RESET} for ${APP_HOST} only, pointed at"
      echo -e "       http://localhost:2798. Needs no host ports and leaves the ${FRONT_DOOR}"
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
            proxy_pass         http://127.0.0.1:2798;
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
      warn "Cause: nothing on this server is routing ${BOLD}${APP_HOST}${RESET} to port 2798."
      echo ""
      echo -e "  No reverse proxy was found on the host. You need something that"
      echo -e "  terminates HTTPS for ${APP_HOST} and forwards to ${BOLD}127.0.0.1:2798${RESET} —"
      echo -e "  Caddy (gets certificates automatically), nginx + certbot, or a"
      echo -e "  Cloudflare Tunnel pointed at http://localhost:2798."
      echo ""
      echo -e "  ${CYAN}Full step-by-step diagnostic${RESET} (paste into any AI assistant):"
      echo -e "      ${BOLD}docs/REVERSE-PROXY-DIAGNOSTIC-PROMPT.md${RESET} in the connector repo"
    fi

    echo ""
    echo -e "  ${CYAN}Verify once routing is in place:${RESET} curl ${APP_URL}/healthz"
    echo -e "    Expected: ${BOLD}{\"app\":\"payram-shopify-connector\",\"ok\":true}${RESET}"
    echo ""
    warn "Using a Cloudflare Tunnel already? Check it points at http://localhost:2798"
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
echo ""
