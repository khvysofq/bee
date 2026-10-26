import { eq, inArray } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import type { StepRefs } from '@bee/core';
import type { AgentReviewer } from './agent';
import { createFixtureReviewer } from './agent';
import { createFixtureRegistry } from './adapters/registry';
import { buildExtractArtifact, readExtractArtifact, writeExtractArtifact } from './extract';
import { computeDictionaryHash } from './mapping';
import { normalizeRowsPreview } from './normalize';
import { finishRun, startRun, withStep, type PipelineRunRow } from './ledger';
import { readContent, resolveRawStoreRoot, storeContent } from './store';
import type { ExtractedRow, NormalizedObservation, SourceAdapter, ValidationThresholds } from './types';
import { planValidation, type ObservationForValidation } from './validate';
import { EXTRACT_VERSION, RULES_VERSION } from './pipeline';

export interface ReplayOptions {
  db: BeeDb;
  originalRunId: string;
  storeRoot?: string;
  adapters?: Map<string, SourceAdapter>;
  reviewer?: AgentReviewer;
  thresholds?: Partial<ValidationThresholds>;
  rulesVersion?: string;
  gitSha?: string;
  idempotencyKey?: string;
}

export interface ReplayDiff {
  observationKey: string;
  field: string;
  original: unknown;
  replay: unknown;
}

export interface ReplaySummary {
  run: PipelineRunRow;
  replayed: boolean;
  reportRef: string | null;
  compared: number;
  diffCount: number;
  exceptionIds: string[];
  counts: { validated: number; isolated: number; needsHuman: number };
}

interface ReplayStepPayload {
  refs: StepRefs;
  log: string;
}

interface ReplayNormalizePayload extends ReplayStepPayload {
  normalized: Array<Omit<NormalizedObservation, 'observationId'>>;
}

function equalValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.01;
  return a === b;
}

function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * 回放：从不可变 raw_fetch 存档重新抽取/规范化/校验，输出新旧对照报告。
 * 绝不写生产观测、定档、指标表；差异只进 exception_queue 等人工裁决。
 */
export async function replayRun(options: ReplayOptions): Promise<ReplaySummary> {
  const db = options.db;
  const storeRoot = resolveRawStoreRoot(options.storeRoot);
  const adapters = options.adapters ?? createFixtureRegistry();
  const reviewer = options.reviewer ?? createFixtureReviewer();
  const rulesVersion = options.rulesVersion ?? RULES_VERSION;
  const [original] = await db.select().from(dbSchema.pipelineRun).where(eq(dbSchema.pipelineRun.id, options.originalRunId)).limit(1);
  if (!original) throw new Error(`原运行不存在：${options.originalRunId}`);

  const dictionaryHash = await computeDictionaryHash(db);
  const started = await startRun(db, {
    kind: 'replay',
    triggeredBy: 'manual',
    pins: { gitSha: options.gitSha ?? process.env.GIT_SHA ?? 'workspace', rulesVersion, dictionaryHash },
    idempotencyKey: options.idempotencyKey ?? `replay:${options.originalRunId}:${rulesVersion}`,
    replayOfRunId: options.originalRunId,
  });
  if (!started.claimed) {
    return {
      run: started.run,
      replayed: true,
      reportRef: null,
      compared: 0,
      diffCount: 0,
      exceptionIds: [],
      counts: { validated: 0, isolated: 0, needsHuman: 0 },
    };
  }
  const runId = started.run.id;
  let reportRef: string | null = null;
  let compared = 0;
  let diffCount = 0;
  let exceptionIds: string[] = [];
  let counts = { validated: 0, isolated: 0, needsHuman: 0 };

  try {
    const fetches = await db.select().from(dbSchema.rawFetch).where(eq(dbSchema.rawFetch.runId, options.originalRunId));
    if (fetches.length === 0) throw new Error(`原运行 ${options.originalRunId} 没有 raw_fetch，无法回放`);
    const rawFetchIds = fetches.map((fetch) => fetch.id);
    const sources = await db
      .select({ id: dbSchema.source.id, code: dbSchema.source.code })
      .from(dbSchema.source)
      .where(inArray(dbSchema.source.id, fetches.map((fetch) => fetch.sourceId)));
    const sourceCode = new Map(sources.map((source) => [source.id, source.code]));

    const extractOutcome = await withStep<ReplayStepPayload>(
      db,
      {
        runId,
        stepKind: 'extract',
        seq: 1,
        stepVersion: EXTRACT_VERSION,
        inputRefs: { rawFetchIds, replayOfRunId: options.originalRunId },
        outputRefs: (result) => result.refs,
      },
      async (_step, tx) => {
        const documents: Array<{ sourceId: string; sourceCode: string; fetchId: string; contentSha256: string; rows: ExtractedRow[] }> = [];
        for (const fetch of fetches) {
          const code = sourceCode.get(fetch.sourceId);
          if (!code) throw new Error(`raw_fetch ${fetch.id} 的来源未登记`);
          const adapter = adapters.get(code);
          if (!adapter) throw new Error(`回放缺少适配器：${code}`);
          const [content] = await tx
            .select({ contentRef: dbSchema.rawContent.contentRef })
            .from(dbSchema.rawContent)
            .where(eq(dbSchema.rawContent.contentSha256, fetch.contentSha256))
            .limit(1);
          if (!content) throw new Error(`raw_content 缺失：${fetch.contentSha256}`);
          const body = await readContent(storeRoot, content.contentRef);
          const rows = adapter.extract({
            sourceCode: code,
            url: fetch.url,
            fetchedAt: fetch.fetchedAt,
            httpStatus: fetch.httpStatus,
            contentType: fetch.contentType ?? 'application/octet-stream',
            body,
            pagePublishedAt: fetch.pagePublishedAt ?? undefined,
            fetchMeta: (fetch.fetchMeta as Record<string, unknown> | null) ?? undefined,
          });
          documents.push({ sourceId: fetch.sourceId, sourceCode: code, fetchId: fetch.id, contentSha256: fetch.contentSha256, rows });
        }
        const artifact = buildExtractArtifact({ runId, extractVersion: EXTRACT_VERSION, documents });
        const written = await writeExtractArtifact(storeRoot, artifact);
        return { refs: { rawFetchIds, extractedRef: written.extractedRef, extractedSha: written.extractedSha }, log: `回放抽取 ${documents.length} 份存档` };
      },
    );
    if (extractOutcome.replayed) throw new Error('回放 extract 步缺少结果');

    const normalizeOutcome = await withStep<ReplayNormalizePayload>(
      db,
      {
        runId,
        stepKind: 'normalize',
        seq: 2,
        stepVersion: 'normalize@1.0.0',
        inputRefs: { extractedRef: extractOutcome.result.refs.extractedRef },
        outputRefs: (result) => result.refs,
      },
      async (_step, tx) => {
        const artifact = await readExtractArtifact(storeRoot, extractOutcome.result.refs.extractedRef as string);
        const normalized: Array<Omit<NormalizedObservation, 'observationId'>> = [];
        for (const document of artifact.documents) {
          const fetch = fetches.find((row) => row.id === document.fetchId);
          if (!fetch) throw new Error(`raw_fetch 缺失：${document.fetchId}`);
          const rows = await normalizeRowsPreview(tx, {
            sourceId: document.sourceId,
            sourceCode: document.sourceCode,
            fetchId: document.fetchId,
            fetchedAt: fetch.fetchedAt,
            runId,
            extractVersion: artifact.extractVersion,
            rows: document.rows,
          });
          normalized.push(...rows);
        }
        return {
          refs: { normalizedCount: normalized.length, observationKeys: normalized.map((item) => `${item.sourceId}:${item.fetchId}:${item.sourceRowIndex}`) },
          log: `回放规范化 ${normalized.length} 条（不落生产观测表）`,
          normalized,
        };
      },
    );
    if (normalizeOutcome.replayed) throw new Error('回放 normalize 步缺少结果');

    const validateOutcome = await withStep<ReplayStepPayload>(
      db,
      {
        runId,
        stepKind: 'validate',
        seq: 3,
        stepVersion: 'validate@1.0.0',
        inputRefs: { observationKeys: normalizeOutcome.result.refs.observationKeys },
        outputRefs: (result) => result.refs,
      },
      async (_step, tx) => {
        const replayObservations: ObservationForValidation[] = normalizeOutcome.result.normalized.map((item) => ({
          observationKey: `${item.sourceId}:${item.fetchId}:${item.sourceRowIndex}`,
          observationId: null,
          sourceId: item.sourceId,
          sourceName: sourceCode.get(item.sourceId) ?? item.sourceId,
          categoryId: item.categoryId,
          specId: item.specId,
          regionId: item.regionId,
          priceType: item.priceType,
          quoteDate: item.row.quoteDate,
          normValueLow: item.normValueLow,
          normValueHigh: item.normValueHigh,
          initialStatus: item.status,
          issues: item.issues,
        }));
        const plan = await planValidation(tx, { observations: replayObservations, reviewer, thresholds: options.thresholds });
        const originalRows = await tx
          .select()
          .from(dbSchema.priceObservation)
          .where(eq(dbSchema.priceObservation.runId, options.originalRunId));
        const originalByKey = new Map(originalRows.map((row) => [`${row.sourceId}:${row.fetchId}:${row.sourceRowIndex}`, row]));
        const diffs: ReplayDiff[] = [];
        for (const item of plan.items) {
          const originalRow = originalByKey.get(item.observationKey);
          if (!originalRow) {
            diffs.push({ observationKey: item.observationKey, field: 'missingOriginal', original: null, replay: item.status });
            continue;
          }
          const checks: Array<[string, unknown, unknown]> = [
            ['categoryId', originalRow.categoryId, item.categoryId],
            ['specId', originalRow.specId, item.specId],
            ['regionId', originalRow.regionId, item.regionId],
            ['priceType', originalRow.priceType, item.priceType],
            ['quoteDate', originalRow.quoteDate, item.quoteDate],
            ['normValueLow', numberOrNull(originalRow.normValueLow), item.normValueLow],
            ['normValueHigh', numberOrNull(originalRow.normValueHigh), item.normValueHigh],
            ['validationStatus', originalRow.validationStatus, item.status],
          ];
          for (const [field, originalValue, replayValue] of checks) {
            if (!equalValue(originalValue, replayValue)) {
              diffs.push({ observationKey: item.observationKey, field, original: originalValue, replay: replayValue });
            }
          }
        }
        const replayKeys = new Set(plan.items.map((item) => item.observationKey));
        for (const key of originalByKey.keys()) {
          if (!replayKeys.has(key)) diffs.push({ observationKey: key, field: 'missingReplay', original: true, replay: null });
        }

        compared = plan.items.length;
        diffCount = diffs.length;
        counts = plan.counts;
        const report = {
          schemaVersion: 1,
          kind: 'replay_report',
          originalRunId: options.originalRunId,
          replayRunId: runId,
          generatedAt: new Date().toISOString(),
          originalPins: {
            gitSha: original.gitSha,
            rulesVersion: original.rulesVersion,
            dictionaryHash: original.dictionaryHash,
          },
          replayPins: { gitSha: options.gitSha ?? process.env.GIT_SHA ?? 'workspace', rulesVersion, dictionaryHash },
          compared,
          diffCount,
          diffs,
          counts,
          note: '回放不写生产观测/定档/指标表；差异只进异常队列等待人工裁决',
        };
        const stored = await storeContent(storeRoot, { namespace: 'replay', body: JSON.stringify(report, null, 2) });
        reportRef = stored.contentRef;
        if (diffCount > 0) {
          const [exception] = await tx
            .insert(dbSchema.exceptionQueue)
            .values({
              kind: 'pipeline',
              subjectType: 'run',
              subjectId: runId,
              summary: `回放差异 ${diffCount} 处（原运行 ${options.originalRunId}），见报告 ${stored.contentRef}`,
              priority: 'high',
              assignedTo: 'unassigned',
            })
            .returning({ id: dbSchema.exceptionQueue.id });
          exceptionIds = [exception!.id];
        }
        return {
          refs: { reportRef: stored.contentRef, reportSha: stored.contentSha256, compared, diffCount, counts, exceptionIds },
          log: `回放对照 ${compared} 条，差异 ${diffCount} 处`,
        };
      },
    );
    if (validateOutcome.replayed) throw new Error('回放 validate 步缺少结果');

    const finalRun = await finishRun(db, runId, { status: 'succeeded' });
    return { run: finalRun, replayed: false, reportRef, compared, diffCount, exceptionIds, counts };
  } catch (error) {
    await finishRun(db, runId, { status: 'failed', error: String(error) }).catch(() => undefined);
    throw error;
  }
}
