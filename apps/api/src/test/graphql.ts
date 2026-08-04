import { ApolloServer } from '@apollo/server';
import type { User } from '@prisma/client';
import { typeDefs } from '../graphql/typeDefs.js';
import { resolvers } from '../graphql/resolvers/index.js';
import type { Context } from '../context.js';
import { formatError } from '../lib/logging.js';

/**
 * Executes operations against the real schema and the real resolvers, in
 * process — no HTTP, no port, no cookie.
 *
 * The context is injected rather than built from a request, which draws the
 * line these tests are on the right side of. `buildContext` turns a cookie
 * into a user; that is one function, and whether it round-trips correctly is
 * a browser question, so e2e owns it. Everything *after* it — who may read
 * whose contract, which mutation refuses what and with which code — is the
 * part that has actually had bugs, and it is all reachable from here.
 */

const server = new ApolloServer<Context>({
  typeDefs,
  resolvers,
  includeStacktraceInErrorResponses: true, // a failing test wants the stack
  // The same translation production uses, so tests see the codes clients see.
  formatError,
});

export type ExecResult = {
  data: Record<string, unknown> | null | undefined;
  errors: Array<{ message: string; code?: string; stack?: string }>;
  /** The code of the first error, which is what tests almost always assert. */
  code?: string;
};

/**
 * @param as the signed-in user, or null for an anonymous caller
 */
export async function exec(
  query: string,
  opts: { as?: User | null; variables?: Record<string, unknown> } = {},
): Promise<ExecResult> {
  // `req`/`res` are only reachable through resolvers that record a request's
  // IP or set a cookie. Enough of a stub to keep those from throwing, and no
  // more — a fuller fake would start asserting things about Express.
  const contextValue = {
    req: { ip: '203.0.113.7', get: () => 'test-agent' },
    res: { cookie: () => undefined, clearCookie: () => undefined },
    user: opts.as ?? null,
  } as unknown as Context;

  const response = await server.executeOperation(
    { query, variables: opts.variables },
    { contextValue },
  );

  if (response.body.kind !== 'single') {
    throw new Error('Incremental delivery is not used here.');
  }
  const { data, errors } = response.body.singleResult;
  const mapped = (errors ?? []).map((e) => ({
    message: e.message,
    code: e.extensions?.code as string | undefined,
    stack: (e.extensions?.stacktrace as string[] | undefined)?.slice(0, 6).join('\n'),
  }));

  return {
    // GraphQL hands back null-prototype objects, which deepEqual reports as
    // unequal to an object literal with identical contents. The payload is
    // JSON by definition, so a round-trip is lossless and spares every test
    // from having to know this.
    data: data ? (JSON.parse(JSON.stringify(data)) as Record<string, unknown>) : data,
    errors: mapped,
    code: mapped[0]?.code,
  };
}

/** Asserts nothing went wrong, and reports the actual error when it did. */
export function ok(result: ExecResult): Record<string, unknown> {
  if (result.errors.length > 0) {
    const [first] = result.errors;
    throw new Error(
      `expected success, got ${first.code}: ${first.message}` +
        (first.stack ? `\n${first.stack}` : ''),
    );
  }
  if (!result.data) throw new Error('expected data, got none');
  return result.data;
}

export const stop = () => server.stop();
