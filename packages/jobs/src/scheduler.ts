import type { PgBoss } from 'pg-boss';
import { and, eq, gte } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { isValidCron } from './cron';
import { dateAtLocalMinutes, dueMinuteToday, localDateAndMinutes, type RandomWindowSchedule } from './schedule-window';
import { enqueueRun } from './queue';
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
  /** 本轮按随机窗口入队的任务。 */
  enqueued: string[];
}

export async function reconcileSchedules(
  boss: PgBoss,
  db: BeeDb,
  now = new Date(),
): Promise<ReconcileResult> {
  const jobs = await db
    .select({
      code: dbSchema.jobDef.code,
      enabled: dbSchema.jobDef.enabled,
      schedule: dbSchema.jobDef.schedule,
    })
    .from(dbSchema.jobDef);

  const desired = new Map<string, { cron: string; tz: string }>();
  const skipped: ReconcileResult['skipped'] = [];
  const randomJobs: Array<{ code: string; schedule: RandomWindowSchedule }> = [];
  for (const job of jobs) {
    const schedule = job.schedule as {
      mode?: string;
      cron?: string;
      tz?: string;
      enabled?: boolean;
      windowStart?: string;
      windowEnd?: string;
    };
    if (!job.enabled || schedule.enabled === false) continue;
    if (schedule.mode === 'random_window') {
      if (!schedule.windowStart || !schedule.windowEnd) {
        skipped.push({ code: job.code, reason: '随机窗口缺 windowStart / windowEnd' });
        continue;
      }
      randomJobs.push({
        code: job.code,
        schedule: {
          mode: 'random_window',
          windowStart: schedule.windowStart,
          windowEnd: schedule.windowEnd,
          tz: schedule.tz ?? DEFAULT_TZ,
        },
      });
      continue;
    }
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

  // 随机窗口任务不走 pg-boss cron，由本循环按「今天该几点 + 今天还没跑过」入队。
  const enqueued: string[] = [];
  for (const job of randomJobs) {
    const due = dueMinuteToday(job.code, now, job.schedule);
    if (!due || !due.due) continue;
    // 「今天跑过没有」按任务时区的本地日期判断，不能用 UTC 零点（+08:00 会差一天）。
    const recent = await db
      .select({ scheduledFor: dbSchema.jobRun.scheduledFor, startedAt: dbSchema.jobRun.startedAt })
      .from(dbSchema.jobRun)
      .where(and(eq(dbSchema.jobRun.jobCode, job.code), gte(dbSchema.jobRun.startedAt, new Date(now.getTime() - 40 * 3600_000))));
    const tz = job.schedule.tz ?? DEFAULT_TZ;
    const ranToday = recent.some((run) => {
      const at = run.scheduledFor ?? run.startedAt;
      return at ? localDateAndMinutes(new Date(at), tz).date === due.date : false;
    });
    if (ranToday) continue;
    const target = dateAtLocalMinutes(now, tz, due.date, due.minutes);
    await enqueueRun(boss, job.code, { scheduledFor: target, trigger: 'cron' });
    enqueued.push(job.code);
  }

  return { scheduled, removed, skipped, enqueued };
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
      `[scheduler] scheduled=${result.scheduled.length} removed=${result.removed.length} skipped=${result.skipped.length} enqueued=${result.enqueued.length}`,
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