# syntax=docker/dockerfile:1
#
# Build context is the repo root, not this directory — npm workspaces resolve
# through the root manifest and lockfile, so the API cannot be built from
# apps/api alone. See docker-compose.prod.yml.
#
# Debian rather than Alpine: Prisma's query engine is a native binary wanting
# glibc and OpenSSL 3. Build and runtime share one base image on purpose —
# changing either alone produces a container that fails on its first query, not
# at build time. The engine check after `prisma generate` below is what turns
# that into a build failure instead.

# --- build -----------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# openssl FIRST, before npm ci — and this ordering is the whole point.
#
# Prisma chooses which engines to fetch and which to generate by probing the
# system for libssl: `@prisma/engines`' postinstall does it during `npm ci`,
# and `prisma generate` does it again. bookworm-slim ships neither libssl nor
# the openssl binary (Node statically links its own), so on a bare base both
# probes fail — and Prisma's answer to failure is not an error but a **silent
# default to `debian-openssl-1.1.x`**, warned about on stdout and otherwise
# indistinguishable from success.
#
# The runtime stage does install openssl, so the running container correctly
# detects 3.0.x and then looks for an engine nothing ever built. The result is
# a PrismaClientInitializationError on the first query, in production, pointing
# at a mismatch whose cause is thirty lines above it in this file.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# Manifests before source, so editing a resolver does not re-run npm ci.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# --workspace keeps apps/web's React toolchain out of this image; the lockfile
# is still the whole workspace's, so every version stays pinned to what the
# repo resolved.
RUN npm ci --workspace=apps/api --include-workspace-root

COPY apps/api apps/api
RUN npm run prisma:generate --workspace=apps/api

# Check the header's claim rather than trusting it. Everything above can be
# right and this can still come out wrong — a base image bump, a Prisma
# upgrade, a probe that stops working — and every one of those failures is
# quiet at build time and loud in production. One `find` moves the whole class
# of them here, where a red build is all it costs.
RUN find /app -path '*/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node' -print -quit \
      | grep -q . || { \
        echo "ERROR: prisma generate produced no debian-openssl-3.0.x query engine." >&2; \
        echo "       Detection fell back — is openssl installed in this stage?" >&2; \
        find /app -name 'libquery_engine-*' -o -name 'schema-engine-*' >&2; \
        exit 1; }

RUN npm run build --workspace=apps/api

# --- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app/apps/api
ENV NODE_ENV=production

# openssl: the Prisma engine links against it and bookworm-slim omits it.
# tini: the entrypoint would otherwise be PID 1 and swallow SIGTERM, so the
# server's own shutdown handler (server.stop + prisma.$disconnect) never runs
# and every deploy would drop in-flight requests.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl tini \
 && rm -rf /var/lib/apt/lists/*

# The whole tree comes over rather than a fresh --omit=dev install: the
# entrypoint runs `prisma migrate deploy`, and the Prisma CLI is a
# devDependency. Scoped to apps/api this is tens of megabytes, not the web
# tree, and it keeps the running image byte-identical to what was tested.
COPY --from=builder --chown=node:node /app /app

COPY --chown=node:node apps/api/docker-entrypoint.sh /usr/local/bin/root-api-entrypoint
RUN chmod +x /usr/local/bin/root-api-entrypoint

USER node
EXPOSE 4000

# The server already exposes /health, which round-trips a query to Postgres —
# so an unhealthy container here means "cannot serve", not merely "process up".
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/root-api-entrypoint"]
