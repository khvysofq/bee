import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as dbSchema from './schema';
import * as dbSchemaV4 from './schema-v4';

export type BeeDb = ReturnType<typeof createDb>;
export type BeeV4Db = ReturnType<typeof createV4Db>;

/**
 * 创建 drizzle 客户端。连接串由调用方注入（web/pipeline/tests 各自管理生命周期）。
 * pg numeric 运行时为 string —— 金额精度优先，比较时用字符串或显式 parse，禁止隐式 Number()。
 */
export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return drizzle(pool, { schema: dbSchema });
}

/** v4 客户端：只挂 9 张 v4 表，供采集管线与 v4 脚本使用。 */
export function createV4Db(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return drizzle(pool, { schema: dbSchemaV4 });
}
