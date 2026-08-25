import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';

import { env } from './lib/env.js';
import { errorLogging, formatError } from './lib/logging.js';
import { enforceTokenScope } from './lib/tokenScope.js';
import { prisma } from './lib/prisma.js';
import { typeDefs } from './graphql/typeDefs.js';
import { resolvers } from './graphql/resolvers/index.js';
import { buildContext, type Context } from './context.js';
import { ensureStorageReady } from './lib/storage.js';
import { filesRouter, filesErrorHandler } from './routes/files.js';
import { askRouter, askErrorHandler } from './routes/ask.js';

const app = express();

// Not a constant, because the right number depends on the deployment shape
// and getting it wrong corrupts `Signature.ip` silently. See env.ts.
app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.use(cookieParser());
app.use(
  cors({
    origin: env.APP_ORIGIN,
    credentials: true,
  }),
);

// Before the first request, not on the first upload — the same reason env.ts
// validates at boot. A STORAGE_DIR that cannot be created is a deployment
// mistake, and it should stop the process rather than surface as one broken
// upload weeks later.
await ensureStorageReady();

// Mounted ahead of /graphql and outside express.json: these carry multipart
// bodies and binary responses, neither of which that middleware should see.
app.use(filesRouter);
// Its own small express.json, scoped to POST /ask only (routes/ask.ts) — a
// streamed SSE response is as far from Apollo's JSON contract as upload and
// download are, so it stays a plain route rather than a GraphQL special case.
app.use(askRouter);

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, db: 'unreachable' });
  }
});

const server = new ApolloServer<Context>({
  typeDefs,
  resolvers,
  // Stack traces are for the server log, not for the client.
  includeStacktraceInErrorResponses: env.NODE_ENV !== 'production',
  // Apollo leaves this on everywhere. The schema names every field of a
  // customer's contract, so in production it is a map handed to anyone who
  // asks; in development it is what makes Sandbox usable.
  introspection: env.NODE_ENV !== 'production',
  // …and the log the stack traces above are for. `enforceTokenScope` sits
  // beside it rather than inside a resolver on purpose — see lib/tokenScope.ts.
  plugins: [errorLogging, enforceTokenScope],
  // Apollo does not mask error messages on its own — see logging.ts.
  formatError,
});

await server.start();

app.use(
  '/graphql',
  express.json({ limit: '1mb' }),
  expressMiddleware(server, {
    context: async ({ req, res }) => buildContext(req, res),
  }),
);

// Last, so it sees errors thrown by the routes above. Express picks an
// error handler by its four-argument shape, and only after every route.
app.use(filesErrorHandler);
app.use(askErrorHandler);

app.listen(env.PORT, () => {
  console.info(`Root API listening on http://localhost:${env.PORT}/graphql`);
});

const shutdown = async () => {
  await server.stop();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
