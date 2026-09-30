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
#   runner  compiled app, production deps, `pi` installed and run by Bun
#
# Bun is the base because it is the only runtime here: Pinion and `pi` both run
# on it. `pi`'s published bin is Node-targeted (`#!/usr/bin/env node`), but the
# base image's `node` is a Bun shim, so the image needs no Node.js.
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

# The agent, installed by Bun. Pinned for reproducible builds; override with
# `--build-arg PI_VERSION=x.y.z` (Pinion is tested against pi 0.99.x).
ARG PI_VERSION=0.99.1
RUN bun add -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && rm -rf /root/.bun/install/cache

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
