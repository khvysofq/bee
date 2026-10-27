import { resolveDatabaseUrl } from '@bee/db';
import { createQueueClient, startQueue, type QueueClient } from '@bee/jobs/queue';

/**
 * Web 侧队列单例：管理 API 的「立即执行」只负责入队，执行由独立 worker 进程完成。
 * 单例避免 Next dev 热更新反复建连接池。
 */
const globalForBoss = globalThis as unknown as { __beeBossPromise?: Promise<QueueClient> };

export async function getBoss(): Promise<QueueClient | null> {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) return null;
  if (!globalForBoss.__beeBossPromise) {
    globalForBoss.__beeBossPromise = startQueue(createQueueClient(connectionString));
  }
  try {
    return await globalForBoss.__beeBossPromise;
  } catch (error) {
    globalForBoss.__beeBossPromise = undefined;
    throw error;
  }
}