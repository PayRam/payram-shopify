#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Payram Shopify Connector — start production server
#
# Applies any pending DB migrations then starts the Remix server.
# Called by the Dockerfile CMD and can be run directly by merchants.
#
# Usage:
#   bash scripts/start.sh
# ---------------------------------------------------------------------------
set -euo pipefail

info() { echo "[start] $*"; }
die()  { echo "[start] ERROR: $*" >&2; exit 1; }

# Load .env if present (Docker passes vars via --env-file or -e flags,
# but this helps when running directly on the host)
if [ -f .env ]; then
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
fi

# Validate critical env vars
: "${SHOPIFY_API_KEY:?SHOPIFY_API_KEY is required}"
: "${SHOPIFY_API_SECRET:?SHOPIFY_API_SECRET is required}"
: "${SHOPIFY_APP_URL:?SHOPIFY_APP_URL is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${ENCRYPTION_KEY:?ENCRYPTION_KEY is required}"

info "Running database migrations …"
npx prisma migrate deploy

info "Starting server on port ${PORT:-3000} …"
exec node_modules/.bin/remix-serve ./build/server/index.js
