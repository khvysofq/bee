import { createDb, resolveDatabaseUrl } from '@bee/db';
import { createQueueClient, startQueue } from './queue';
import { runJobOnce } from './worker';
import { QUEUE_NAME, type QueueJobData } from './types';

/**
 * T1 worker 入口：pnpm jobs:worker
 *
 * 环境：DATABASE_URL（队列 + job_def/source_policy 读取）、INGEST_URL、INGEST_TOKEN。
 * 不打印 INGEST_TOKEN；业务写入全部经 HTTP ingest。
 */
async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }
  const ingestToken = process.env.INGEST_TOKEN;
  if (!ingestToken) {
    console.error('缺少 INGEST_TOKEN（worker 必须经 /internal/ingest 写入，不允许直连业务表）');
    process.exit(1);
  }
  const ingestUrl = process.env.INGEST_URL ?? 'http://127.0.0.1:10800';
  const db = createDb(connectionString);
  const boss = await startQueue(createQueueClient(connectionString));

  await boss.work<QueueJobData>(QUEUE_NAME, { batchSize: 1 }, async (jobs: Array<{ data: QueueJobData }>) => {
    for (const job of jobs) {
      const data = job.data;
      console.log(`[worker] pickup job=${data.jobCode} trigger=${data.trigger} scheduled_for=${data.scheduledFor ?? 'null'}`);
      try {
        await runJobOnce({
          db,
          jobCode: data.jobCode,
          scheduledFor: data.scheduledFor ? new Date(data.scheduledFor) : null,
          ingestUrl,
          ingestToken,
        });
      } catch (error) {
        console.error(`[worker] job=${data.jobCode} error ${String(error)}`);
        throw error;
      }
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal}，停止领取新任务`);
    await boss.stop({ graceful: true, timeout: 15_000 });
    await db.$client.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  console.log(`[worker] started queue=${QUEUE_NAME} ingest=${ingestUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});