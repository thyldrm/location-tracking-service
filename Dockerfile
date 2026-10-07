# syntax=docker/dockerfile:1.7

# One image, two process roles:
#   API:    node dist/main.js   (default command)
#   Worker: node dist/worker.js

ARG NODE_VERSION=24.21.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app

# ---- Install all dependencies (needed for the TypeScript build) ----
FROM base AS deps
COPY package.json package-lock.json ./
# Lifecycle scripts are disabled on purpose (supply-chain hardening); packages that need a native
# build step are rebuilt explicitly.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# ---- Compile TypeScript ----
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- Production-only dependencies ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# ---- Runtime image ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Never run as root.
USER node

EXPOSE 3000
CMD ["node", "dist/main.js"]
