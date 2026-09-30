# syntax=docker/dockerfile:1

###############################################################################
# Pinion in one container: Next.js web GUI + the `pi` coding agent.
#
#   docker compose up --build      → http://127.0.0.1:3000
#
# Stages
#   base    Debian trixie + Bun — Pinion's runtime (`bun scripts/next.ts`,
#           `bun --bun next start`, `bun:sqlite`)
#   deps    `bun install` (cached on package.json + bun.lock)
#   build   `bun run build` (Next production build)
#   runner  compiled app, production deps, Node + globally installed `pi`
#
# Bun is the base because it is what Pinion runs on. Node is copied in from the
# official image solely for `pi` (a Node CLI, `engines.node >= 22.19`); both
# images are the same Debian release, so glibc matches.
###############################################################################

FROM oven/bun:1-debian AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git less libstdc++6 procps ripgrep tini \
  && rm -rf /var/lib/apt/lists/*

# --- dependencies -----------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# --- build ------------------------------------------------------------------
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The npm script forces NODE_ENV=production. `.next/cache` (Turbopack cache)
# and `.next/dev` are build-time artifacts, not runtime ones — dropping them
# shrinks the final image by ~500 MB.
RUN bun run build \
  && rm -rf .next/cache .next/dev

# --- runtime ----------------------------------------------------------------
FROM base AS runner
WORKDIR /app

# Node + npm for the `pi` CLI (`#!/usr/bin/env node`). Pinion itself never
# touches them — it runs on the Bun already present in the base image.
COPY --from=node:24-trixie-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-trixie-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# The agent. Pinned for reproducible builds; override with
# `--build-arg PI_VERSION=x.y.z` (Pinion is tested against pi 0.99.x).
ARG PI_VERSION=0.99.1
RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && npm cache clean --force

ENV NODE_ENV=production \
    PINION_HOST=0.0.0.0 \
    PINION_PORT=3000 \
    DATABASE_URL=file:/app/data/pinion.db \
    PI_BINARY=pi \
    PI_DEFAULT_CWD=/workspace

# Production dependencies only — the compiled `.next` output is what runs.
# tsconfig.json is kept because Next transpiles `next.config.ts` at startup.
COPY package.json bun.lock tsconfig.json next.config.ts ./
RUN bun install --frozen-lockfile --production \
  && rm -rf /root/.bun/install/cache

COPY --from=build /app/.next ./.next
# `scripts/next.ts` is the launcher (run by Bun) and imports only lib/net.ts.
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/lib/net.ts ./lib/net.ts

RUN mkdir -p /app/data /workspace
# `/app/data` = SQLite cache; `/root/.pi` = pi auth, settings and session files.
VOLUME ["/app/data", "/root/.pi"]
EXPOSE 3000

# 401 is also healthy: it means the optional PINION_TOKEN gate is on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["sh", "-c", "curl -s -o /dev/null -w '%{http_code}' \"http://127.0.0.1:${PINION_PORT:-3000}/\" | grep -qE '^(200|401)$'"]

ENTRYPOINT ["tini", "--"]
CMD ["bun", "scripts/next.ts", "start"]
