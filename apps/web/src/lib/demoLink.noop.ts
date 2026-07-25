import { ApolloLink } from '@apollo/client';

/**
 * Stands in for `demoLink` in every build that is not a demo build. Vite
 * aliases the module here (see vite.config.ts), which is what keeps the
 * placeholder contract data out of the production bundle — tree-shaking alone
 * would not, because the demo module builds its state on import.
 */
export const demoLink = new ApolloLink((operation, forward) => forward(operation));
