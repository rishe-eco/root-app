import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';

import { env } from './lib/env.js';
import { prisma } from './lib/prisma.js';
import { typeDefs } from './graphql/typeDefs.js';
import { resolvers } from './graphql/resolvers.js';
import { buildContext, type Context } from './context.js';

const app = express();

app.set('trust proxy', 1); // behind host Nginx for TLS termination
app.use(cookieParser());
app.use(
  cors({
    origin: env.APP_ORIGIN,
    credentials: true,
  }),
);

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
});

await server.start();

app.use(
  '/graphql',
  express.json({ limit: '1mb' }),
  expressMiddleware(server, {
    context: async ({ req, res }) => buildContext(req, res),
  }),
);

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
