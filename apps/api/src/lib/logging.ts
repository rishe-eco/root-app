import type { ApolloServerPlugin } from '@apollo/server';
import { unwrapResolverError } from '@apollo/server/errors';
import type { GraphQLFormattedError } from 'graphql';

/**
 * Server-side error logging.
 *
 * Without this, an unexpected error in production goes out to the client with
 * its stack stripped (`includeStacktraceInErrorResponses` is off) and leaves
 * *no* trace on the server — the one combination where a bug is both visible
 * to the customer and invisible to us.
 *
 * The distinction drawn here is deliberate-vs-not. Every error this codebase
 * raises on purpose carries a code we chose (BAD_CREDENTIALS, DESIGN_NOT_
 * COMPLETE, TOKEN_INVALID …); those are outcomes, not faults, and logging them
 * would bury the real ones. Anything without such a code — a thrown TypeError,
 * a Prisma failure — is a bug, and gets a stack.
 */

/** Codes GraphQL itself assigns when the *client* sent something malformed. */
export const CLIENT_FAULT = new Set([
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
  'BAD_USER_INPUT',
  'PERSISTED_QUERY_NOT_FOUND',
  'OPERATION_RESOLUTION_FAILURE',
]);

/**
 * Turns whatever went wrong into something safe to hand a customer.
 *
 * Apollo Server 4 does **not** mask error messages. Setting
 * `includeStacktraceInErrorResponses: false` removes the stack and nothing
 * else, so an unhandled Prisma failure sends the client its own invocation
 * text — server file paths, source line numbers, schema field names. That was
 * measured, not assumed.
 *
 * Two translations, in order:
 *
 *   - A unique-constraint violation is not a fault, it is an answer: something
 *     with that key already exists. Handling it centrally covers every
 *     resolver that inserts, including ones not written yet.
 *   - Anything else unrecognised loses its message in production. The real one
 *     is already on the server log via `errorLogging` above, which is where it
 *     belongs.
 *
 * Errors this codebase raises deliberately pass through untouched — they carry
 * a code we chose, and their wording is part of the interface.
 */
export function formatError(
  formatted: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  const code = formatted.extensions?.code;

  // Deliberate refusals and the client's own query mistakes are already safe.
  if (typeof code === 'string' && code !== 'INTERNAL_SERVER_ERROR') return formatted;

  const cause = unwrapResolverError(error) as { code?: unknown } | null;

  // Prisma's P2002. Checked structurally rather than by importing the error
  // class, which would drag the client's runtime into a pure module.
  if (cause && typeof cause === 'object' && cause.code === 'P2002') {
    return {
      ...formatted,
      message: 'Something with that key already exists.',
      extensions: { ...formatted.extensions, code: 'DUPLICATE_KEY' },
    };
  }

  if (isProduction()) {
    return {
      ...formatted,
      message: 'Something went wrong.',
      extensions: { ...formatted.extensions, code: 'INTERNAL_SERVER_ERROR' },
    };
  }

  // In development the message is the whole point.
  return formatted;
}

// Read at call time, not at import time, so a test can exercise both paths
// without the module having cached one of them.
const isProduction = () => process.env.NODE_ENV === 'production';

export const errorLogging: ApolloServerPlugin = {
  async requestDidStart() {
    return {
      async didEncounterErrors({ errors, request, contextValue }) {
        for (const error of errors) {
          const code = error.extensions?.code;

          if (typeof code === 'string' && code !== 'INTERNAL_SERVER_ERROR') {
            // A client-side mistake is worth one line without a stack; a
            // deliberate refusal is worth nothing at all.
            if (CLIENT_FAULT.has(code)) {
              console.warn(`[graphql] ${request.operationName ?? 'anonymous'}: ${code}`);
            }
            continue;
          }

          // unwrapResolverError digs out what the resolver actually threw —
          // Apollo wraps it, and the wrapper's stack points at Apollo, not us.
          const cause = unwrapResolverError(error);
          const actor = (contextValue as { user?: { id: string } | null } | undefined)?.user;

          console.error(
            `[graphql] ${request.operationName ?? 'anonymous'} failed` +
              (actor ? ` (user ${actor.id})` : ' (anonymous)'),
            cause instanceof Error ? cause.stack : cause,
          );
        }
      },
    };
  },
};
