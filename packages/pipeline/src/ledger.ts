import { and, eq, sql } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import type { StepKind, StepRefs } from '@bee/core';

/**
 * 管线台账 helper（P0-3 的地基）：每个运行与每步的启停、输入输出引用都落 pipeline_run / pipeline_step。
 *
 * 台账纪律（迁移 0001 的触发器/唯一约束在 DB 层强制，本模块让违规在代码层先得到**可读的**错误）：
 *  - 状态机：pending → running → succeeded|failed|partial（step 多一个 skipped），终态冻结；
 *  - append-only：禁 DELETE/TRUNCATE；
 *  - run 幂等：idempotencyKey 落库（部分唯一索引 pipeline_run_idempotency_uq），
 *    pg-boss at-least-once 重投复用既有 run 而不是重复建；
 *  - step 幂等：(run_id, seq) 唯一，同 run 同 seq 重投复用既有 step；
 *  - stepVersion 落库 —— 按 step 版本回放的依据（@bee/core PipelineStep.version）。
 *
 * 用法（P0-3 实现管线时遵守）：
 *   const { run, reused } = await startRun(db, { kind: 'daily_collect', triggeredBy: 'schedule',
 *     pins, idempotencyKey: bossJobId });
 *   if (reused && run.status !== 'running') return;   // 重投的 run 已终态 → 直接跳过，不重复执行
 *   const { step, result } = await withStep(db,
 *     { runId: run.id, stepKind: 'fetch', seq: 1, stepVersion: fetchStep.version, inputRefs: { sourceId } },
 *     async (step, tx) => { …原子业务写，全部走 tx… });
 *   await finishRun(db, run.id, { status: 'succeeded' });
 *
 * withStep 的提交时序（刻意为之，别合并）：
 *   ① startStep 单独提交 —— 先登记再干活，业务炸了台账上也有这一步；
 *   ② 业务写在 db.transaction 里原子提交（fn 拿到的 tx 失败即整体回滚）；
 *   ③ 失败记录用根连接另起事务写 —— 业务事务已回滚，失败留痕不能被业务回滚吞掉。
 *   已知的崩溃窗口（可检测，交给 P0-3 的清扫任务）：
 *   ①后②前崩 = step 永远 running；②后③前崩 = 业务已提交但 step 仍 running。
 */
type TxCallback = Parameters<BeeDb['transaction']>[0];
/** drizzle 事务句柄（db.transaction 回调的第一个参数）。withStep 的 fn 在这里做原子业务写。 */
export type BeeTx = Parameters<TxCallback>[0];
/** 台账叶子 helper 既可在根连接上用，也可在业务事务内用。 */
export type BeeDbOrTx = BeeDb | BeeTx;

export type PipelineRunRow = typeof dbSchema.pipelineRun.$inferSelect;
export type PipelineStepRow = typeof dbSchema.pipelineStep.$inferSelect;
export type RawFetchRow = typeof dbSchema.rawFetch.$inferSelect;

/** 台账纪律错误的种类 —— 都是调用方 bug 或调度重复，必须显式处理，不允许静默吞掉。 */
export type LedgerErrorCode = 'not_found' | 'not_running' | 'already_terminal' | 'idempotency_conflict';

/** 台账纪律错误：状态机违规 / 终态冻结 / 记录不存在 / 幂等竞争异常。 */
export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: LedgerErrorCode,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface RunPins {
  gitSha: string;
  rulesVersion: string;
  dictionaryHash: string;
}

export async function startRun(
  db: BeeDb,
  args: {
    kind: (typeof dbSchema.pipelineRun.$inferInsert)['kind'];
    triggeredBy: string;
    configJson?: Record<string, unknown>;
    pins: RunPins;
    replayOfRunId?: string;
    /** 调度幂等键（如 pg-boss job id）。同键已有 run 则复用；调用方须检查 reused 与 run.status。 */
    idempotencyKey?: string;
  },
): Promise<{ run: PipelineRunRow; reused: boolean }> {
  const values = {
    kind: args.kind,
    triggeredBy: args.triggeredBy,
    configJson: args.configJson,
    gitSha: args.pins.gitSha,
    rulesVersion: args.pins.rulesVersion,
    dictionaryHash: args.pins.dictionaryHash,
    replayOfRunId: args.replayOfRunId,
    status: 'running' as const,
    startedAt: new Date(),
  };
  if (!args.idempotencyKey) {
    const [run] = await db.insert(dbSchema.pipelineRun).values(values).returning();
    return { run: run!, reused: false };
  }
  // 部分唯一索引 pipeline_run_idempotency_uq（WHERE idempotency_key IS NOT NULL）——
  // PG 的 ON CONFLICT 推断部分索引时冲突目标必须带同样的谓词（drizzle 的 where 即该谓词）。
  const [inserted] = await db
    .insert(dbSchema.pipelineRun)
    .values({ ...values, idempotencyKey: args.idempotencyKey })
    .onConflictDoNothing({
      target: dbSchema.pipelineRun.idempotencyKey,
      where: sql`${dbSchema.pipelineRun.idempotencyKey} IS NOT NULL`,
    })
    .returning();
  if (inserted) return { run: inserted, reused: false };
  const [existing] = await db
    .select()
    .from(dbSchema.pipelineRun)
    .where(eq(dbSchema.pipelineRun.idempotencyKey, args.idempotencyKey));
  if (!existing) {
    throw new LedgerError(
      `幂等键 ${args.idempotencyKey} 冲突后未找到既有 run —— 并发竞争窗口，请重试`,
      'idempotency_conflict',
    );
  }
  return { run: existing, reused: true };
}

export async function finishRun(
  db: BeeDbOrTx,
  runId: string,
  args: { status: 'succeeded' | 'failed' | 'partial'; error?: string },
): Promise<PipelineRunRow> {
  const [run] = await db
    .update(dbSchema.pipelineRun)
    .set({ status: args.status, error: args.error, finishedAt: new Date(), updatedAt: new Date() })
    // 只允许 running → 终态。WHERE 先过滤使双重 finish 在代码层拿到可读错误，
    // 而不是穿透到触发器的 P0001（触发器仍然是最后一道防线）。
    .where(and(eq(dbSchema.pipelineRun.id, runId), eq(dbSchema.pipelineRun.status, 'running')))
    .returning();
  if (run) return run;
  const [current] = await db.select().from(dbSchema.pipelineRun).where(eq(dbSchema.pipelineRun.id, runId));
  if (!current) throw new LedgerError(`run ${runId} 不存在`, 'not_found');
  throw new LedgerError(
    `run ${runId} 当前状态为 ${current.status}，不能 finish 为 ${args.status}` +
      `（状态机 pending→running→终态，终态冻结；DB 触发器强制同一规则）`,
    current.status === 'pending' ? 'not_running' : 'already_terminal',
  );
}

export async function startStep(
  db: BeeDbOrTx,
  args: { runId: string; stepKind: StepKind; seq: number; stepVersion?: string; inputRefs?: StepRefs },
): Promise<{ step: PipelineStepRow; reused: boolean }> {
  const [inserted] = await db
    .insert(dbSchema.pipelineStep)
    .values({
      runId: args.runId,
      stepKind: args.stepKind,
      seq: args.seq,
      stepVersion: args.stepVersion,
      inputRefs: args.inputRefs,
      status: 'running',
      startedAt: new Date(),
    })
    // (run_id, seq) 唯一 —— 并发 worker / at-least-once 重投不允许同 run 同 seq 重复建步。
    .onConflictDoNothing({ target: [dbSchema.pipelineStep.runId, dbSchema.pipelineStep.seq] })
    .returning();
  if (inserted) return { step: inserted, reused: false };
  const [existing] = await db
    .select()
    .from(dbSchema.pipelineStep)
    .where(and(eq(dbSchema.pipelineStep.runId, args.runId), eq(dbSchema.pipelineStep.seq, args.seq)));
  if (!existing) {
    throw new LedgerError(
      `step (${args.runId}, seq=${args.seq}) 冲突后未找到既有记录 —— 并发竞争窗口，请重试`,
      'idempotency_conflict',
    );
  }
  return { step: existing, reused: true };
}

export async function finishStep(
  db: BeeDbOrTx,
  stepId: string,
  args: { status: 'succeeded' | 'failed' | 'skipped'; outputRefs?: StepRefs; logExcerpt?: string; error?: string },
): Promise<PipelineStepRow> {
  const [step] = await db
    .update(dbSchema.pipelineStep)
    .set({
      status: args.status,
      outputRefs: args.outputRefs,
      logExcerpt: args.logExcerpt?.slice(0, 2000),
      error: args.error,
      finishedAt: new Date(),
    })
    // 只允许 running → 终态（含 skipped），理由同 finishRun。
    .where(and(eq(dbSchema.pipelineStep.id, stepId), eq(dbSchema.pipelineStep.status, 'running')))
    .returning();
  if (step) return step;
  const [current] = await db.select().from(dbSchema.pipelineStep).where(eq(dbSchema.pipelineStep.id, stepId));
  if (!current) throw new LedgerError(`step ${stepId} 不存在`, 'not_found');
  throw new LedgerError(
    `step ${stepId}（${current.stepKind} seq=${current.seq}）当前状态为 ${current.status}，` +
      `不能 finish 为 ${args.status}（状态机 pending→running→终态，终态冻结）`,
    current.status === 'pending' ? 'not_running' : 'already_terminal',
  );
}

/**
 * 一步的完整台账包裹：登记开步 → 业务原子写 → 记录结果。
 *
 * fn 拿到的是事务句柄 tx —— 在里面做该步的全部业务写，失败即整体回滚（不会留下半步产物）；
 * 无论成败，step 的终态记录都通过根连接落库，不受业务回滚影响。
 * fn 抛出的错误在失败留痕后**原样重抛**：由调用方（P0-3 的 run 编排）决定是中断 run 还是标记 partial。
 */
export async function withStep<T>(
  db: BeeDb,
  args: { runId: string; stepKind: StepKind; seq: number; stepVersion?: string; inputRefs?: StepRefs },
  fn: (step: PipelineStepRow, tx: BeeTx) => Promise<T>,
): Promise<{ step: PipelineStepRow; result: T }> {
  const { step } = await startStep(db, args); // 提交 ①：先登记再干活
  let result: T;
  try {
    result = await db.transaction((tx) => fn(step, tx)); // 提交 ②：业务原子写
  } catch (error) {
    // 提交 ③（失败分支）：业务已回滚，这里另起提交记录失败 —— 台账不缺痕。
    await finishStep(db, step.id, { status: 'failed', error: String(error) });
    throw error;
  }
  const finished = await finishStep(db, step.id, { status: 'succeeded' }); // 提交 ③（成功分支）
  return { step: finished, result };
}

/**
 * 归档登记（ADR-0004 · 内容寻址存储的库侧落点）：同一内容 sha 首次归档时
 * raw_content 落一行（content_ref 以首次为准 —— 同内容只存一份文件），之后每次抓取
 * 都新增一行 raw_fetch 指向它。顺序是硬约束：raw_fetch.content_sha256 外键指向
 * raw_content，先登记内容再登记抓取，反了就是 23503。
 *
 * 返回 contentExisted 告诉调用方：false = 该写文件到 RAW_STORE_DIR；true = 文件已在，跳过写入。
 */
export async function registerRawFetch(
  db: BeeDb,
  args: {
    sourceId: string;
    runId?: string;
    url: string;
    fetchedAt: Date;
    httpStatus: number;
    contentSha256: string;
    contentRef: string;
    contentType?: string;
    contentSizeBytes?: number;
    pagePublishedAt?: Date;
    fetchMeta?: Record<string, unknown>;
  },
): Promise<{ fetch: RawFetchRow; contentExisted: boolean }> {
  return db.transaction(async (tx) => {
    const [content] = await tx
      .insert(dbSchema.rawContent)
      .values({ contentSha256: args.contentSha256, contentRef: args.contentRef })
      // 已有内容 = 首次归档的 content_ref 作数（内容寻址：同 sha 同文件）。
      .onConflictDoNothing({ target: dbSchema.rawContent.contentSha256 })
      .returning();
    const [fetch] = await tx
      .insert(dbSchema.rawFetch)
      .values({
        sourceId: args.sourceId,
        runId: args.runId,
        url: args.url,
        fetchedAt: args.fetchedAt,
        httpStatus: args.httpStatus,
        contentSha256: args.contentSha256,
        contentType: args.contentType,
        contentSizeBytes: args.contentSizeBytes,
        pagePublishedAt: args.pagePublishedAt,
        fetchMeta: args.fetchMeta,
      })
      .returning();
    return { fetch: fetch!, contentExisted: !content };
  });
}
