/**
 * 台账 helper 集成测试（DAW-33 评审修复的代码层配套；DAW-34 复审补重投语义）。
 *
 * DB 层的触发器/唯一约束（状态机、终态冻结、append-only、幂等索引、INSERT 只许 pending）
 * 已在 packages/db/tests/schema.integration.test.ts 的 M 组锁死 —— 这里锁 helper 本身的行为：
 *  - startRun/startStep：pending 落库 + 守护式认领（DB 触发器前的可读错误层）；
 *  - startRun 幂等复用（reused 标志）、stepVersion 落库（回放依据）；
 *  - startStep 复用必须同 stepKind 同 stepVersion —— 换实现 = idempotency_conflict；
 *  - 守护式 finish：双重 finish / pending 越级 / 不存在 → 带 code 的可读 LedgerError；
 *  - withStep 重投语义（DAW-34 核心断言）：succeeded → replayed 且 fn 不执行；
 *    running → in_flight 且 fn 不执行；failed/skipped → already_terminal 且 fn 不执行；
 *  - withStep 的事务时序：业务写原子、失败回滚但失败留痕、错误原样重抛；
 *  - registerRawFetch：内容先行、同内容首见 content_ref 作数、抓取登记天然可重复。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, dbSchema } from '@bee/db';
import { finishRun, finishStep, registerRawFetch, startRun, startStep, withStep } from '../src';

const TEST_URL = process.env.BEE_TEST_DATABASE_URL ?? '';
const db = createDb(TEST_URL);

describe.skipIf(!TEST_URL)('ledger 台账 helper', () => {
  const pins = { gitSha: 'deadbeef', rulesVersion: 'rules@1', dictionaryHash: 'd'.repeat(64) };
  const unique = (tag: string) => `ledger-${tag}-${Date.now()}-${randomUUID().slice(0, 8)}`;

  async function newRun() {
    return startRun(db, { kind: 'daily_collect', triggeredBy: 'test', pins });
  }

  it('startRun → withStep → finishRun 全链路：pending 落库后认领 running、stepVersion 落库、业务写在 tx 里原子提交', async () => {
    const { run } = await newRun();
    // 0002 起 run/step 只能以 pending 落库；startRun 内部完成 pending→running 的认领。
    expect(run.status).toBe('running');
    expect(run.startedAt).toBeTruthy();
    let fnCalls = 0;
    const outcome = await withStep(
      db,
      { runId: run.id, stepKind: 'fetch', seq: 1, stepVersion: '1.0.0', inputRefs: { sourceId: 'src-x' } },
      async (step, tx) => {
        fnCalls += 1;
        // 业务写走 tx；agent_invocation 的复合外键 (run_id, step_id) 同时被顺带验证：
        // step 属于该 run，插入必须成功。
        const [row] = await tx
          .insert(dbSchema.agentInvocation)
          .values({
            runId: step.runId,
            stepId: step.id,
            purpose: 'validation_judgment',
            model: 'test-model',
            promptVersion: 'v1',
            inputJson: {},
            outputJson: { verdict: 'pass' },
          })
          .returning();
        return row!.id;
      },
    );
    expect(outcome.replayed).toBe(false);
    expect(outcome.step.status).toBe('succeeded');
    expect(outcome.step.stepVersion).toBe('1.0.0');
    expect(outcome.result).toBeTruthy();
    expect(fnCalls).toBe(1);

    const finished = await finishRun(db, run.id, { status: 'succeeded' });
    expect(finished.status).toBe('succeeded');
    expect(finished.finishedAt).toBeTruthy();
  });

  it('withStep 业务失败：业务写整体回滚、step 失败留痕、原错误重抛、run 可继续收尾', async () => {
    const { run } = await newRun();
    const boom = new Error('适配器超时');
    await expect(
      withStep(db, { runId: run.id, stepKind: 'fetch', seq: 2, stepVersion: '1.0.0' }, async (step, tx) => {
        await tx.insert(dbSchema.agentInvocation).values({
          runId: step.runId,
          stepId: step.id,
          purpose: 'narrative_draft',
          model: 'test-model',
          promptVersion: 'v1',
          inputJson: {},
          outputJson: {},
        });
        throw boom;
      }),
    ).rejects.toThrow('适配器超时');

    const [stepRow] = await db
      .select()
      .from(dbSchema.pipelineStep)
      .where(eq(dbSchema.pipelineStep.runId, run.id));
    expect(stepRow?.status).toBe('failed');
    expect(stepRow?.error).toContain('适配器超时');
    // 业务事务已回滚 —— 失败步里的调用留痕不存在。
    const [inv] = await db
      .select()
      .from(dbSchema.agentInvocation)
      .where(eq(dbSchema.agentInvocation.stepId, stepRow!.id));
    expect(inv).toBeUndefined();

    // run 未被连带终结，编排层可按 partial 收尾。
    const finished = await finishRun(db, run.id, { status: 'partial', error: 'fetch 步失败' });
    expect(finished.status).toBe('partial');
  });

  it('startRun 幂等：同 idempotencyKey 复用既有 run；无键各自独立', async () => {
    const key = unique('idem');
    const first = await startRun(db, { kind: 'daily_collect', triggeredBy: 'schedule', pins, idempotencyKey: key });
    expect(first.reused).toBe(false);
    // pg-boss at-least-once 重投：同键再来一次 → 复用，不重复建 run。
    const second = await startRun(db, { kind: 'daily_collect', triggeredBy: 'schedule', pins, idempotencyKey: key });
    expect(second.reused).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    // 无键的 run 不受部分唯一索引约束，各自独立。
    const a = await newRun();
    const b = await newRun();
    expect(a.run.id).not.toBe(b.run.id);
    await finishRun(db, first.run.id, { status: 'succeeded' });
  });

  it('startStep 幂等：(run_id, seq) 冲突时同实现才复用；不同 stepKind/stepVersion = idempotency_conflict', async () => {
    const { run } = await newRun();
    const s1 = await startStep(db, { runId: run.id, stepKind: 'extract', seq: 1, stepVersion: '2.0.0' });
    expect(s1.reused).toBe(false);
    expect(s1.step.status).toBe('running'); // pending 落库后认领
    // 同实现重投：复用既有 step（在途，status 仍是 running）。
    const s1again = await startStep(db, { runId: run.id, stepKind: 'extract', seq: 1, stepVersion: '2.0.0' });
    expect(s1again.reused).toBe(true);
    expect(s1again.step.id).toBe(s1.step.id);
    // 换 stepVersion：同 (run_id, seq) 上不是同一实现 —— 冲突，不静默复用
    //（否则新版实现的业务写挂在旧版 step 的台账上，stepVersion 回放依据失效）。
    await expect(
      startStep(db, { runId: run.id, stepKind: 'extract', seq: 1, stepVersion: '3.0.0' }),
    ).rejects.toMatchObject({ name: 'LedgerError', code: 'idempotency_conflict' });
    await expect(
      startStep(db, { runId: run.id, stepKind: 'normalize', seq: 1, stepVersion: '2.0.0' }),
    ).rejects.toMatchObject({ name: 'LedgerError', code: 'idempotency_conflict' });
    const s2 = await startStep(db, { runId: run.id, stepKind: 'normalize', seq: 2 });
    expect(s2.reused).toBe(false);
    expect(s2.step.seq).toBe(2);
    await finishRun(db, run.id, { status: 'succeeded' });
  });

  it('withStep 重投命中 succeeded 步：replayed=true，业务 fn 一次都不执行（幂等重放）', async () => {
    const { run } = await newRun();
    let fnCalls = 0;
    const args = { runId: run.id, stepKind: 'extract', seq: 1, stepVersion: '1.0.0' } as const;
    const first = await withStep(db, args, async () => {
      fnCalls += 1;
      return '业务产物';
    });
    expect(first.replayed).toBe(false);
    expect(first.result).toBe('业务产物');
    // at-least-once 重投：fn 已成功过的步，再来一次 → 重放，绝不重复执行业务（双写防线）。
    const retry = await withStep(db, args, async () => {
      fnCalls += 1;
      return '不该出现的第二次产物';
    });
    expect(retry.replayed).toBe(true);
    expect(retry.result).toBeUndefined();
    expect(retry.step.status).toBe('succeeded');
    expect(fnCalls).toBe(1);
    await finishRun(db, run.id, { status: 'succeeded' });
  });

  it('withStep 重投命中 running 步：in_flight，业务 fn 不执行（崩溃窗口 / 真并发交给清扫裁决）', async () => {
    const { run } = await newRun();
    // 预置一个在途步：登记后认领、但业务尚未收尾 —— 模拟「①后②前崩」的现场。
    const pre = await startStep(db, { runId: run.id, stepKind: 'extract', seq: 1, stepVersion: '1.0.0' });
    expect(pre.step.status).toBe('running');
    let fnCalls = 0;
    await expect(
      withStep(db, { runId: run.id, stepKind: 'extract', seq: 1, stepVersion: '1.0.0' }, async () => {
        fnCalls += 1;
      }),
    ).rejects.toMatchObject({ name: 'LedgerError', code: 'in_flight' });
    expect(fnCalls).toBe(0);
    await finishRun(db, run.id, { status: 'failed', error: 'step 在途崩溃' });
  });

  it('withStep 重投命中 failed / skipped 步：already_terminal，业务 fn 不执行', async () => {
    // failed：第一步业务抛错（fn 执行 1 次后失败留痕），重投 → already_terminal，fn 不再执行。
    const { run: runFail } = await newRun();
    let fnCalls = 0;
    await expect(
      withStep(db, { runId: runFail.id, stepKind: 'extract', seq: 1, stepVersion: '1.0.0' }, async () => {
        fnCalls += 1;
        throw new Error('抽取失败');
      }),
    ).rejects.toThrow('抽取失败');
    expect(fnCalls).toBe(1);
    await expect(
      withStep(db, { runId: runFail.id, stepKind: 'extract', seq: 1, stepVersion: '1.0.0' }, async () => {
        fnCalls += 1;
      }),
    ).rejects.toMatchObject({ name: 'LedgerError', code: 'already_terminal' });
    expect(fnCalls).toBe(1); // 失败步重投：业务不重复执行
    await finishRun(db, runFail.id, { status: 'failed', error: 'extract 失败' });

    // skipped：显式跳过的步，重投 → already_terminal（重跑须换 seq）。
    const { run: runSkip } = await newRun();
    const skipped = await startStep(db, { runId: runSkip.id, stepKind: 'extract', seq: 1, stepVersion: '1.0.0' });
    await finishStep(db, skipped.step.id, { status: 'skipped' });
    await expect(
      withStep(db, { runId: runSkip.id, stepKind: 'extract', seq: 1, stepVersion: '1.0.0' }, async () => {
        fnCalls += 1;
      }),
    ).rejects.toMatchObject({ name: 'LedgerError', code: 'already_terminal' });
    expect(fnCalls).toBe(1);
    await finishRun(db, runSkip.id, { status: 'succeeded' });
  });

  it('守护式 finish：双重 finish / pending 越级 / 不存在 → 带 code 的 LedgerError', async () => {
    const { run } = await newRun();
    await finishRun(db, run.id, { status: 'failed', error: 'x' });
    await expect(finishRun(db, run.id, { status: 'succeeded' })).rejects.toMatchObject({
      name: 'LedgerError',
      code: 'already_terminal',
    });
    await expect(finishRun(db, randomUUID(), { status: 'succeeded' })).rejects.toMatchObject({
      code: 'not_found',
    });
    // pending 的 run 不能直接 finish —— 状态机必须先走 running（这里用裸 insert 造 pending 态）。
    const [pending] = await db
      .insert(dbSchema.pipelineRun)
      .values({ kind: 'validate', triggeredBy: 'test', status: 'pending' })
      .returning();
    await expect(finishRun(db, pending!.id, { status: 'succeeded' })).rejects.toMatchObject({
      code: 'not_running',
    });

    // step 同理。
    const { run: r2 } = await newRun();
    const { step } = await startStep(db, { runId: r2.id, stepKind: 'fetch', seq: 1 });
    await finishStep(db, step.id, { status: 'skipped' });
    await expect(finishStep(db, step.id, { status: 'succeeded' })).rejects.toMatchObject({
      code: 'already_terminal',
    });
    await expect(finishStep(db, randomUUID(), { status: 'succeeded' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('registerRawFetch：内容先行、首见 content_ref 作数、同内容多次抓取各自登记', async () => {
    const [src] = await db
      .insert(dbSchema.source)
      .values({ code: unique('src'), name: '台账测试来源', type: 'webpage', baseUrl: 'https://example.com' })
      .returning();
    const sha = randomUUID().replace(/-/g, '').padEnd(64, '0');
    const firstRef = `raw/2026/10/26/${sha}.bin`;

    const r1 = await registerRawFetch(db, {
      sourceId: src!.id,
      url: 'https://example.com/a',
      fetchedAt: new Date(),
      httpStatus: 200,
      contentSha256: sha,
      contentRef: firstRef,
      contentType: 'text/html',
      contentSizeBytes: 42,
    });
    expect(r1.contentExisted).toBe(false);

    // 同内容第二次抓取（不同 URL）：内容已存在，contentExisted=true 提示调用方跳过写文件；
    // 传入的第二个 contentRef 不作数 —— 内容寻址：首见作数。
    const r2 = await registerRawFetch(db, {
      sourceId: src!.id,
      url: 'https://example.com/b',
      fetchedAt: new Date(),
      httpStatus: 200,
      contentSha256: sha,
      contentRef: `raw/2026/10/27/${sha}.bin`,
    });
    expect(r2.contentExisted).toBe(true);
    expect(r2.fetch.id).not.toBe(r1.fetch.id);

    const [content] = await db
      .select()
      .from(dbSchema.rawContent)
      .where(eq(dbSchema.rawContent.contentSha256, sha));
    expect(content?.contentRef).toBe(firstRef);

    const fetches = await db
      .select()
      .from(dbSchema.rawFetch)
      .where(eq(dbSchema.rawFetch.contentSha256, sha));
    expect(fetches).toHaveLength(2);
  });
});
