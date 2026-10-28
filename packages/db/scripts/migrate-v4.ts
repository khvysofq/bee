/**
 * v4 迁移入口：只应用 migrations-v4，不碰线上 bee 库。
 *
 * 连接串优先 DATABASE_URL_V4；否则取 DATABASE_URL 并把库名换成 bee_v4。
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { resolveV4DatabaseUrl } from '../src/env';

async function main() {
  const pool = new pg.Pool({ connectionString: resolveV4DatabaseUrl(), max: 1 });
  const db = drizzle(pool);
  console.log('应用迁移 packages/db/migrations-v4 ...');
  await migrate(db, { migrationsFolder: new URL('../migrations-v4', import.meta.url).pathname });
  await pool.end();
  console.log('v4 迁移完成。');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});