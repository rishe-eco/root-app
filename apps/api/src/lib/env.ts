import { z } from 'zod';

/**
 * Fail loudly at boot rather than mysteriously at the first request. In
 * particular JWT_SECRET has no default — an unset signing key is a silent
 * security hole, not a convenience.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see .env.example)'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Where the customer-facing app lives; invite and reset links point here. */
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  COOKIE_NAME: z.string().default('root_session'),
  SESSION_DAYS: z.coerce.number().default(14),
  INVITE_DAYS: z.coerce.number().default(14),
  RESET_HOURS: z.coerce.number().default(2),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid environment:\n${issues.join('\n')}`);
}

export const env = parsed.data;
