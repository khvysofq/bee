import { PgBoss } from 'pg-boss';
import { QUEUE_NAME, type QueueJobData } from './types';

/**
 * pg-boss 装配（ADR-0005 / ADR-0010 判断三）：同库队列，无新增基础设施。
 *
 * 单队列 `job.run`（ADR 概念名 job:run；pg-boss v12 不接受冒号）：
 * 任务内按 job_def.priority 排序即可；量大再拆优先级队列。
 * retryLimit=0 —— 重试由 job_run.attempt 与业务退避控制，避免 pg-boss 与业务各重试一遍。
 */

export type QueueClient = PgBoss;

export const QUEUE_EXPIRE_SECONDS = 900;

export function createQueueClient(connectionString: string): PgBoss {
  return new PgBoss({
    connectionString,
    schema: 'pgboss',
    application_name: 'bee-jobs',
    // 测试与本地跑单轮时不需要后台维护任务；start() 会按需创建 schema。
    monitorIntervalSeconds: 60,
  });
}

export async function startQueue(boss: PgBoss): Promise<PgBoss> {
  await boss.start();
  await boss.createQueue(QUEUE_NAME, {
    retryLimit: 0,
    expireInSeconds: QUEUE_EXPIRE_SECONDS,
  });
  return boss;
}

function jobSingletonKey(data: QueueJobData): string {
  return data.scheduledFor
    ? `${data.jobCode}:${data.scheduledFor}`
    : `manual:${data.jobCode}`;
}

/**
 * 入队一次执行。返回 pg-boss job id；null = 同 singletonKey 的任务仍在队列中（幂等去重）。
 * 手动触发的 singletonKey 按任务 code 收敛：连点多次只排一次；执行完成后再点才会再排。
 */
export async function enqueueRun(
  boss: PgBoss,
  jobCode: string,
  options: { scheduledFor?: Date | null; trigger?: 'cron' | 'manual' } = {},
): Promise<string | null> {
  const data: QueueJobData = {
    jobCode,
    scheduledFor: options.scheduledFor ? options.scheduledFor.toISOString() : null,
    trigger: options.trigger ?? (options.scheduledFor ? 'cron' : 'manual'),
  };
  return boss.send(QUEUE_NAME, data, {
    singletonKey: jobSingletonKey(data),
    retryLimit: 0,
    expireInSeconds: QUEUE_EXPIRE_SECONDS,
  });
}

export async function stopQueue(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: true, timeout: 15_000 });
}

export { QUEUE_NAME };