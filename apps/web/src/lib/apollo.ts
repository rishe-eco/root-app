import { ApolloClient, InMemoryCache, createHttpLink } from '@apollo/client';
import { demoLink } from './demoLink';

/**
 * Same-origin in development (Vite proxies /graphql to the API on :4000), so
 * the httpOnly session cookie is sent without CORS credentials gymnastics.
 */
const httpLink = createHttpLink({
  uri: import.meta.env.VITE_GRAPHQL_URL ?? '/graphql',
  credentials: 'include',
});

/**
 * VITE_DEMO=1 serves the portal from an in-memory stand-in so it can be
 * reviewed before the database exists. Every other build aliases that module
 * to a pass-through link (see vite.config.ts), so the placeholder contract
 * data cannot reach production.
 */
const link = import.meta.env.VITE_DEMO === '1' ? demoLink : httpLink;

export const apollo = new ApolloClient({
  link,
  cache: new InMemoryCache({
    typePolicies: {
      Contract: { keyFields: ['id'] },
      DesignConcept: { keyFields: ['id'] },
      PageDesign: { keyFields: ['id'] },
      ScopeItem: { keyFields: ['id'] },
    },
  }),
  defaultOptions: {
    watchQuery: { fetchPolicy: 'cache-and-network' },
  },
});
