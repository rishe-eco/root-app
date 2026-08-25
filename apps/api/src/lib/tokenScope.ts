import type { ApolloServerPlugin } from '@apollo/server';
import { GraphQLError } from 'graphql';
import type { Context } from '../context.js';

/**
 * Read-only means read-only, enforced once.
 *
 * **Why a plugin and not a guard in each mutation.** Scope is a property of
 * the *operation*, and the operation's type is only known after the document
 * is parsed — which is precisely where this hook runs. Scattering the check
 * across resolvers would restate one rule in fifty places, and the failure
 * mode of that is silent: the fifty-first mutation, written next month by
 * someone who did not know the rule existed, would quietly be writable from a
 * read-only token. Nobody would see it until it mattered.
 *
 * `didResolveOperation` also runs *before* any resolver, so a refused write
 * has not touched the database — the request is rejected, not rolled back.
 *
 * Session callers pass through untouched: a cookie has no scope, and giving
 * it one here would be inventing a rule the login flow never agreed to.
 */
export const enforceTokenScope: ApolloServerPlugin<Context> = {
  async requestDidStart() {
    return {
      async didResolveOperation({ operation, contextValue }) {
        const auth = contextValue.auth;
        if (auth?.kind !== 'apiToken') return;

        // Apollo types `operation` as optional. It is resolved by the time
        // this hook runs, so this branch is unreachable in practice — but the
        // safe answer to "which kind of operation is this" being unknown is
        // to refuse, not to assume it was a query. Failing open here would
        // make the one rule this file exists to enforce depend on a type
        // guard falling the right way.
        if (!operation) {
          throw new GraphQLError('Could not determine the operation type.', {
            extensions: { code: 'OPERATION_RESOLUTION_FAILURE' },
          });
        }

        if (operation.operation === 'mutation' && auth.scope !== 'WRITE') {
          throw new GraphQLError(
            'This API token is read-only. Issue a write-scoped token to make changes.',
            { extensions: { code: 'TOKEN_READ_ONLY' } },
          );
        }

        // Not "not implemented yet" — a subscription is a long-lived
        // connection whose authorization would be decided once, at open, and
        // then held open across every later change to the owner. That is the
        // one shape the re-read-the-capability rule in lib/apiTokens.ts
        // cannot cover, so tokens are kept out of it by construction rather
        // than by remembering to revisit this when subscriptions arrive.
        if (operation.operation === 'subscription') {
          throw new GraphQLError('Subscriptions are not available to API tokens.', {
            extensions: { code: 'TOKEN_SCOPE_UNSUPPORTED' },
          });
        }
      },
    };
  },
};
