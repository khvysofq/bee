import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../src/client';
import { requireDatabaseUrl } from '../src/env';

async function main() {
  const connectionString = requireDatabaseUrl();
  const db = createDb(connectionString);
  console.log('应用迁移 packages/db/migrations ...');
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
  console.log('迁移完成。');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
