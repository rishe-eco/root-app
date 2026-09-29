/**
 * Sets or replaces a phone on an existing account — the recovery path PD-20
 * names for a staff account the second factor has locked out because it has
 * no phone at all, or a wrong one. Run in the container exactly like
 * `create-admin.ts`, which this file mirrors in shape:
 *
 *   npm run set-phone --workspace=apps/api -- admin@root.local +98912xxxxxxx
 *   docker compose -f docker-compose.prod.yml exec -T api /app/node_modules/.bin/tsx prisma/set-phone.ts admin@root.local +98912xxxxxxx
 *
 * **Why this has to be a CLI, not a mutation.** The whole reason PD-20 names
 * it as the recovery path is that it must work when the staff second factor
 * is what is blocking someone — a GraphQL mutation gated by a session is
 * exactly the credential this exists to route around. Direct database
 * access is the one channel that does not depend on the factor already
 * working, the same reasoning `create-admin.ts` gives for existing outside
 * the API surface at all.
 *
 * `<email|phone>` identifies the account to change — an `@` decides which,
 * the same convention `signIn`'s `identifier` argument uses. `<new phone>`
 * replaces whatever phone the account had (or had none): normalized through
 * `lib/phone.ts`, and refused if another account already holds it (the
 * `User_phone_key` unique index would refuse the write anyway; this checks
 * first so the operator gets a plain sentence instead of a Postgres
 * constraint-violation stack).
 */
import { loadEnvFile } from 'node:process';
import { PrismaClient } from '@prisma/client';
import { normalizePhone } from '../src/lib/phone.js';

try {
  loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const prisma = new PrismaClient();

async function main() {
  const [identifierArg, newPhoneArg] = process.argv.slice(2);
  if (!identifierArg || !newPhoneArg) {
    console.error('usage: set-phone <email|phone> <new phone>');
    process.exit(64);
  }

  const newPhone = normalizePhone(newPhoneArg);
  if (!newPhone) {
    console.error(`"${newPhoneArg}" does not look like a phone number.`);
    process.exit(1);
  }

  const isEmail = identifierArg.includes('@');
  const user = isEmail
    ? await prisma.user.findUnique({ where: { email: identifierArg.trim().toLowerCase() } })
    : await (async () => {
        const normalized = normalizePhone(identifierArg);
        if (!normalized) {
          console.error(`"${identifierArg}" does not look like an email or a phone number.`);
          process.exit(64);
        }
        return prisma.user.findUnique({ where: { phone: normalized } });
      })();

  if (!user) {
    console.error(`No account matches "${identifierArg}".`);
    process.exit(1);
  }

  if (user.phone === newPhone) {
    console.info(`${user.email ?? user.id} already has phone ${newPhone}. Nothing to do.`);
    return;
  }

  const holder = await prisma.user.findUnique({ where: { phone: newPhone } });
  if (holder && holder.id !== user.id) {
    console.error(`${newPhone} is already in use by another account (${holder.email ?? holder.id}).`);
    process.exit(1);
  }

  await prisma.user.update({ where: { id: user.id }, data: { phone: newPhone } });
  console.info(`Set ${user.email ?? user.id}'s phone to ${newPhone}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
