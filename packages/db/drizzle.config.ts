import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseUrl } from './src/env';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: resolveDatabaseUrl() ?? 'postgres://bee:bee@localhost:5432/bee',
  },
  verbose: true,
  strict: true,
});
