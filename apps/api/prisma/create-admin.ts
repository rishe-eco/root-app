/**
 * Creates one real admin account, for a production database where the seed
 * must not be run.
 *
 *   npm run create-admin --workspace=apps/api -- you@example.com "Your Name" [--phone +98912…]
 *
 * The password is read from stdin rather than argv, so it stays out of shell
 * history and out of `ps`. Interactively, type it and press ctrl-D.
 *
 * On the server, one line and the binary directly — `docker-entrypoint.sh`
 * gives the reason it does the same with `prisma`, and a `\` continuation that
 * loses its newline in a paste fails in a way that reads like a missing binary:
 *
 *   docker compose -f docker-compose.prod.yml exec -T api /app/node_modules/.bin/tsx prisma/create-admin.ts you@example.com "Your Name" --phone +98912xxxxxxx
 *
 * Both paths there are inside the container (WORKDIR /app/apps/api); the
 * server's own clone has no node_modules. See deploy/README.md.
 *
 * This exists because seed.ts creates two accounts whose password is written
 * in the repository. That is right for development and unusable anywhere else.
 *
 * `--phone` (journeys build plan J1, PD-20): ADMIN is a second-factor role,
 * so a brand-new admin with no phone would be created into an account it
 * cannot itself sign into once a provider is configured — set one here,
 * up front, rather than have the first real ADMIN discover this the hard
 * way and need `set-phone` (this directory) before ever signing in once.
 */
import { loadEnvFile } from 'node:process';
import { PrismaClient } from '@prisma/client';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth/password.js';
import { normalizePhone } from '../src/lib/phone.js';

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

/** Pulls `--phone <value>` out of the argument list, wherever it sits,
 *  leaving the positional `<email> <name>` behind — the same reasoning
 *  `prisma/set-phone.ts` gives for keeping this one flag, one file. */
function extractPhoneFlag(argv: string[]): { rest: string[]; phone: string | null } {
  const i = argv.indexOf('--phone');
  if (i === -1) return { rest: argv, phone: null };
  const phone = argv[i + 1];
  if (!phone) {
    console.error('--phone needs a value.');
    process.exit(64);
  }
  return { rest: [...argv.slice(0, i), ...argv.slice(i + 2)], phone };
}

async function main() {
  const { rest, phone: phoneArg } = extractPhoneFlag(process.argv.slice(2));
  const [emailArg, nameArg] = rest;
  if (!emailArg || !nameArg) {
    console.error('usage: create-admin <email> <name> [--phone +98912…]   (password on stdin)');
    process.exit(64);
  }

  let phone: string | null = null;
  if (phoneArg) {
    phone = normalizePhone(phoneArg);
    if (!phone) {
      console.error(`"${phoneArg}" does not look like a phone number.`);
      process.exit(1);
    }
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
    console.error(`${email} already exists (roles ${existing.roles.join(', ')}, state ${existing.state}).`);
    process.exit(1);
  }

  if (phone) {
    const phoneTaken = await prisma.user.findUnique({ where: { phone } });
    if (phoneTaken) {
      console.error(`${phone} is already in use by another account (${phoneTaken.email ?? phoneTaken.id}).`);
      process.exit(1);
    }
  }

  const user = await prisma.user.create({
    data: {
      email,
      phone,
      name: nameArg,
      roles: ['ADMIN'],
      state: 'ACTIVE',
      passwordHash: await hashPassword(password),
    },
  });

  console.info(`Created admin ${user.email}${user.phone ? ` (${user.phone})` : ''}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
