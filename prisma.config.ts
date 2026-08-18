import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

// DIRECT_URL first: schema pushes and migrations must run over a direct/session
// connection. A transaction pooler breaks Prisma's session-scoped advisory lock.
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
