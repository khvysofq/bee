import { eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import type { StepKind, StepRefs } from '@bee/core';

/**
 * 管线台账 helper（P0-3 的地基）：每个运行与每步的启停、输入输出引用都落 pipeline_run / pipeline_step。
 *
 * 用法约定（P0-3 实现管线时遵守）：
 *   const run = await startRun(db, { kind: 'daily_collect', triggeredBy: 'schedule', ...pins });
 *   const step = await startStep(db, run.id, 'fetch', 1, { sourceId });
 *   ... 业务 ...
 *   await finishStep(db, step.id, { status: 'succeeded', outputRefs: { rawFetchIds } });
 *   await finishRun(db, run.id, { status: 'succeeded' });
 * 回放：kind='replay' + replayOfRunId 指向原 run，输出只落报告，绝不写生产表（见 packages/pipeline/README.md）。
 */
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
  },
) {
  const [run] = await db
    .insert(dbSchema.pipelineRun)
    .values({
      kind: args.kind,
      triggeredBy: args.triggeredBy,
      configJson: args.configJson,
      gitSha: args.pins.gitSha,
      rulesVersion: args.pins.rulesVersion,
      dictionaryHash: args.pins.dictionaryHash,
      replayOfRunId: args.replayOfRunId,
      status: 'running',
      startedAt: new Date(),
    })
    .returning();
  return run!;
}

export async function finishRun(
  db: BeeDb,
  runId: string,
  args: { status: 'succeeded' | 'failed' | 'partial'; error?: string },
) {
  const [run] = await db
    .update(dbSchema.pipelineRun)
    .set({ status: args.status, error: args.error, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(dbSchema.pipelineRun.id, runId))
    .returning();
  return run!;
}

export async function startStep(
  db: BeeDb,
  args: { runId: string; stepKind: StepKind; seq: number; inputRefs?: StepRefs },
) {
  const [step] = await db
    .insert(dbSchema.pipelineStep)
    .values({
      runId: args.runId,
      stepKind: args.stepKind,
      seq: args.seq,
      inputRefs: args.inputRefs,
      status: 'running',
      startedAt: new Date(),
    })
    .returning();
  return step!;
}

export async function finishStep(
  db: BeeDb,
  stepId: string,
  args: { status: 'succeeded' | 'failed' | 'skipped'; outputRefs?: StepRefs; logExcerpt?: string; error?: string },
) {
  const [step] = await db
    .update(dbSchema.pipelineStep)
    .set({
      status: args.status,
      outputRefs: args.outputRefs,
      logExcerpt: args.logExcerpt?.slice(0, 2000),
      error: args.error,
      finishedAt: new Date(),
    })
    .where(eq(dbSchema.pipelineStep.id, stepId))
    .returning();
  return step!;
}
