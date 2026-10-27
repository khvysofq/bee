import type { PgBoss } from 'pg-boss';
import { eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { isValidCron } from './cron';
import { DEFAULT_TZ, QUEUE_NAME } from './types';

/**
 * 调度对账（ADR-0010 §2.1）：每 60s 读一遍 job_def，把 pg-boss schedule 收敛到库里的状态。
 *
 * 简单做法刻意保留：增/改/删都在同一轮对账里收敛，不需要在管理 API 里做双写。
 * 停用或删除的任务 → unschedule；「下次执行」自然为空。
 */

export interface ReconcileResult {
  scheduled: string[];
  removed: string[];
  skipped: Array<{ code: string; reason: string }>;
}

export async function reconcileSchedules(boss: PgBoss, db: BeeDb): Promise<ReconcileResult> {
  const jobs = await db
    .select({
      code: dbSchema.jobDef.code,
      enabled: dbSchema.jobDef.enabled,
      schedule: dbSchema.jobDef.schedule,
    })
    .from(dbSchema.jobDef);

  const desired = new Map<string, { cron: string; tz: string }>();
  const skipped: ReconcileResult['skipped'] = [];
  for (const job of jobs) {
    const schedule = job.schedule as { cron?: string; tz?: string; enabled?: boolean };
    if (!job.enabled || schedule.enabled === false) continue;
    if (!schedule.cron || !isValidCron(schedule.cron)) {
      skipped.push({ code: job.code, reason: `cron 非法或缺失：${schedule.cron ?? '∅'}` });
      continue;
    }
    desired.set(job.code, { cron: schedule.cron, tz: schedule.tz ?? DEFAULT_TZ });
  }

  const scheduled: string[] = [];
  for (const [code, schedule] of desired) {
    await boss.schedule(QUEUE_NAME, schedule.cron, { jobCode: code, scheduledFor: null, trigger: 'cron' }, {
      tz: schedule.tz,
      key: code,
      retryLimit: 0,
    });
    scheduled.push(code);
  }

  const removed: string[] = [];
  const existing = await boss.getSchedules(QUEUE_NAME);
  for (const entry of existing as Array<{ key?: string; name: string }>) {
    const key = entry.key ?? entry.name;
    if (!desired.has(key)) {
      await boss.unschedule(QUEUE_NAME, key);
      removed.push(key);
    }
  }

  return { scheduled, removed, skipped };
}

export async function runScheduler(args: {
  boss: PgBoss;
  db: BeeDb;
  intervalMs?: number;
  once?: boolean;
}): Promise<void> {
  const interval = args.intervalMs ?? 60_000;
  do {
    const result = await reconcileSchedules(args.boss, args.db);
    console.log(
      `[scheduler] scheduled=${result.scheduled.length} removed=${result.removed.length} skipped=${result.skipped.length}`,
    );
    for (const item of result.skipped) console.log(`[scheduler] skip ${item.code}: ${item.reason}`);
    if (args.once) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  } while (true);
}

/** 仅供测试与巡检：某任务当前是否注册了 cron。 */
export async function isScheduled(boss: PgBoss, jobCode: string): Promise<boolean> {
  const rows = (await boss.getSchedules(QUEUE_NAME)) as Array<{ key?: string; name: string }>;
  return rows.some((row) => (row.key ?? row.name) === jobCode);
}

export async function deleteJobSchedule(boss: PgBoss, jobCode: string): Promise<void> {
  await boss.unschedule(QUEUE_NAME, jobCode);
}

/** 未使用但保留导出，便于脚本里按 code 精确查询任务定义。 */
export async function loadJobDef(db: BeeDb, code: string) {
  const [job] = await db.select().from(dbSchema.jobDef).where(eq(dbSchema.jobDef.code, code)).limit(1);
  return job ?? null;
}