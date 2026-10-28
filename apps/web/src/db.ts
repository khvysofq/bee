import { createDb, resolveDatabaseUrl } from '@bee/db';

/**
 * Web 侧 DB 客户端（server-only）。
 * 单实例复用连接池；开发库默认 postgres://bee:bee@localhost:5432/bee（见 .env.example）。
 *
 * 数据访问统一使用 v4 schema：各数据层显式 `import { v4 } from '@bee/db'`，
 * 不再从本模块 re-export 旧 25 表 schema。
 */
const connectionString = resolveDatabaseUrl() ?? 'postgres://bee:bee@localhost:5432/bee';

const globalForDb = globalThis as unknown as { __beeDb?: ReturnType<typeof createDb> };

export const db = globalForDb.__beeDb ?? createDb(connectionString);