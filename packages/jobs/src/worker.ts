import { and, eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { executeFetchTable } from './processors/fetch-table';
import type { WorkerOptions } from './types';

/**
 * 单次执行：领任务 → 执行 → 写 job_run。可由 pg-boss worker 调用，也可手动触发/测试直接调用。
 *
 * 幂等：job_run 唯一键 (job_code, scheduled_for)。同一个 cron 窗口重复投递只会认领一次；
 * 手动触发 scheduled_for 为空，允许同任务多次（数据层再用 ingest_candidate.dedupe_key 去重）。
 *
 * 红线：本模块只写 job_run / 读 job_def、source_policy；业务表一律经 HTTP ingest。
 */

export interface RunJobResult {
  run: typeof dbSchema.jobRun.$inferSelect;
  /** false = 同一时间窗已有台账或被其他 worker 认领，本次未执行。 */
  executed: boolean;
  log: string[];
}

function logLine(message: string): void {
  // 不打印 token / 连接串；只打印步骤与计数。
  console.log(message);
}

async function claimRun(
  db: BeeDb,
  args: {
    jobCode: string;
    scheduledFor: Date | null;
    workerId: string;
    tier: string;
  },
): Promise<{ run: typeof dbSchema.jobRun.$inferSelect; claimed: boolean }> {
  const [inserted] = await db
    .insert(dbSchema.jobRun)
    .values({
      jobCode: args.jobCode,
      scheduledFor: args.scheduledFor,
      status: 'queued',
      attempt: 1,
      workerId: args.workerId,
      tierUsed: args.tier,
    })
    .onConflictDoNothing({
      target: [dbSchema.jobRun.jobCode, dbSchema.jobRun.scheduledFor],
    })
    .returning();

  const candidate =
    inserted ??
    (
      await db
        .select()
        .from(dbSchema.jobRun)
        .where(
          and(
            eq(dbSchema.jobRun.jobCode, args.jobCode),
            args.scheduledFor
              ? eq(dbSchema.jobRun.scheduledFor, args.scheduledFor)
              : // NULL 的等值比较不成立；手动触发的唯一性不靠 (code, null) 去重。
                eq(dbSchema.jobRun.id, '00000000-0000-0000-0000-000000000000'),
          ),
        )
        .limit(1)
    )[0];

  if (!candidate) {
    // 手动触发：INSERT 必然成功（NULL 不参与唯一冲突），走到这里说明有异常。
    throw new Error(`无法登记 job_run：${args.jobCode}`);
  }
  if (!inserted && candidate.status !== 'queued') {
    return { run: candidate, claimed: false };
  }
  const [claimed] = await db
    .update(dbSchema.jobRun)
    .set({ status: 'running', startedAt: new Date(), workerId: args.workerId })
    .where(and(eq(dbSchema.jobRun.id, candidate.id), eq(dbSchema.jobRun.status, 'queued')))
    .returning();
  return claimed ? { run: claimed, claimed: true } : { run: candidate, claimed: false };
}

export async function runJobOnce(options: WorkerOptions): Promise<RunJobResult> {
  const db = options.db;
  const [job] = await db
    .select()
    .from(dbSchema.jobDef)
    .where(eq(dbSchema.jobDef.code, options.jobCode))
    .limit(1);
  if (!job) throw new Error(`job_def 不存在：${options.jobCode}`);

  const workerId = options.workerId ?? `worker-${process.pid}`;
  const scheduledFor = options.scheduledFor ?? null;
  const { run, claimed } = await claimRun(db, {
    jobCode: job.code,
    scheduledFor,
    workerId,
    tier: job.tier,
  });
  if (!claimed) {
    return { run, executed: false, log: [`skip: job_run ${run.id} 状态 ${run.status}（幂等或他人在跑）`] };
  }

  const startedAt = Date.now();
  const log = [`[job:${job.code}] run=${run.id} start tier=${job.tier}`];
  if (job.type !== 'fetch_table') {
    const [finished] = await db
      .update(dbSchema.jobRun)
      .set({
        status: 'skipped',
        finishedAt: new Date(),
        costMs: Date.now() - startedAt,
        errorCode: 'unsupported_type',
        errorDetail: `P0 只实现 fetch_table，收到 ${job.type}`,
      })
      .where(eq(dbSchema.jobRun.id, run.id))
      .returning();
    return { run: finished!, executed: true, log };
  }

  try {
    const limits = job.limits as { timeout_s?: number };
    const timeoutMs = (options.timeoutSeconds ?? limits.timeout_s ?? 120) * 1000;
    const outcome = await executeFetchTable({
      db,
      jobCode: job.code,
      runId: run.id,
      job,
      ingestUrl: options.ingestUrl,
      ingestToken: options.ingestToken,
      storeRoot: options.storeRoot,
      timeoutMs,
      allowJump: options.allowJump,
      fetchImpl: options.fetchImpl,
      ingest: options.ingest,
      now: options.now,
    });
    log.push(...outcome.log.map((line) => `[job:${job.code}] ${line}`));
    const [finished] = await db
      .update(dbSchema.jobRun)
      .set({
        status: outcome.status,
        finishedAt: new Date(),
        costMs: Date.now() - startedAt,
        tierUsed: job.tier,
        httpStatus: outcome.httpStatus ?? null,
        fetchedBytes: outcome.fetchedBytes ?? null,
        rawFetchId: outcome.rawFetchId ?? null,
        errorCode: outcome.errorCode ?? null,
        errorDetail: outcome.errorDetail ?? null,
      })
      .where(eq(dbSchema.jobRun.id, run.id))
      .returning();
    log.push(
      `[job:${job.code}] run=${run.id} done status=${outcome.status} accepted=${outcome.accepted} rejected=${outcome.rejected}`,
    );
    for (const line of log) logLine(line);
    return { run: finished!, executed: true, log };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const [failed] = await db
      .update(dbSchema.jobRun)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        costMs: Date.now() - startedAt,
        errorCode: 'internal_error',
        errorDetail: message.slice(0, 4000),
      })
      .where(eq(dbSchema.jobRun.id, run.id))
      .returning();
    log.push(`[job:${job.code}] run=${run.id} failed ${message}`);
    for (const line of log) logLine(line);
    return { run: failed!, executed: true, log };
  }
}