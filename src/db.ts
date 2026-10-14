import { createClient } from '@libsql/client';

/** Turso/libSQL client. The current routes use an in-memory adapter for local bootstrap;
 * this client is the persistence seam for the Drizzle migration. */
export const turso = createClient({
  url: process.env.DATABASE_URL ?? 'file:local.db',
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined
});
