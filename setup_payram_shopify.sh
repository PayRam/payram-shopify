#!/usr/bin/env bash
# =============================================================================
# Payram Shopify Connector — Self-Hosted Installer
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
# STEP 1 — Prerequisites (Docker only)
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
# STEP 4 — Shopify app credentials
# =============================================================================
step "Shopify app credentials"

if [ -z "${SHOPIFY_API_KEY:-}" ]; then
  echo ""
  info "How would you like to configure your Shopify app?"
  echo ""
  echo -e "  ${BOLD}1)${RESET} Auto-create via Shopify Partners API  ${GREEN}(recommended)${RESET}"
  echo    "     Creates the app automatically — no manual copy-paste of credentials."
  echo    "     Needs: your Partners org ID + a Partners API access token."
  echo ""
  echo -e "  ${BOLD}2)${RESET} Enter credentials manually"
  echo    "     Use this if you already have a Shopify app with an API key and secret."
  echo ""
  read -rp "$(echo -e "${BOLD}Choose [1]:${RESET} ")" cred_mode
  cred_mode="${cred_mode:-1}"

  if [[ "${cred_mode}" == "1" ]]; then
    # ── Auto-create via Partners API ────────────────────────────────────────
    command -v python3 >/dev/null 2>&1 || \
      die "python3 is required for auto-create mode but was not found.\n  Install python3 or choose mode 2 to enter credentials manually."

    echo ""
    info "Step A — Find your Partners org ID:"
    info "  Open https://partners.shopify.com in your browser."
    info "  The number in the URL bar is your org ID."
    info "  Example: https://partners.shopify.com/1234567/apps  →  org ID is 1234567"
    echo ""
    read -rp "$(echo -e "${BOLD}Partners organization ID (numbers only):${RESET} ")" PARTNERS_ORG_ID
    [[ "$PARTNERS_ORG_ID" =~ ^[0-9]+$ ]] || die "Organization ID must be numeric (e.g. 1234567)."

    echo ""
    info "Step B — Create a Partners API access token:"
    info "  In Partners dashboard → Settings → Partner API clients"
    info "  Click 'Manage Partner API clients' → Create access token."
    info "  Grant the \"Manage apps\" permission, then copy the token."
    echo ""
    read -rsp "$(echo -e "${BOLD}Partners API access token (input hidden):${RESET} ")" PARTNERS_TOKEN
    echo ""
    [[ -z "$PARTNERS_TOKEN" ]] && die "Partners API token cannot be empty."

    PARTNERS_ENDPOINT="https://partners.shopify.com/${PARTNERS_ORG_ID}/api/2026-01/graphql.json"

    # Verify token + org ID by listing apps
    info "Verifying credentials with Shopify Partners API..."
    verify_body='{"query":"{ apps(first:1) { nodes { id } } }"}'
    verify_response=$(curl -sf -X POST "${PARTNERS_ENDPOINT}" \
      -H "Content-Type: application/json" \
      -H "X-Shopify-Access-Token: ${PARTNERS_TOKEN}" \
      -d "${verify_body}") || \
      die "Cannot reach Shopify Partners API.\n  Check your org ID (${PARTNERS_ORG_ID}) and token, then try again."

    python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
if 'errors' in d:
    msg = d['errors'][0].get('message','unknown error')
    print('[payram] ERROR: Partners API: ' + msg, file=sys.stderr)
    sys.exit(1)
" <<< "${verify_response}" || exit 1
    info "Credentials verified."

    # Create the app via Partners GraphQL API
    info "Creating Shopify app 'Payram Shopify Connector'..."
    APP_URL="${SHOPIFY_APP_URL}" \
    PAYRAM_TOKEN="${PARTNERS_TOKEN}" \
    PAYRAM_ENDPOINT="${PARTNERS_ENDPOINT}" \
    python3 - <<'PYEOF' > /tmp/payram_app_create.json
import json, os, urllib.request

endpoint = os.environ['PAYRAM_ENDPOINT']
token    = os.environ['PAYRAM_TOKEN']
app_url  = os.environ['APP_URL']

mutation = """
mutation {
  appCreate(input: {
    title: "Payram Shopify Connector",
    applicationUrl: %s,
    redirectUrlWhitelist: %s
  }) {
    app {
      apiKey
      apiSecretKeys { secret }
    }
    userErrors { field message }
  }
}
""" % (
    json.dumps(app_url),
    json.dumps([
        app_url + "/auth/callback",
        app_url + "/auth/shopify/callback",
        app_url + "/api/auth/callback",
    ])
)

payload = json.dumps({"query": mutation}).encode()
req = urllib.request.Request(
    endpoint,
    data=payload,
    headers={"Content-Type": "application/json", "X-Shopify-Access-Token": token}
)
with urllib.request.urlopen(req) as resp:
    print(resp.read().decode())
PYEOF

    # Extract apiKey and secret from the response
    EXTRACTED=$(python3 - <<'PYEOF' 2>/tmp/payram_app_error
import json, sys
with open('/tmp/payram_app_create.json') as f:
    d = json.load(f)
result = d.get('data', {}).get('appCreate', {})
errors = result.get('userErrors', [])
if errors:
    print('ERROR: ' + '; '.join(e.get('message','?') for e in errors), file=sys.stderr)
    sys.exit(1)
app = result.get('app')
if not app:
    # Might be a schema error
    top_errors = d.get('errors', [])
    if top_errors:
        print('ERROR: ' + top_errors[0].get('message','?'), file=sys.stderr)
    sys.exit(1)
keys = app.get('apiSecretKeys', [])
print(app['apiKey'])
print(keys[0]['secret'] if keys else '')
PYEOF
    ) || {
      err=$(cat /tmp/payram_app_error 2>/dev/null | sed 's/^ERROR: //')
      die "Failed to create app: ${err:-see /tmp/payram_app_create.json for details}"
    }

    API_KEY=$(echo "${EXTRACTED}"    | head -1)
    API_SECRET=$(echo "${EXTRACTED}" | tail -1)
    [[ -z "$API_KEY" || -z "$API_SECRET" ]] && \
      die "Could not extract API key or secret. See /tmp/payram_app_create.json"

    set_env SHOPIFY_API_KEY             "${API_KEY}"
    set_env SHOPIFY_API_SECRET          "${API_SECRET}"
    set_env SHOPIFY_CLI_PARTNERS_TOKEN  "${PARTNERS_TOKEN}"

    info "App created successfully!"
    info "  API Key : ${API_KEY}"
    info "Partners token saved → the deploy step will authenticate automatically."

    # Write a deploy-ready shopify.app.toml to the install dir
    cat > "${INSTALL_DIR}/shopify.app.toml" <<TOML
name = "payram-shopify-connector"
client_id = "${API_KEY}"
application_url = "${SHOPIFY_APP_URL}"
embedded = true

[access_scopes]
scopes = "read_orders,write_orders,read_customers"

[auth]
redirect_urls = [
  "${SHOPIFY_APP_URL}/auth/callback",
  "${SHOPIFY_APP_URL}/auth/shopify/callback",
  "${SHOPIFY_APP_URL}/api/auth/callback",
]

[webhooks]
api_version = "2026-01"

  [[webhooks.subscriptions]]
  topics = ["app/uninstalled"]
  uri = "/webhooks"

[pos]
embedded = false
TOML
    info "shopify.app.toml written to ${INSTALL_DIR} — will be mounted for the deploy step."

  else
    # ── Manual entry ────────────────────────────────────────────────────────
    warn "Create a Shopify app at https://partners.shopify.com → Apps → Create app."
    warn "Then copy the Client ID and Client Secret from the API credentials tab."
    echo ""
    read -rp "$(echo -e "${BOLD}Shopify API Key (Client ID):${RESET} ")" input
    [ -z "$input" ] && die "SHOPIFY_API_KEY cannot be empty."
    set_env SHOPIFY_API_KEY "$input"

    read -rsp "$(echo -e "${BOLD}Shopify API Secret (Client Secret, hidden):${RESET} ")" input
    echo ""
    [ -z "$input" ] && die "SHOPIFY_API_SECRET cannot be empty."
    set_env SHOPIFY_API_SECRET "$input"
  fi
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
# STEP 7 — Pull Docker image
# =============================================================================
step "Pulling Docker image"
info "Pulling ${DOCKER_IMAGE} ..."
docker pull "$DOCKER_IMAGE"

# =============================================================================
# STEP 8 — Start the container
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
# STEP 9 — Deploy Shopify checkout extension (one-time)
# =============================================================================
step "Deploying checkout UI extension"

warn "The Thank You Block extension must be deployed to Shopify's CDN once."
if [ -n "${SHOPIFY_CLI_PARTNERS_TOKEN:-}" ]; then
  info "Partners token found in .env — deploy will authenticate automatically (no browser needed)."
else
  warn "No Partners token found — this step will open a browser to authenticate."
fi
echo ""
read -rp "$(echo -e "${BOLD}Deploy the extension now? [Y/n]:${RESET} ")" deploy_ext
deploy_ext="${deploy_ext:-y}"

# Mount the generated shopify.app.toml if it exists in the install dir
TOML_MOUNT=""
if [ -f "${INSTALL_DIR}/shopify.app.toml" ]; then
  TOML_MOUNT="-v ${INSTALL_DIR}/shopify.app.toml:/app/shopify.app.toml:ro"
fi

if [[ "${deploy_ext,,}" == "y" ]]; then
  # shellcheck disable=SC2086
  docker run --rm -it \
    --env-file "${ENV_FILE}" \
    ${TOML_MOUNT} \
    "$DOCKER_IMAGE" \
    npx shopify app deploy
  info "Extension deployed."
else
  warn "Skipped. Run this later to deploy the extension:"
  if [ -f "${INSTALL_DIR}/shopify.app.toml" ]; then
    warn "  docker run --rm -it --env-file ${ENV_FILE} \\"
    warn "    -v ${INSTALL_DIR}/shopify.app.toml:/app/shopify.app.toml:ro \\"
    warn "    ${DOCKER_IMAGE} npx shopify app deploy"
  else
    warn "  docker run --rm -it --env-file ${ENV_FILE} ${DOCKER_IMAGE} npx shopify app deploy"
  fi
fi

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
