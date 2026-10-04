import { PrismaClient } from '@prisma/client';

const dev = process.env.NODE_ENV !== 'production';

export const prisma = new PrismaClient({
  log: dev
    ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
    : ['warn', 'error'],
});

/**
 * How many statements this process has sent to the database, outside
 * production (where the event is not subscribed to at all). It exists so a
 * test can *state* what a resolver costs rather than hoping it is cheap —
 * `j12.test.ts` holds `myAttention` to a number of queries that does not grow
 * with the number of contracts (journeys build plan J12: "one query per
 * contract per item kind is too many for a sales user with every contract").
 */
let statements = 0;
if (dev) {
  (prisma as unknown as { $on(event: 'query', cb: () => void): void }).$on('query', () => {
    statements += 1;
  });
}

export const statementsRun = () => statements;
