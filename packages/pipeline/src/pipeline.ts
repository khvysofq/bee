import { eq, inArray } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import type { StepRefs } from '@bee/core';
import type { SourceAdapter } from './types';
import {
  DEFAULT_THRESHOLDS,
  type DailyQuoteRow,
  type DerivedIndicatorRow,
  type ExtractedRow,
  type NormalizedObservation,
  type ValidationThresholds,
} from './types';
import { createFixtureRegistry } from './adapters/registry';
import { createFixtureReviewer, promptSha, type AgentReviewer } from './agent';
import { aggregateDailyQuotes, aggregateNationalIndicators, publishQuotes } from './aggregate';
import { buildExtractArtifact, readExtractArtifact, writeExtractArtifact } from './extract';
import { computeDictionaryHash } from './mapping';
import { normalizeRows, NORMALIZER_VERSION } from './normalize';
import { finishRun, startRun, withStep, type PipelineRunRow } from './ledger';
import { readContent, resolveRawStoreRoot, sha256Hex, storeContent } from './store';
import { applyValidation, observationFromDb, planValidation } from './validate';

export const EXTRACT_VERSION = 'extract@1.0.0';
export const RULES_VERSION = 'daw29-calibration@v1';

export interface PipelineOptions {
  db: BeeDb;
  storeRoot?: string;
  /** 只跑指定 source.code；缺省跑 registry 里全部（仍受 source 表 active / robots 闸门约束）。 */
  sourceCodes?: string[];
  adapters?: Map<string, SourceAdapter>;
  reviewer?: AgentReviewer;
  thresholds?: Partial<ValidationThresholds>;
  rulesVersion?: string;
  gitSha?: string;
  idempotencyKey?: string;
  triggeredBy?: string;
  /** 只允许明确可复用的许可；默认仅 CC0-1.0（P0-3 不接 BLOCKED-RIGHTS 来源）。 */
  allowedLicenses?: string[];
}

export interface PipelineSummary {
  run: PipelineRunRow;
  replayed: boolean;
  rawFetchIds: string[];
  extractedRef: string | null;
  observationIds: string[];
  quoteIds: string[];
  indicatorIds: string[];
  exceptionIds: string[];
  skippedSources: string[];
  counts: { validated: number; isolated: number; needsHuman: number; quotes: number; indicators: number };
}

interface StepResultPayload {
  refs: StepRefs;
  log: string;
}

interface AggregateStepPayload extends StepResultPayload {
  quotes: DailyQuoteRow[];
  indicators: DerivedIndicatorRow[];
}

function sourceCodeOf(adapters: Map<string, SourceAdapter>, sourceId: string, sources: Map<string, string>): string {
  const code = sources.get(sourceId);
  if (!code) throw new Error(`未知 sourceId：${sourceId}`);
  if (!adapters.has(code)) throw new Error(`source ${code} 没有注册适配器 —— 真实源接入点见 adapters/registry.ts`);
  return code;
}

/**
 * 日采集主链：fetch → extract → normalize → validate → aggregate → publish。
 * 每一步都过 withStep；任何一步失败，业务事务回滚、台账留痕，run 以 partial/failed 收尾。
 */
export async function runFixturePipeline(options: PipelineOptions): Promise<PipelineSummary> {
  const db = options.db;
  const storeRoot = resolveRawStoreRoot(options.storeRoot);
  const adapters = options.adapters ?? createFixtureRegistry();
  const reviewer = options.reviewer ?? createFixtureReviewer();
  const rulesVersion = options.rulesVersion ?? RULES_VERSION;
  const allowedLicenses = new Set(options.allowedLicenses ?? ['CC0-1.0']);
  const sourceCodes = (options.sourceCodes ?? [...adapters.keys()]).sort();
  const idempotencyKey = options.idempotencyKey ?? `daily_collect:${sourceCodes.join(',')}`;
  const pins = {
    gitSha: options.gitSha ?? process.env.GIT_SHA ?? 'workspace',
    rulesVersion,
    dictionaryHash: await computeDictionaryHash(db),
  };

  const started = await startRun(db, {
    kind: 'daily_collect',
    triggeredBy: options.triggeredBy ?? 'manual',
    pins,
    idempotencyKey,
  });
  if (!started.claimed) {
    return {
      run: started.run,
      replayed: true,
      rawFetchIds: [],
      extractedRef: null,
      observationIds: [],
      quoteIds: [],
      indicatorIds: [],
      exceptionIds: [],
      skippedSources: [],
      counts: { validated: 0, isolated: 0, needsHuman: 0, quotes: 0, indicators: 0 },
    };
  }
  const runId = started.run.id;
  let rawFetchIds: string[] = [];
  let extractedRef: string | null = null;
  let observationIds: string[] = [];
  let validatedIds: string[] = [];
  let quoteIds: string[] = [];
  let indicatorIds: string[] = [];
  let exceptionIds: string[] = [];
  let skippedSources: string[] = [];
  let counts = { validated: 0, isolated: 0, needsHuman: 0, quotes: 0, indicators: 0 };

  try {
    const fetchOutcome = await withStep<StepResultPayload>(
      db,
      {
        runId,
        stepKind: 'fetch',
        seq: 1,
        stepVersion: 'fetch@1.0.0',
        inputRefs: { sourceCodes },
        outputRefs: (result) => result.refs,
      },
      async (_step, tx) => {
        const ids: string[] = [];
        const skipped: string[] = [];
        for (const code of sourceCodes) {
          const adapter = adapters.get(code);
          if (!adapter) throw new Error(`适配器未注册：${code}`);
          const [source] = await tx.select().from(dbSchema.source).where(eq(dbSchema.source.code, code)).limit(1);
          if (!source) {
            skipped.push(code);
            await tx.insert(dbSchema.exceptionQueue).values({
              kind: 'source',
              subjectType: 'source',
              summary: `来源 ${code} 未在 source 表登记，拒绝采集`,
              priority: 'high',
              assignedTo: 'unassigned',
            });
            continue;
          }
          if (source.status !== 'active' || source.robotsStatus !== 'allowed') {
            skipped.push(code);
            await tx.insert(dbSchema.exceptionQueue).values({
              kind: 'source',
              subjectType: 'source',
              subjectId: source.id,
              summary: `来源 ${code} 未放行（status=${source.status}, robots=${source.robotsStatus}），拒绝采集`,
              priority: 'high',
              assignedTo: 'unassigned',
            });
            continue;
          }
          const documents = await adapter.fetch({ source });
          for (const document of documents) {
            const license = String(document.fetchMeta?.license ?? 'unknown');
            if (!allowedLicenses.has(license)) {
              skipped.push(code);
              await tx.insert(dbSchema.exceptionQueue).values({
                kind: 'source',
                subjectType: 'source',
                subjectId: source.id,
                summary: `来源 ${code} 许可 ${license} 不在允许清单，拒绝入管线`,
                priority: 'high',
                assignedTo: 'unassigned',
              });
              continue;
            }
            const contentSha256 = sha256Hex(document.body);
            const [existingContent] = await tx
              .select({ contentRef: dbSchema.rawContent.contentRef })
              .from(dbSchema.rawContent)
              .where(eq(dbSchema.rawContent.contentSha256, contentSha256))
              .limit(1);
            let contentRef = existingContent?.contentRef;
            if (!contentRef) {
              const stored = await storeContent(storeRoot, { namespace: 'raw', body: document.body, date: document.fetchedAt });
              contentRef = stored.contentRef;
              await tx
                .insert(dbSchema.rawContent)
                .values({ contentSha256, contentRef })
                .onConflictDoNothing({ target: dbSchema.rawContent.contentSha256 });
            }
            const [fetch] = await tx
              .insert(dbSchema.rawFetch)
              .values({
                sourceId: source.id,
                runId,
                url: document.url,
                fetchedAt: document.fetchedAt,
                httpStatus: document.httpStatus,
                contentSha256,
                contentType: document.contentType,
                contentSizeBytes: Buffer.byteLength(document.body, 'utf8'),
                pagePublishedAt: document.pagePublishedAt,
                fetchMeta: document.fetchMeta,
              })
              .returning();
            ids.push(fetch!.id);
          }
        }
        // 全部来源被合规闸门跳过时不在事务里抛错，否则刚写入的 source 异常会被回滚；
        // 由编排层以 partial 收尾，保留「为什么没采」的审计证据。
        return {
          refs: { rawFetchIds: ids, skippedSources: skipped, archivedCount: ids.length },
          log: `归档 ${ids.length} 份原文；跳过来源：${skipped.join(',') || '无'}`,
        };
      },
    );
    if (fetchOutcome.replayed) throw new Error('fetch 步重放但缺少结果，无法继续编排');
    rawFetchIds = fetchOutcome.result.refs.rawFetchIds as string[];
    skippedSources = (fetchOutcome.result.refs.skippedSources as string[]) ?? [];
    if (rawFetchIds.length === 0) {
      const finalRun = await finishRun(db, runId, { status: 'partial', error: '所有来源均被合规闸门跳过' });
      return {
        run: finalRun,
        replayed: false,
        rawFetchIds,
        extractedRef,
        observationIds,
        quoteIds,
        indicatorIds,
        exceptionIds,
        skippedSources,
        counts,
      };
    }

    const extractOutcome = await withStep<StepResultPayload>(
      db,
      {
        runId,
        stepKind: 'extract',
        seq: 2,
        stepVersion: EXTRACT_VERSION,
        inputRefs: { rawFetchIds },
        outputRefs: (result) => result.refs,
      },
      async (_step, tx): Promise<StepResultPayload> => {
        const fetches = await tx.select().from(dbSchema.rawFetch).where(inArray(dbSchema.rawFetch.id, rawFetchIds));
        const sources = await tx
          .select({ id: dbSchema.source.id, code: dbSchema.source.code })
          .from(dbSchema.source)
          .where(inArray(dbSchema.source.id, fetches.map((fetch) => fetch.sourceId)));
        const sourceById = new Map(sources.map((source) => [source.id, source.code]));
        const documents: Array<{ sourceId: string; sourceCode: string; fetchId: string; contentSha256: string; rows: ExtractedRow[] }> = [];
        for (const fetch of fetches) {
          const code = sourceCodeOf(adapters, fetch.sourceId, sourceById);
          const adapter = adapters.get(code)!;
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
          documents.push({
            sourceId: fetch.sourceId,
            sourceCode: code,
            fetchId: fetch.id,
            contentSha256: fetch.contentSha256,
            rows,
          });
        }
        const artifact = buildExtractArtifact({ runId, extractVersion: EXTRACT_VERSION, documents });
        const written = await writeExtractArtifact(storeRoot, artifact);
        return {
          refs: {
            rawFetchIds,
            extractedRef: written.extractedRef,
            extractedSha: written.extractedSha,
            rowCount: documents.reduce((sum, document) => sum + document.rows.length, 0),
          },
          log: `抽取 ${documents.reduce((sum, document) => sum + document.rows.length, 0)} 行，工件 ${written.extractedSha.slice(0, 12)}`,
        };
      },
    );
    if (extractOutcome.replayed) throw new Error('extract 步重放但缺少结果，无法继续编排');
    extractedRef = extractOutcome.result.refs.extractedRef as string;

    const normalizeOutcome = await withStep<StepResultPayload>(
      db,
      {
        runId,
        stepKind: 'normalize',
        seq: 3,
        stepVersion: NORMALIZER_VERSION,
        inputRefs: { extractedRef },
        outputRefs: (result) => result.refs,
      },
      async (_step, tx): Promise<StepResultPayload> => {
        const artifact = await readExtractArtifact(storeRoot, extractedRef!);
        const normalized: NormalizedObservation[] = [];
        for (const document of artifact.documents) {
          const [fetch] = await tx
            .select({ fetchedAt: dbSchema.rawFetch.fetchedAt })
            .from(dbSchema.rawFetch)
            .where(eq(dbSchema.rawFetch.id, document.fetchId))
            .limit(1);
          if (!fetch) throw new Error(`raw_fetch 缺失：${document.fetchId}`);
          const rows = await normalizeRows(tx, {
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
        const needsHuman = normalized.filter((item) => item.status === 'needs_human');
        return {
          refs: {
            observationIds: normalized.map((item) => item.observationId),
            needsHumanObservationIds: needsHuman.map((item) => item.observationId),
            normalizedCount: normalized.length,
          },
          log: `规范化 ${normalized.length} 条；待人工口径 ${needsHuman.length} 条`,
        };
      },
    );
    if (normalizeOutcome.replayed) throw new Error('normalize 步重放但缺少结果，无法继续编排');
    observationIds = normalizeOutcome.result.refs.observationIds as string[];

    const validateOutcome = await withStep<StepResultPayload>(
      db,
      {
        runId,
        stepKind: 'validate',
        seq: 4,
        stepVersion: 'validate@1.0.0',
        inputRefs: { observationIds },
        outputRefs: (result) => result.refs,
      },
      async (step, tx): Promise<StepResultPayload> => {
        const observations = await tx
          .select()
          .from(dbSchema.priceObservation)
          .where(inArray(dbSchema.priceObservation.id, observationIds));
        const sources = await tx
          .select({ id: dbSchema.source.id, code: dbSchema.source.code })
          .from(dbSchema.source)
          .where(inArray(dbSchema.source.id, observations.map((observation) => observation.sourceId)));
        const sourceName = new Map(sources.map((source) => [source.id, source.code]));
        const plan = await planValidation(tx, {
          observations: observations.map((row) => observationFromDb(row, sourceName.get(row.sourceId) ?? row.sourceId)),
          reviewer,
          thresholds: options.thresholds,
        });
        const applied = await applyValidation(tx, {
          plan,
          runId,
          stepId: step.id,
          rulesVersion,
          reviewer,
          promptSha: promptSha(reviewer),
        });
        const validated = plan.items.filter((item) => item.status === 'validated').map((item) => item.observationId!);
        const isolated = plan.items.filter((item) => item.status === 'isolated').map((item) => item.observationId!);
        const needsHuman = plan.items.filter((item) => item.status === 'needs_human').map((item) => item.observationId!);
        validatedIds = validated;
        exceptionIds = applied.exceptionIds;
        counts = { ...counts, ...applied.counts };
        return {
          refs: {
            validatedObservationIds: validated,
            isolatedObservationIds: isolated,
            needsHumanObservationIds: needsHuman,
            exceptionIds: applied.exceptionIds,
            validationIds: applied.validationIds,
            agentInvocationIds: applied.invocationIds,
          },
          log: `校验 ${plan.items.length} 条：validated=${applied.counts.validated}, isolated=${applied.counts.isolated}, needs_human=${applied.counts.needsHuman}`,
        };
      },
    );
    if (validateOutcome.replayed) throw new Error('validate 步重放但缺少结果，无法继续编排');

    const aggregateOutcome = await withStep<AggregateStepPayload>(
      db,
      {
        runId,
        stepKind: 'aggregate',
        seq: 5,
        stepVersion: 'aggregate@1.0.0',
        inputRefs: { validatedObservationIds: validatedIds },
        outputRefs: (result) => result.refs,
      },
      async (_step, tx): Promise<AggregateStepPayload> => {
        const quotes = await aggregateDailyQuotes(tx, {
          runId,
          observationIds: validatedIds,
          rulesVersion,
        });
        const indicators = await aggregateNationalIndicators(tx, { runId, quotes });
        quoteIds = quotes.map((quote) => quote.id);
        indicatorIds = indicators.map((indicator) => indicator.id);
        counts = { ...counts, quotes: quotes.length, indicators: indicators.length };
        return {
          refs: { quoteIds, indicatorIds, quoteCount: quotes.length, indicatorCount: indicators.length },
          log: `定档 ${quotes.length} 条；加工指标 ${indicators.length} 条`,
          quotes,
          indicators,
        };
      },
    );
    if (aggregateOutcome.replayed) throw new Error('aggregate 步重放但缺少结果，无法继续编排');

    const publishOutcome = await withStep<StepResultPayload>(
      db,
      {
        runId,
        stepKind: 'publish',
        seq: 6,
        stepVersion: 'publish@1.0.0',
        inputRefs: { quoteIds, indicatorIds },
        outputRefs: (result) => result.refs,
      },
      async (_step, tx): Promise<StepResultPayload> => {
        const published = await publishQuotes(tx, { quoteIds });
        const brief = JSON.stringify(
          {
            schemaVersion: 1,
            runId,
            generatedAt: new Date().toISOString(),
            quotes: aggregateOutcome.result.quotes.map((quote) => ({
              id: quote.id,
              categoryId: quote.categoryId,
              specId: quote.specId,
              regionId: quote.regionId,
              quoteDate: quote.quoteDate,
              priceType: quote.priceType,
              valueLow: quote.valueLow,
              valueHigh: quote.valueHigh,
              valueMid: quote.valueMid,
              method: quote.method,
              confidence: quote.confidence,
            })),
            indicators: aggregateOutcome.result.indicators.map((indicator) => ({
              id: indicator.id,
              kind: indicator.kind,
              categoryId: indicator.categoryId,
              specId: indicator.specId,
              regionId: indicator.regionId,
              priceType: indicator.priceType,
              basisDate: indicator.basisDate,
              value: indicator.value,
              isAggregate: indicator.isAggregate,
            })),
          },
          null,
          2,
        );
        const stored = await storeContent(storeRoot, { namespace: 'work', body: brief });
        return {
          refs: { quoteIds, indicatorIds, briefingRef: stored.contentRef, publishedCount: published },
          log: `发布 ${published} 条定档报价；简报工件 ${stored.contentSha256.slice(0, 12)}`,
        };
      },
    );
    if (publishOutcome.replayed) throw new Error('publish 步重放但缺少结果，无法继续编排');

    const finalRun = await finishRun(db, runId, { status: skippedSources.length > 0 ? 'partial' : 'succeeded' });
    return {
      run: finalRun,
      replayed: false,
      rawFetchIds,
      extractedRef,
      observationIds,
      quoteIds,
      indicatorIds,
      exceptionIds,
      skippedSources,
      counts,
    };
  } catch (error) {
    await finishRun(db, runId, { status: 'partial', error: String(error) }).catch(() => undefined);
    throw error;
  }
}
