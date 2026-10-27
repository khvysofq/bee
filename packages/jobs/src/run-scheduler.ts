import { createDb, resolveDatabaseUrl } from '@bee/db';
import { createQueueClient, startQueue } from './queue';
import { runScheduler } from './scheduler';

/** scheduler 入口：pnpm jobs:scheduler（单副本；每 60s 把 job_def 收敛到 pg-boss schedule）。 */
async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }
  const db = createDb(connectionString);
  const boss = await startQueue(createQueueClient(connectionString));
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[scheduler] ${signal}，停止对账`);
    await boss.stop({ graceful: true, timeout: 15_000 });
    await db.$client.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await runScheduler({ boss, db });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});