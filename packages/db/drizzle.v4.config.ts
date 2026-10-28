import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseUrl } from './src/env';

/** v4 基线：只包含 schema-v4 的 9 张表，输出到独立的 migrations-v4。 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema-v4/index.ts',
  out: './migrations-v4',
  dbCredentials: {
    url: resolveDatabaseUrl() ?? 'postgres://bee:bee@localhost:5432/bee',
  },
  verbose: true,
  strict: true,
});