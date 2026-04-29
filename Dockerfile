# ---------------------------------------------------------------------------
# Payram Shopify Connector
#
# Multi-stage build:
#   builder  — installs all deps and compiles the Remix app
#   runner   — production image with only runtime deps
#
# Build:
#   docker build -t payram-shopify-connector .
#
# Run:
#   docker run -d \
#     --env-file .env \
#     -p 3000:3000 \
#     payram-shopify-connector
# ---------------------------------------------------------------------------

# ---- builder ---------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install OS deps needed by some npm packages (e.g. native crypto bindings)
RUN apk add --no-cache python3 make g++

# Copy manifests first for better layer caching
COPY package.json package-lock.json ./
COPY extensions/thank-you-block/package.json ./extensions/thank-you-block/

# Install all deps (including devDeps needed for build)
RUN npm ci

# Copy source
COPY . .

# Substitute shopify.app.toml placeholders at build time via build args.
# The actual values must be provided when building the image.
ARG SHOPIFY_API_KEY
ARG SHOPIFY_APP_URL
RUN if grep -q "{{ CLIENT_ID }}" shopify.app.toml 2>/dev/null; then \
      sed -i \
        -e "s|{{ CLIENT_ID }}|${SHOPIFY_API_KEY}|g" \
        -e "s|{{ APPLICATION_URL }}|${SHOPIFY_APP_URL}|g" \
        shopify.app.toml; \
    fi

# Generate Prisma client
RUN npx prisma generate

# Build the Remix app
RUN NODE_ENV=production npm run build

# Prune dev dependencies
RUN npm prune --omit=dev

# ---- runner ----------------------------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app

# Runtime-only OS packages
# openssl + libc6-compat are required by Prisma's query engine binary on Alpine
RUN apk add --no-cache tini openssl libc6-compat

# Fake xdg-open so the Shopify CLI device-code auth flow doesn't crash
# on headless servers. The CLI will try to open the browser; this script
# just prints the URL instead of dying with ENOENT, and the CLI continues
# waiting for the user to complete auth manually.
RUN printf '#!/bin/sh\necho ""\necho "  ➜  Open this URL in your browser to authenticate:"\necho "     $1"\necho ""\n' \
      > /usr/local/bin/xdg-open && chmod +x /usr/local/bin/xdg-open

# Non-root user for least-privilege execution
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy only what's needed to run
COPY --from=builder --chown=appuser:appgroup /app/build          ./build
COPY --from=builder --chown=appuser:appgroup /app/node_modules   ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/package.json   ./package.json
COPY --from=builder --chown=appuser:appgroup /app/prisma         ./prisma
COPY --from=builder --chown=appuser:appgroup /app/shopify.app.toml ./shopify.app.toml
COPY --from=builder --chown=appuser:appgroup /app/scripts/start.sh ./scripts/start.sh

RUN chmod +x ./scripts/start.sh

USER appuser

EXPOSE 3000

# tini reaps zombie processes and forwards signals correctly
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "./scripts/start.sh"]
