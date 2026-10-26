import { createDb, dbSchema, resolveDatabaseUrl } from '@bee/db';

/**
 * Web 侧 DB 客户端（server-only）。
 * 单实例复用连接池；开发库默认 postgres://bee:bee@localhost:5432/bee（见 .env.example）。
 */
const connectionString = resolveDatabaseUrl() ?? 'postgres://bee:bee@localhost:5432/bee';

const globalForDb = globalThis as unknown as { __beeDb?: ReturnType<typeof createDb> };

export const db = globalForDb.__beeDb ?? createDb(connectionString);
export { dbSchema };
