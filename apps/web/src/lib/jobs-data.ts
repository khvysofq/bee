import { and, desc, eq } from 'drizzle-orm';
import { v4, type BeeDb } from '@bee/db';
import { nextCronRun } from '@bee/jobs/cron';
import { nextRandomRun } from '@bee/jobs/schedule-window';
import { todayInShanghai } from '@bee/jobs/validator';

const DEFAULT_TZ = 'Asia/Shanghai';

/**
 * /internal/jobs 的只读数据装配（v4）。
 *
 * 任务定义来自 `job`，运行记录来自 `job_run`；v4 已删除候选表，候选列表恒为空。
 * 「下次执行」由 job.schedule 计算，停用即为空。
 */

/**
 * 管理页视图模型：保留旧页面的字段名以复用现有组件。
 * `type` 是 `kind` 的展示别名；v4 没有的字段（tier / target / limits 等）
 * 从 `config` 里取，取不到就给显式中性默认值，不伪造运行数据。
 */
export interface JobDefRow {
  id: string;
  code: string;
  type: string;
  tier: string;
  target: Record<string, unknown>;
  goal: string;
  adapter: string | null;
  outputSchema: unknown;
  mapping: Record<string, unknown>;
  schedule: unknown;
  limits: Record<string, unknown>;
  agent: unknown;
  policy: unknown;
  priority: number;
  enabled: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** v4 原生字段（旧测试 fixture 可不提供）。 */
  kind?: string;
  config?: unknown;
  lastRunAt?: Date | null;
}

export interface JobRunRow {
  id: string;
  jobCode: string;
  scheduledFor: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  status: string;
  attempt: number;
  workerId: string | null;
  tierUsed: string;
  costMs: number | null;
  costTokens: number;
  fetchedBytes: number | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  nextRetryAt: Date | null;
  createdAt: Date;
}

/** v4 已删除候选表；类型保留给管理页的空态分支。 */
export interface CandidateRow {
  id: string;
  jobRunId: string;
  kind: string;
  payload: unknown;
  schemaOk: boolean;
  dedupeKey: string;
  evidenceRef: unknown;
  status: string;
  rejectReason: string | null;
  validatorVersion: string;
  acceptedRowId: string | null;
  createdAt: Date;
}

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function scheduleOf(job: JobDefRow): {
  mode?: string;
  cron?: string;
  tz?: string;
  enabled?: boolean;
  windowStart?: string;
  windowEnd?: string;
} {
  return asRecord(job.schedule) as {
    mode?: string;
    cron?: string;
    tz?: string;
    enabled?: boolean;
    windowStart?: string;
    windowEnd?: string;
  };
}

function toJobDefRow(row: typeof v4.job.$inferSelect): JobDefRow {
  const config = asRecord(row.config);
  return {
    id: row.id,
    code: row.code,
    type: row.kind,
    tier: typeof config.tier === 'string' ? config.tier : '—',
    target: asRecord(config.target),
    goal: typeof config.goal === 'string' ? config.goal : '',
    adapter: stringOrNull(config.adapter),
    outputSchema: null,
    mapping: asRecord(config.mapping),
    schedule: row.schedule,
    limits: asRecord(config.limits),
    agent: config.agent ?? null,
    policy: config.policy ?? null,
    priority: numberOrNull(config.priority) ?? 5,
    enabled: row.enabled,
    notes: stringOrNull(config.notes),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    kind: row.kind,
    config: row.config,
    lastRunAt: row.lastRunAt,
  };
}

function toJobRunRow(run: typeof v4.jobRun.$inferSelect, jobCode: string): JobRunRow {
  const stats = asRecord(run.stats);
  const costMs =
    run.startedAt && run.finishedAt
      ? Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime())
      : null;
  return {
    id: run.id,
    jobCode,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    attempt: run.attempt,
    workerId: stringOrNull(stats.worker_id),
    tierUsed: typeof stats.tier_used === 'string' ? stats.tier_used : '—',
    costMs,
    costTokens: numberOrNull(stats.cost_tokens) ?? 0,
    fetchedBytes: numberOrNull(stats.fetched_bytes),
    httpStatus: numberOrNull(stats.http_status),
    errorCode: stringOrNull(stats.error_code),
    errorDetail: run.error,
    nextRetryAt: null,
    createdAt: run.createdAt,
  };
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
  void options.candidateLimit;

  const definitionRows = await db.select().from(v4.job).orderBy(v4.job.code);
  const runRows = await db
    .select({ run: v4.jobRun, jobCode: v4.job.code })
    .from(v4.jobRun)
    .innerJoin(v4.job, eq(v4.job.id, v4.jobRun.jobId))
    .orderBy(desc(v4.jobRun.startedAt), desc(v4.jobRun.createdAt))
    .limit(options.runLimit ?? 500);

  const definitions = definitionRows.map(toJobDefRow);
  const runs = runRows.map((row) => toJobRunRow(row.run, row.jobCode));

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
      todayFailed: todayRuns.filter((run) => run.status === 'failed').length,
    },
    jobs,
    runs,
    // v4 已删除候选表。
    candidates: [],
  };
}

export async function loadJobRuns(
  db: BeeDb,
  filters: { job?: string; status?: string; limit?: number },
): Promise<JobRunRow[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const conditions: ReturnType<typeof eq>[] = [];
  if (filters.job) conditions.push(eq(v4.job.code, filters.job));
  if (filters.status) conditions.push(eq(v4.jobRun.status, filters.status));

  const query = db
    .select({ run: v4.jobRun, jobCode: v4.job.code })
    .from(v4.jobRun)
    .innerJoin(v4.job, eq(v4.job.id, v4.jobRun.jobId));

  const rows = await (conditions.length > 0 ? query.where(and(...conditions)) : query)
    .orderBy(desc(v4.jobRun.startedAt), desc(v4.jobRun.createdAt))
    .limit(limit);

  return rows.map((row) => toJobRunRow(row.run, row.jobCode));
}

export async function loadCandidates(
  _db: BeeDb,
  _filters: { status?: string; limit?: number },
): Promise<CandidateRow[]> {
  // v4 已删除 ingest_candidate：worker 只写 price_daily / content。
  return [];
}