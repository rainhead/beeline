# syntax=docker/dockerfile:1

# Beeline's app image. One process, which owns the store (ADR 0005) — so this
# is a plain Node image with no supervisor and no second service.
#
# Debian, never Alpine: @duckdb/node-api ships prebuilt glibc bindings and has
# no musl build to fall back to, so an Alpine base fails at the first native
# call rather than at install time.
FROM node:26-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Node 26 no longer ships corepack. Install it rather than pinning pnpm here,
# so package.json's `packageManager` stays the one place the version is named.
RUN npm install -g corepack@latest && corepack enable
WORKDIR /app

# Full dependency tree, including vite — the islands are built below.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm app:build

# Runtime dependencies only. `tsx` is among them deliberately: the server runs
# from TypeScript source (pnpm app:start), so it is a dependency and not a
# dev tool. vite, vitest and typescript are left behind here.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM base AS runtime

# Every path below is read at runtime, and each for its own reason:
#   src/        the server itself, and src/app/static, which it serves
#   schema/     private-store DDL applied at boot, and db:migrate --check's
#               comparison against schema/*.sql
#   migrations/ applied by the entrypoint before the app starts
#   ingest/     the git-curated person overlay, read on every boot
#   dist/app    the built islands, located through Vite's manifest
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# tsconfig.json is not a build-time file here: the server runs from source, so
# tsx reads `jsx: react-jsx` / `jsxImportSource: hono/jsx` from it at runtime.
# Without it esbuild falls back to the classic transform and every SSR route
# dies with "React is not defined" while static files carry on serving.
COPY tsconfig.json ./
COPY src ./src
COPY schema ./schema
COPY migrations ./migrations
COPY ingest ./ingest
COPY --from=build /app/dist ./dist
COPY infra/fly/entrypoint.sh /usr/local/bin/beeline-entrypoint
RUN chmod +x /usr/local/bin/beeline-entrypoint

# The Fly volume mounts here. Named explicitly so that a container run without
# one still has the directory the app's relative paths (data/secrets/,
# data/dem/, the change logs) resolve against.
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3054
EXPOSE 3054

ENTRYPOINT ["/usr/local/bin/beeline-entrypoint"]
