import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { formatError } from './logging.js';

/**
 * What reaches the client when something goes wrong.
 *
 * Apollo Server 4 passes internal error messages through untouched — the
 * `includeStacktraceInErrorResponses: false` that production sets removes the
 * stack and nothing else. Without formatError, a Prisma failure hands the
 * caller the server's own file paths and schema field names.
 */

const SECRET = 'Invalid `prisma.user.create()` in /srv/root/apps/api/src/x.ts:42';

const original = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = original;
});

/** What Apollo would have sent for an unhandled throw. */
const internal = (message = SECRET): GraphQLFormattedError => ({
  message,
  extensions: { code: 'INTERNAL_SERVER_ERROR' },
});

test('in production an unhandled error loses its message', () => {
  process.env.NODE_ENV = 'production';
  const out = formatError(internal(), new Error(SECRET));
  assert.equal(out.message, 'Something went wrong.');
  assert.equal(out.extensions?.code, 'INTERNAL_SERVER_ERROR');
  assert.ok(!JSON.stringify(out).includes('/srv/root'), 'a server path leaked');
  assert.ok(!JSON.stringify(out).includes('prisma.user'), 'a schema internal leaked');
});

test('in development the message survives, because that is the point', () => {
  process.env.NODE_ENV = 'development';
  assert.equal(formatError(internal(), new Error(SECRET)).message, SECRET);
});

test('a deliberate refusal passes through untouched, in production too', () => {
  process.env.NODE_ENV = 'production';
  const refusal: GraphQLFormattedError = {
    message: 'The design must be approved and complete first.',
    extensions: { code: 'GATE_DESIGN_INCOMPLETE' },
  };
  const out = formatError(
    refusal,
    new GraphQLError(refusal.message, { extensions: { code: 'GATE_DESIGN_INCOMPLETE' } }),
  );
  assert.deepEqual(out, refusal);
});

test("a client's own query mistake is still explained to them", () => {
  process.env.NODE_ENV = 'production';
  const bad: GraphQLFormattedError = {
    message: 'Cannot query field "nope" on type "Query".',
    extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
  };
  assert.deepEqual(formatError(bad, new Error('x')), bad);
});

test('a unique-constraint violation becomes an answer, not a fault', () => {
  process.env.NODE_ENV = 'production';
  // Shaped like a PrismaClientKnownRequestError, which carries `.code`.
  const prismaError = Object.assign(new Error(SECRET), { code: 'P2002' });
  const out = formatError(internal(), prismaError);
  assert.equal(out.extensions?.code, 'DUPLICATE_KEY');
  assert.equal(out.message, 'Something with that key already exists.');
  assert.ok(!out.message.includes('/srv/root'));
});

test('the duplicate-key translation also applies in development', () => {
  // It is a real answer, not a debugging aid — the admin UI should see the
  // same code in both environments or it cannot branch on it.
  process.env.NODE_ENV = 'development';
  const prismaError = Object.assign(new Error(SECRET), { code: 'P2002' });
  assert.equal(formatError(internal(), prismaError).extensions?.code, 'DUPLICATE_KEY');
});

test('an error with no code at all is masked in production', () => {
  process.env.NODE_ENV = 'production';
  const out = formatError({ message: SECRET }, new Error(SECRET));
  assert.equal(out.message, 'Something went wrong.');
});
