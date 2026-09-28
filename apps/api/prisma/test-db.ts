import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

/**
 * The throwaway database the integration suite and e2e run against — created
 * if it does not exist, then migrated.
 *
 * ## Why the name is a variable
 *
 * Two checkouts of this repository (git worktrees, one per stage being built
 * at the same time) running their suites against one `root_website_test`
 * would truncate each other's rows mid-test, and the failure would land on
 * whichever spec happened to run next. `ROOT_TEST_DB` gives each checkout its
 * own database; unset, it is the `root_website_test` it has always been.
 *
 * The name must still end in `_test` — `src/test/db.ts` refuses anything else,
 * because the suite truncates every table it finds, and this refuses first so
 * a typo never creates a database the suite would then refuse to use.
 *
 * `ROOT_TEST_PG` is the server, without a database: the docker-compose one by
 * default.
 */

export const TEST_DB = process.env.ROOT_TEST_DB || 'root_website_test';
const SERVER = process.env.ROOT_TEST_PG || 'postgresql://root:root@localhost:5432';

if (!/^[a-z0-9_]+_test$/.test(TEST_DB)) {
  throw new Error(`Refusing: ROOT_TEST_DB must be lowercase [a-z0-9_] and end in _test (got "${TEST_DB}")`);
}

export const TEST_DATABASE_URL = `${SERVER}/${TEST_DB}?schema=public`;

const API_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Creates the database if missing, then applies any migration it lacks. */
export async function ensureTestDatabase() {
  // CREATE DATABASE cannot name the database it is connected to, so this goes
  // through the server's maintenance database. The name is interpolated, not
  // bound — identifiers cannot be parameters — which is why the pattern above
  // is a strict allowlist rather than a check for "_test" somewhere in it.
  const admin = new PrismaClient({ datasourceUrl: `${SERVER}/postgres` });
  try {
    const found = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${TEST_DB}`;
    if (found.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${TEST_DB}"`);
      console.log(`[test-db] created ${TEST_DB}`);
    }
  } finally {
    await admin.$disconnect();
  }

  const migrate = spawnSync('npx prisma migrate deploy', {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
    shell: true, // npx is npx.cmd on Windows, which only a shell resolves
  });
  if (migrate.status !== 0) throw new Error(`[test-db] prisma migrate deploy failed for ${TEST_DB}`);
}

// Run directly (`npm run test:db`, and e2e's webServer), not when imported.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ensureTestDatabase();
}
