import { and, desc, eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { nextCronRun } from '@bee/jobs/cron';
import { nextRandomRun } from '@bee/jobs/schedule-window';
import { todayInShanghai } from '@bee/jobs/validator';

const DEFAULT_TZ = 'Asia/Shanghai';

/**
 * /internal/jobs 的只读数据装配。管理页与管理 API 共用，避免两处口径漂移。
 * 全部读数来自库；「下次执行」由 job_def.schedule 计算，停用即为空。
 */

export type JobDefRow = typeof dbSchema.jobDef.$inferSelect;
export type JobRunRow = typeof dbSchema.jobRun.$inferSelect;
export type CandidateRow = typeof dbSchema.ingestCandidate.$inferSelect;

export interface JobWithStats {
  definition: JobDefRow;
  latestRun: JobRunRow | null;
  recentRuns: JobRunRow[];
  successRate20: { succeeded: number; total: number; pct: number | null };
  nextRunAt: string | null;
}

export interface JobsData {
  generatedAt: string;
  today: string;
  stats: {
    total: number;
    enabled: number;
    todayRuns: number;
    todayFailed: number;
  };
  jobs: JobWithStats[];
  runs: JobRunRow[];
  candidates: CandidateRow[];
}

function scheduleOf(job: JobDefRow): {
  mode?: string;
  cron?: string;
  tz?: string;
  enabled?: boolean;
  windowStart?: string;
  windowEnd?: string;
} {
  return (
    (job.schedule as {
      mode?: string;
      cron?: string;
      tz?: string;
      enabled?: boolean;
      windowStart?: string;
      windowEnd?: string;
    } | null) ?? {}
  );
}

export function nextRunFor(job: JobDefRow, now: Date = new Date()): Date | null {
  const schedule = scheduleOf(job);
  if (!job.enabled || schedule.enabled === false) return null;
  if (schedule.mode === 'random_window' && schedule.windowStart && schedule.windowEnd) {
    return nextRandomRun(job.code, now, {
      mode: 'random_window',
      windowStart: schedule.windowStart,
      windowEnd: schedule.windowEnd,
      tz: schedule.tz ?? DEFAULT_TZ,
    });
  }
  if (!schedule.cron) return null;
  return nextCronRun(schedule.cron, schedule.tz ?? DEFAULT_TZ, now);
}

export function successRate(runs: JobRunRow[]): JobWithStats['successRate20'] {
  const latest = runs.slice(0, 20);
  const succeeded = latest.filter((run) => run.status === 'succeeded').length;
  return {
    succeeded,
    total: latest.length,
    pct: latest.length === 0 ? null : Math.round((succeeded / latest.length) * 100),
  };
}

export async function loadJobsData(
  db: BeeDb,
  options: { runLimit?: number; candidateLimit?: number; now?: Date } = {},
): Promise<JobsData> {
  const now = options.now ?? new Date();
  const today = todayInShanghai(now);
  const startOfToday = new Date(`${today}T00:00:00+08:00`);

  const definitions = await db.select().from(dbSchema.jobDef).orderBy(dbSchema.jobDef.code);
  const runs = await db
    .select()
    .from(dbSchema.jobRun)
    .orderBy(desc(dbSchema.jobRun.startedAt), desc(dbSchema.jobRun.createdAt))
    .limit(options.runLimit ?? 500);
  const candidates = await db
    .select()
    .from(dbSchema.ingestCandidate)
    .orderBy(desc(dbSchema.ingestCandidate.createdAt))
    .limit(options.candidateLimit ?? 200);

  const runsByJob = new Map<string, JobRunRow[]>();
  for (const run of runs) {
    const list = runsByJob.get(run.jobCode) ?? [];
    list.push(run);
    runsByJob.set(run.jobCode, list);
  }

  const jobs: JobWithStats[] = definitions.map((definition) => {
    const jobRuns = runsByJob.get(definition.code) ?? [];
    const next = nextRunFor(definition, now);
    return {
      definition,
      latestRun: jobRuns[0] ?? null,
      recentRuns: jobRuns.slice(0, 10),
      successRate20: successRate(jobRuns.slice(0, 20)),
      nextRunAt: next ? next.toISOString() : null,
    };
  });

  const todayRuns = runs.filter((run) => {
    const at = run.startedAt ?? run.createdAt;
    return at >= startOfToday;
  });

  return {
    generatedAt: now.toISOString(),
    today,
    stats: {
      total: definitions.length,
      enabled: definitions.filter((job) => job.enabled).length,
      todayRuns: todayRuns.length,
      todayFailed: todayRuns.filter((run) => run.status === 'failed' || run.status === 'dead').length,
    },
    jobs,
    runs,
    candidates,
  };
}

export async function loadJobRuns(
  db: BeeDb,
  filters: { job?: string; status?: string; limit?: number },
): Promise<JobRunRow[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const base = db.select().from(dbSchema.jobRun);
  if (filters.job && filters.status) {
    return base
      .where(and(eq(dbSchema.jobRun.jobCode, filters.job), eq(dbSchema.jobRun.status, filters.status)))
      .orderBy(desc(dbSchema.jobRun.startedAt), desc(dbSchema.jobRun.createdAt))
      .limit(limit);
  }
  if (filters.job) {
    return base
      .where(eq(dbSchema.jobRun.jobCode, filters.job))
      .orderBy(desc(dbSchema.jobRun.startedAt), desc(dbSchema.jobRun.createdAt))
      .limit(limit);
  }
  if (filters.status) {
    return base
      .where(eq(dbSchema.jobRun.status, filters.status))
      .orderBy(desc(dbSchema.jobRun.startedAt), desc(dbSchema.jobRun.createdAt))
      .limit(limit);
  }
  return base.orderBy(desc(dbSchema.jobRun.startedAt), desc(dbSchema.jobRun.createdAt)).limit(limit);
}

export async function loadCandidates(
  db: BeeDb,
  filters: { status?: string; limit?: number },
): Promise<CandidateRow[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const base = db.select().from(dbSchema.ingestCandidate);
  if (filters.status) {
    return base
      .where(eq(dbSchema.ingestCandidate.status, filters.status))
      .orderBy(desc(dbSchema.ingestCandidate.createdAt))
      .limit(limit);
  }
  return base.orderBy(desc(dbSchema.ingestCandidate.createdAt)).limit(limit);
}