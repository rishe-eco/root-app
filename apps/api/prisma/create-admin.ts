/**
 * Creates one real admin account, for a production database where the seed
 * must not be run.
 *
 *   npm run create-admin --workspace=apps/api -- you@example.com "Your Name"
 *
 * The password is read from stdin rather than argv, so it stays out of shell
 * history and out of `ps`. Interactively, type it and press ctrl-D:
 *
 *   docker compose -f docker-compose.prod.yml exec -T api \
 *     npx tsx prisma/create-admin.ts you@example.com "Your Name"
 *
 * This exists because seed.ts creates two accounts whose password is written
 * in the repository. That is right for development and unusable anywhere else.
 */
import { loadEnvFile } from 'node:process';
import { PrismaClient } from '@prisma/client';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth/password.js';

// Run directly, not by the Prisma CLI, so nothing else loads .env. Same
// reason as src/lib/env.ts and prisma/seed.ts.
try {
  loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const prisma = new PrismaClient();

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [emailArg, nameArg] = process.argv.slice(2);
  if (!emailArg || !nameArg) {
    console.error('usage: create-admin <email> <name>   (password on stdin)');
    process.exit(64);
  }

  const email = emailArg.trim().toLowerCase();
  // Only the trailing newline the shell adds — a password may legitimately
  // start or end with a space, and silently eating it would lock someone out
  // of an account they typed correctly.
  const password = (await readStdin()).replace(/\r?\n$/, '');

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length}).`,
    );
    process.exit(1);
  }

  // Refuse rather than overwrite. Silently resetting the password of an
  // existing account is not something a create command should ever do.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error(`${email} already exists (role ${existing.role}, state ${existing.state}).`);
    process.exit(1);
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: nameArg,
      role: 'ADMIN',
      state: 'ACTIVE',
      passwordHash: await hashPassword(password),
    },
  });

  console.info(`Created admin ${user.email}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
