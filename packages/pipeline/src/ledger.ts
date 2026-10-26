import { and, eq, sql } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import type { StepKind, StepRefs } from '@bee/core';

/**
 * 管线台账 helper（P0-3 的地基）：每个运行与每步的启停、输入输出引用都落 pipeline_run / pipeline_step。
 *
 * 台账纪律（迁移 0001 的触发器/唯一约束 + 0002 的 INSERT 状态机守卫在 DB 层强制，
 * 本模块让违规在代码层先得到**可读的**错误）：
 *  - 状态机：pending → running → succeeded|failed|partial（step 多一个 skipped），终态冻结；
 *    0002 起 run/step 只能以 pending 落库 —— 裸 INSERT 直接写 succeeded/failed 在 DB 层即被拒；
 *  - append-only：禁 DELETE/TRUNCATE；
 *  - run 幂等：idempotencyKey 落库（部分唯一索引 pipeline_run_idempotency_uq），
 *    pg-boss at-least-once 重投复用既有 run 而不是重复建；
 *  - step 幂等：(run_id, seq) 唯一，同 run 同 seq 重投复用既有 step；
 *    复用时必须同 stepKind 同 stepVersion —— 换实现 = 换 seq 或升 stepVersion，否则 idempotency_conflict；
 *  - stepVersion 落库 —— 按 step 版本回放的依据（@bee/core PipelineStep.version）。
 *
 * 执行所有权（DAW-35 B1/B2 修复）：startRun/startStep 返回两个**独立**判别 ——
 *  - `reused`：记录是否复用既有行（false = 本次新建），只描述台账行从哪来；
 *  - `claimed`：本调用是否完成 pending→running 认领，即**业务能不能由本次调用执行**。
 *    认领是守护式 UPDATE（WHERE status='pending'），并发只有一个赢家；认领落空 =
 *    所有权在别的 worker 手里，本调用必须拒绝执行业务，而不是以「新建者」身份放行。
 *
 * 用法（P0-3 实现管线时遵守）：
 *   const { run, claimed } = await startRun(db, { kind: 'daily_collect', triggeredBy: 'schedule',
 *     pins, idempotencyKey: bossJobId });
 *   if (!claimed) return;                      // 所有权不在本 worker（他人执行中 / 已终态）—— 不编排
 *   const outcome = await withStep(db,
 *     { runId: run.id, stepKind: 'fetch', seq: 1, stepVersion: fetchStep.version, inputRefs: { sourceId } },
 *     async (step, tx) => { …原子业务写，全部走 tx… });
 *   if (outcome.replayed) return outcome.step;        // 重投命中已完成步 → 幂等重放，业务绝不重复执行
 *   const result = outcome.result;
 *   await finishRun(db, run.id, { status: 'succeeded' });
 *
 * withStep 的提交时序（刻意为之，别合并）：
 *   ① startStep 单独提交 —— 先登记（并认领）再干活，业务炸了台账上也有这一步；
 *   ② 业务写在 db.transaction 里原子提交（fn 拿到的 tx 失败即整体回滚）；
 *   ③ 失败记录用根连接另起事务写 —— 业务事务已回滚，失败留痕不能被业务回滚吞掉。
 *   崩溃窗口与可恢复性（重投到达时 startStep 会裁决）：
 *   - ①登记提交后、认领前崩 → step 停在 pending → 重投**自愈认领继续执行**（业务从未开始过，
 *     认领是业务的闸门，claimed=true 是安全的）；
 *   - ①认领后、②前崩 → step 永远 running → 重投命中 in_flight（业务可能执行到一半，
 *     重复执行 = 双写，交清扫任务裁决：补记终态或整 run 重放）；
 *   - ②后③前崩 → 业务已提交但 step 仍 running → 同上，in_flight 交清扫裁决。
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
export type LedgerErrorCode =
  | 'not_found'
  | 'not_running'
  | 'already_terminal'
  | 'idempotency_conflict'
  | 'in_flight';

/** 台账纪律错误：状态机违规 / 终态冻结 / 记录不存在 / 幂等竞争异常 / 重投命中在途步。 */
export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: LedgerErrorCode,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * withStep 的结果（DAW-34 评审修复）：判别联合 —— 重放时业务不执行，result 不存在。
 * 调用方必须先看 replayed：true = 该步此前已完成（幂等重放，fn 一次都没跑），
 * 只有 false 才有 result。
 */
export type WithStepOutcome<T> =
  | { step: PipelineStepRow; replayed: true; result?: undefined }
  | { step: PipelineStepRow; replayed: false; result: T };

/**
 * startRun 的结果（DAW-35 B1/B2 修复）：两个**独立**判别，见文件头「执行所有权」。
 *  - `reused`：台账行是否复用既有记录（false = 本次新建）；
 *  - `claimed`：本调用是否拿到 pending→running 认领 = **本次执行所有权**。
 *    false = 所有权不在本 worker（他人已认领在途 / 已终态 / 认领竞争失败）——
 *    调用方不得编排执行，只能按 run.status 决定跳过还是等清扫。
 *    「reused:false + claimed:false」是合法组合：行是我建的，认领却被并发 worker 抢走。
 */
export type StartRunOutcome = { run: PipelineRunRow; reused: boolean; claimed: boolean };

/** startStep 的结果，判别语义与 StartRunOutcome 相同（step 层）。 */
export type StartStepOutcome = { step: PipelineStepRow; reused: boolean; claimed: boolean };

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
    /** 调度幂等键（如 pg-boss job id）。同键已有 run 则复用；调用方须检查 claimed 决定是否执行。 */
    idempotencyKey?: string;
  },
): Promise<StartRunOutcome> {
  // 状态机从 pending 起步（0002 起 DB 层强制 run 只能以 pending 落库）：
  // 先登记再认领 —— pending→running 的认领是守护式 UPDATE，竞争失败即拿到可读的现场。
  const values = {
    kind: args.kind,
    triggeredBy: args.triggeredBy,
    configJson: args.configJson,
    gitSha: args.pins.gitSha,
    rulesVersion: args.pins.rulesVersion,
    dictionaryHash: args.pins.dictionaryHash,
    replayOfRunId: args.replayOfRunId,
    status: 'pending' as const,
  };
  /** pending → running 的认领。返回 null = 认领窗口被并发抢占，调用方重读现场。 */
  const claim = async (runId: string): Promise<PipelineRunRow | null> => {
    const [claimed] = await db
      .update(dbSchema.pipelineRun)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(dbSchema.pipelineRun.id, runId), eq(dbSchema.pipelineRun.status, 'pending')))
      .returning();
    return claimed ?? null;
  };
  /**
   * 认领落空后的重读（DAW-35 B2）：并发 worker 在「我方 INSERT 提交后、认领发出前」抢走了
   * pending→running —— 行不再是我的执行权。重读交还现场，claimed:false 告诉调用方不得编排执行。
   */
  const lostRace = async (runId: string): Promise<PipelineRunRow> => {
    const [fresh] = await db.select().from(dbSchema.pipelineRun).where(eq(dbSchema.pipelineRun.id, runId));
    return fresh!;
  };
  if (!args.idempotencyKey) {
    const [pending] = await db.insert(dbSchema.pipelineRun).values(values).returning();
    const claimed = await claim(pending!.id);
    return claimed
      ? { run: claimed, reused: false, claimed: true }
      : { run: await lostRace(pending!.id), reused: false, claimed: false };
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
  if (inserted) {
    const claimed = await claim(inserted.id);
    return claimed
      ? { run: claimed, reused: false, claimed: true }
      : { run: await lostRace(inserted.id), reused: false, claimed: false };
  }
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
  // 重投命中 pending（上次登记后、认领前崩溃）→ 自愈认领（DAW-35 B1：认领成功 = 所有权在手，
  // reused 只标记记录复用，不再吞掉执行权）；认领竞争失败则重读现场、claimed:false。
  if (existing.status === 'pending') {
    const claimed = await claim(existing.id);
    return claimed
      ? { run: claimed, reused: true, claimed: true }
      : { run: await lostRace(existing.id), reused: true, claimed: false };
  }
  // 既有 running / 终态：所有权在别处 —— 原样返回，调用方按 run.status 裁决。
  return { run: existing, reused: true, claimed: false };
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
): Promise<StartStepOutcome> {
  // 与 startRun 同理：只能以 pending 落库（0002 起 DB 层强制），再守护式认领 pending→running。
  const [inserted] = await db
    .insert(dbSchema.pipelineStep)
    .values({
      runId: args.runId,
      stepKind: args.stepKind,
      seq: args.seq,
      stepVersion: args.stepVersion,
      inputRefs: args.inputRefs,
      status: 'pending',
    })
    // (run_id, seq) 唯一 —— 并发 worker / at-least-once 重投不允许同 run 同 seq 重复建步。
    .onConflictDoNothing({ target: [dbSchema.pipelineStep.runId, dbSchema.pipelineStep.seq] })
    .returning();
  if (inserted) {
    const [claimed] = await db
      .update(dbSchema.pipelineStep)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(dbSchema.pipelineStep.id, inserted.id), eq(dbSchema.pipelineStep.status, 'pending')))
      .returning();
    // DAW-35 B2：认领落空 = 并发 worker 在我方 INSERT 提交后抢走了这一步 —— 不得以
    // 「新建者」身份继续执行业务。重读现场（running）交还裁决权，claimed:false。
    if (claimed) return { step: claimed, reused: false, claimed: true };
    const [fresh] = await db
      .select()
      .from(dbSchema.pipelineStep)
      .where(eq(dbSchema.pipelineStep.id, inserted.id));
    return { step: fresh!, reused: false, claimed: false };
  }
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
  // 复用必须同实现：同 (run_id, seq) 上换了 stepKind 或 stepVersion，不是幂等重投，
  // 是换实现 —— 换 seq 或升 stepVersion，这里直接冲突掉（DAW-34 修复：不能静默复用后
  // 让新版实现的业务写挂在旧版 step 的台账上）。
  if (existing.stepKind !== args.stepKind || (args.stepVersion ?? null) !== existing.stepVersion) {
    throw new LedgerError(
      `step (${args.runId}, seq=${args.seq}) 已按 ${existing.stepKind}@${existing.stepVersion ?? '∅'} 登记，` +
        `重投携带 ${args.stepKind}@${args.stepVersion ?? '∅'} —— 幂等键只认同一实现；` +
        `换实现 = 换 seq 或升 stepVersion`,
      'idempotency_conflict',
    );
  }
  // 命中 pending（登记后、认领前崩溃）→ 自愈认领（DAW-35 B1：认领成功 = 所有权在手，
  // 业务从未开始过 —— 认领是业务的闸门）；认领竞争失败则重读现场、claimed:false。
  if (existing.status === 'pending') {
    const [claimed] = await db
      .update(dbSchema.pipelineStep)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(dbSchema.pipelineStep.id, existing.id), eq(dbSchema.pipelineStep.status, 'pending')))
      .returning();
    if (claimed) return { step: claimed, reused: true, claimed: true };
    const [fresh] = await db
      .select()
      .from(dbSchema.pipelineStep)
      .where(eq(dbSchema.pipelineStep.id, existing.id));
    return { step: fresh!, reused: true, claimed: false };
  }
  // 既有 running / 终态：所有权在别处 —— 原样返回，由 withStep 按状态裁决。
  return { step: existing, reused: true, claimed: false };
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
 *
 * 重投语义（DAW-34 评审修复 + DAW-35 B1/B2）：**执行所有权只由 claimed 决定**，
 * reused 只描述记录复用，绝不从它推断执行权（那正是 B1「pending 自愈误判在途」与
 * B2「认领失手仍放行业务」的病根）：
 *  - claimed=false 且 succeeded → 返回 replayed:true，fn **一次都不会执行**（幂等重放）；
 *  - claimed=false 且 running → 抛 in_flight —— 崩溃窗口或真并发（含认领被并发 worker
 *    抢走），业务可能正在别处执行，重复执行 = 双写风险，交给清扫任务裁决；
 *  - claimed=false 且 failed / skipped → 抛 already_terminal，fn 不执行 —— 该步已死，
 *    重跑必须换 seq 走新步，或在重放 run 里重算；
 *  - claimed=true（含 pending 自愈认领）→ 本 worker 是唯一执行者，fn 正常执行。
 */
export async function withStep<T>(
  db: BeeDb,
  args: {
    runId: string;
    stepKind: StepKind;
    seq: number;
    stepVersion?: string;
    inputRefs?: StepRefs;
    /** 成功后把业务结果映射为台账 output_refs（只存 id / 内容寻址引用，不内联大对象）。 */
    outputRefs?: (result: T) => StepRefs;
  },
  fn: (step: PipelineStepRow, tx: BeeTx) => Promise<T>,
): Promise<WithStepOutcome<T>> {
  const { step, claimed } = await startStep(db, args); // 提交 ①：先登记（认领）再干活
  if (!claimed) {
    if (step.status === 'succeeded') return { step, replayed: true };
    if (step.status === 'running') {
      throw new LedgerError(
        `step (${args.runId}, seq=${args.seq}) 正在执行中 —— at-least-once 重投命中在途步` +
          `（或认领被并发 worker 抢走），业务可能正在别处执行，重复执行即双写风险；` +
          `等其终态或交清扫任务裁决`,
        'in_flight',
      );
    }
    if (step.status === 'pending') {
      // 理论撕裂窗口：认领 UPDATE 落空、重读却仍 pending —— 保守拒绝，绝不执行。
      throw new LedgerError(
        `step (${args.runId}, seq=${args.seq}) 认领竞争失败且现场异常（仍 pending）—— 保守拒绝执行，请重试`,
        'in_flight',
      );
    }
    throw new LedgerError(
      `step (${args.runId}, seq=${args.seq}) 当前状态为 ${step.status} —— 该步已有终局，` +
        `重跑必须换 seq 或在重放 run 里重算，不能在既有 step 上续写`,
      'already_terminal',
    );
  }
  let result: T;
  try {
    result = await db.transaction((tx) => fn(step, tx)); // 提交 ②：业务原子写
  } catch (error) {
    // 提交 ③（失败分支）：业务已回滚，这里另起提交记录失败 —— 台账不缺痕。
    await finishStep(db, step.id, { status: 'failed', error: String(error) });
    throw error;
  }
  const finished = await finishStep(db, step.id, {
    status: 'succeeded',
    outputRefs: args.outputRefs?.(result),
  }); // 提交 ③（成功分支）
  return { step: finished, replayed: false, result };
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
