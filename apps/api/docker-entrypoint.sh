#!/bin/sh
# Applies pending migrations, then hands PID 1 to the server.
#
# Migrating on start rather than as a separate deploy step is the trade this
# makes: one fewer thing to remember, at the cost of a container that refuses
# to start when a migration fails. That refusal is the point — a server running
# against a schema it does not expect is worse than a server that is down.
#
# `migrate deploy` only applies committed migration files. It never generates,
# never resets, and never prompts, which is what separates it from
# `migrate dev`. Concurrent replicas are safe: Prisma takes a Postgres advisory
# lock, so the second one waits rather than racing.
set -e

cd /app/apps/api

# The binary directly rather than `npx`, which can decide to consult its cache
# or the network when resolution surprises it. Nothing in a running container
# should ever reach for a registry.
echo "› applying migrations"
/app/node_modules/.bin/prisma migrate deploy

# Deliberately not run here: `npm run seed` (creates demo accounts with a known
# password) and `npm run backfill` (only for databases predating the revisions
# migration). Both are one-off, both are run by hand:
#   docker compose -f docker-compose.prod.yml run --rm api npm run backfill
echo "› starting api"
exec node dist/src/index.js
