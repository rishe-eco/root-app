import { ApolloClient, InMemoryCache, createHttpLink } from '@apollo/client';

/**
 * Same-origin in development (Vite proxies /graphql to the API on :4000), so
 * the httpOnly session cookie is sent without CORS credentials gymnastics.
 */
const link = createHttpLink({
  uri: import.meta.env.VITE_GRAPHQL_URL ?? '/graphql',
  credentials: 'include',
});

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
