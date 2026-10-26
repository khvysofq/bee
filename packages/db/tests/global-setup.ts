/**
 * 集成测试全局准备：
 *  1. 由 DATABASE_URL 派生独立测试库连接串（bee_test），绝不触碰开发库 bee；
 *  2. 重建 bee_test 并应用全部迁移（含 schema 与守护触发器）；
 *  3. 把测试库连接串放进 BEE_TEST_DATABASE_URL 供测试文件读取。
 * 没有 DATABASE_URL（未起本地 Postgres）时静默跳过，集成测试自动 skip，纯单元测试照常运行。
 */
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../src/index';
import { resolveDatabaseUrl } from '../src/env';

function rewriteDb(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

export async function setup(): Promise<void> {
  const base = resolveDatabaseUrl();
  if (!base) {
    console.warn('[global-setup] 未设置 DATABASE_URL，跳过集成测试库准备。');
    return;
  }
  const adminUrl = rewriteDb(base, 'postgres');
  const testUrl = rewriteDb(base, 'bee_test');

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS bee_test WITH (FORCE)`);
  await admin.query(`CREATE DATABASE bee_test`);
  await admin.end();

  const db = createDb(testUrl);
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
  await db.$client.end();

  process.env.BEE_TEST_DATABASE_URL = testUrl;
}
