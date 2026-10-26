/**
 * P0-3 端到端集成测试：fixture 采集 → 内容寻址归档 → 确定性抽取 → 规范化 →
 * Agent 校验 + 异常队列 → 定档报价/加工指标 → 回放。
 *
 * 所有来源均为本仓库自造 CC0 样本；不触碰 docs/compliance 中任何 BLOCKED-RIGHTS 来源。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, dbSchema } from '@bee/db';
import {
  findObservationIdsForSource,
  markSourceBlocked,
  seedPipelineDictionaries,
  type SeededPipelineDictionaries,
} from './helpers/seed';
import {
  parsePriceText,
  readContent,
  replayRun,
  resolveTermMapping,
  runFixturePipeline,
  sha256Hex,
  type SourceAdapter,
} from '../src';

const TEST_URL = process.env.BEE_TEST_DATABASE_URL ?? '';
const db = createDb(TEST_URL);

describe.skipIf(!TEST_URL)('P0-3 fixture 数据管线端到端', () => {
  let storeRoot = '';
  let seeded: SeededPipelineDictionaries;
  let mainRunId = '';
  let mainSummary: Awaited<ReturnType<typeof runFixturePipeline>>;
  const mainKey = `p0-3-e2e-${randomUUID()}`;

  beforeAll(async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), 'bee-p0-3-'));
    seeded = await seedPipelineDictionaries(db);
  });

  afterAll(async () => {
    await db.$client.end();
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('一条 fixture 从采集到定档/加工指标全程可回放，且 5 品类/同城不同价/跨源对照都成立', async () => {
    mainSummary = await runFixturePipeline({
      db,
      storeRoot,
      idempotencyKey: mainKey,
      triggeredBy: 'test',
      gitSha: 'test-git-sha',
    });
    mainRunId = mainSummary.run.id;

    expect(mainSummary.run.status).toBe('succeeded');
    expect(mainSummary.run.rulesVersion).toBe('daw29-calibration@v1');
    expect(mainSummary.run.dictionaryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mainSummary.rawFetchIds).toHaveLength(8);
    expect(mainSummary.observationIds).toHaveLength(20);
    expect(mainSummary.counts).toMatchObject({ validated: 18, isolated: 1, needsHuman: 1, quotes: 11, indicators: 11 });
    expect(mainSummary.exceptionIds).toHaveLength(2);

    // 原始存档：每份 raw_fetch 都能按内容地址取回原文，sha 与登记一致。
    const fetches = await db.select().from(dbSchema.rawFetch).where(eq(dbSchema.rawFetch.runId, mainRunId));
    expect(fetches).toHaveLength(8);
    for (const fetch of fetches) {
      const [content] = await db
        .select()
        .from(dbSchema.rawContent)
        .where(eq(dbSchema.rawContent.contentSha256, fetch.contentSha256));
      expect(content).toBeTruthy();
      const body = await readContent(storeRoot, content!.contentRef);
      expect(sha256Hex(body)).toBe(fetch.contentSha256);
    }

    // 同城不同价：苏州废钢重废同日采购价 vs 销售价是两条定档。
    const heavyPurchase = await db
      .select()
      .from(dbSchema.dailyQuote)
      .where(
        andDimensions(
          seeded.category.get('scrap-steel')!,
          seeded.spec.get('scrap-steel/heavy')!,
          seeded.region.get('suzhou')!,
          '2026-10-26',
          'purchase',
        ),
      );
    expect(heavyPurchase).toHaveLength(1);
    expect(heavyPurchase[0]).toMatchObject({
      method: 'median_multi_source',
      sourceCount: 2,
      valueLow: '2350.00',
      valueHigh: '2420.00',
      valueMid: '2387.50',
      confidence: 'high',
    });
    expect(heavyPurchase[0]!.contributingObservationIds).toHaveLength(2);

    const heavySale = await db
      .select()
      .from(dbSchema.dailyQuote)
      .where(
        andDimensions(
          seeded.category.get('scrap-steel')!,
          seeded.spec.get('scrap-steel/heavy')!,
          seeded.region.get('suzhou')!,
          '2026-10-26',
          'sale',
        ),
      );
    expect(heavySale).toHaveLength(1);
    expect(heavySale[0]).toMatchObject({ method: 'single_source', sourceCount: 1, valueLow: '2550.00', valueHigh: '2600.00', valueMid: '2575.00' });

    // 单位换算：元/斤 → 元/吨（×2000），跨源中位落在两条规范区间内。
    const petQuote = await db
      .select()
      .from(dbSchema.dailyQuote)
      .where(
        andDimensions(
          seeded.category.get('waste-plastic')!,
          seeded.spec.get('waste-plastic/pet-briquette')!,
          seeded.region.get('guangzhou')!,
          '2026-10-26',
          'purchase',
        ),
      );
    expect(petQuote).toHaveLength(1);
    expect(petQuote[0]).toMatchObject({ valueLow: '4800.00', valueHigh: '5100.00', valueMid: '4950.00', sourceCount: 2 });

    const petObservation = await db
      .select()
      .from(dbSchema.priceObservation)
      .where(eq(dbSchema.priceObservation.id, petQuote[0]!.contributingObservationIds[0]!));
    expect(petObservation[0]!.conversionApplied).toEqual({ from: '元/斤', factor: 2000 });
    expect(petObservation[0]!.normValueLow).toBe('4800.00');

    // 5 品类都有定档。
    const quotes = await db.select().from(dbSchema.dailyQuote);
    const quoteCategoryIds = new Set(quotes.map((quote) => quote.categoryId));
    for (const code of ['scrap-steel', 'scrap-copper', 'scrap-aluminum', 'waste-paper', 'waste-plastic']) {
      expect(quoteCategoryIds.has(seeded.category.get(code)!)).toBe(true);
    }

    // 全国指标恒为加工指标，且每条指标都有贡献明细。
    const indicators = await db.select().from(dbSchema.derivedIndicator).where(eq(dbSchema.derivedIndicator.computationRunId, mainRunId));
    expect(indicators).toHaveLength(11);
    for (const indicator of indicators) {
      expect(indicator.kind).toBe('national_weighted_avg');
      expect(indicator.isAggregate).toBe(1);
      const contributions = await db
        .select()
        .from(dbSchema.indicatorContribution)
        .where(eq(dbSchema.indicatorContribution.indicatorId, indicator.id));
      expect(contributions.length).toBeGreaterThanOrEqual(1);
    }

    // 异常隔离：跨源偏离的 C 不进定档；未映射品类进人工队列。
    const exceptions = await db
      .select()
      .from(dbSchema.exceptionQueue)
      .where(eq(dbSchema.exceptionQueue.kind, 'validation'));
    expect(exceptions.length).toBeGreaterThanOrEqual(2);
    expect(exceptions.some((row) => row.summary.includes('异常隔离'))).toBe(true);
    expect(exceptions.some((row) => row.summary.includes('口径不完整'))).toBe(true);
    const outlierIds = await findObservationIdsForSource(db, 'fixture-c-outlier');
    expect(heavyPurchase[0]!.contributingObservationIds.some((id) => outlierIds.includes(id))).toBe(false);

    // 阈值证据：跨源 ±4% 隔离；日环比 ±3%、周环比 ±6% 都实际执行并落 detail。
    const cross = await db
      .select()
      .from(dbSchema.validationResult)
      .where(and(eq(dbSchema.validationResult.observationId, outlierIds[0]!), eq(dbSchema.validationResult.checkKind, 'cross_source')));
    expect(cross).toHaveLength(1);
    expect(cross[0]!.verdict).toBe('isolate');
    expect(cross[0]!.detail).toMatchObject({ thresholdPct: 0.04, comparedSources: 3 });

    const dayObs = await db
      .select()
      .from(dbSchema.priceObservation)
      .where(
        and(
          eq(dbSchema.priceObservation.sourceId, seeded.source.get('fixture-a')!),
          eq(dbSchema.priceObservation.rawText, '2350-2400'),
          eq(dbSchema.priceObservation.quoteDate, '2026-10-26'),
        ),
      );
    const dayCheck = await db
      .select()
      .from(dbSchema.validationResult)
      .where(and(eq(dbSchema.validationResult.observationId, dayObs[0]!.id), eq(dbSchema.validationResult.checkKind, 'time_series')));
    expect(dayCheck[0]!.verdict).toBe('pass');
    expect(dayCheck[0]!.detail).toMatchObject({ window: 'day', thresholdPct: 0.03 });

    const weekObs = await db
      .select()
      .from(dbSchema.priceObservation)
      .where(
        and(
          eq(dbSchema.priceObservation.sourceId, seeded.source.get('fixture-a')!),
          eq(dbSchema.priceObservation.rawText, '2330-2380'),
          eq(dbSchema.priceObservation.quoteDate, '2026-10-25'),
        ),
      );
    const weekCheck = await db
      .select()
      .from(dbSchema.validationResult)
      .where(and(eq(dbSchema.validationResult.observationId, weekObs[0]!.id), eq(dbSchema.validationResult.checkKind, 'time_series')));
    expect(weekCheck[0]!.verdict).toBe('pass');
    expect(weekCheck[0]!.detail).toMatchObject({ window: 'week', thresholdPct: 0.06 });

    // Agent 校验留痕：每次观测一次调用；输出不含价格数字（LLM 只判断、不产数）。
    const invocations = await db.select().from(dbSchema.agentInvocation).where(eq(dbSchema.agentInvocation.runId, mainRunId));
    expect(invocations).toHaveLength(20);
    for (const invocation of invocations) {
      expect(invocation.purpose).toBe('validation_judgment');
      expect(invocation.model).toBe('fixture-reviewer-v1');
      expect(invocation.promptSha).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(invocation.outputJson)).not.toMatch(/\d/);
    }
    const llmResults = await db
      .select()
      .from(dbSchema.validationResult)
      .where(eq(dbSchema.validationResult.checkKind, 'llm_judgment'));
    expect(llmResults.length).toBeGreaterThanOrEqual(20);
    expect(llmResults.every((row) => row.performedByKind === 'agent')).toBe(true);

    // 台账：6 步全 succeeded，输出引用只传 id / 内容地址。
    const steps = await db.select().from(dbSchema.pipelineStep).where(eq(dbSchema.pipelineStep.runId, mainRunId));
    expect(steps.map((step) => step.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(steps.every((step) => step.status === 'succeeded')).toBe(true);
    expect(steps.every((step) => step.outputRefs !== null)).toBe(true);
    const fetchStep = steps.find((step) => step.seq === 1)!;
    expect((fetchStep.outputRefs as { rawFetchIds: string[] }).rawFetchIds).toHaveLength(8);
    const extractStep = steps.find((step) => step.seq === 2)!;
    expect((extractStep.outputRefs as { extractedRef: string }).extractedRef).toMatch(/^work\/[0-9a-f]{64}\.json$/);
    const publishStep = steps.find((step) => step.seq === 6)!;
    expect((publishStep.outputRefs as { briefingRef: string }).briefingRef).toMatch(/^work\/[0-9a-f]{64}\.json$/);
  });

  it('回放从不可变存档重算，0 差异且不写生产观测/定档/指标', async () => {
    const before = await db.select().from(dbSchema.priceObservation);
    const beforeQuotes = await db.select().from(dbSchema.dailyQuote);
    const beforeIndicators = await db.select().from(dbSchema.derivedIndicator);

    const replay = await replayRun({
      db,
      originalRunId: mainRunId,
      storeRoot,
      idempotencyKey: `p0-3-replay-${randomUUID()}`,
      gitSha: 'test-git-sha',
    });
    expect(replay.run.kind).toBe('replay');
    expect(replay.run.replayOfRunId).toBe(mainRunId);
    expect(replay.compared).toBe(20);
    expect(replay.diffCount).toBe(0);
    expect(replay.counts).toEqual({ validated: 18, isolated: 1, needsHuman: 1 });
    expect(replay.reportRef).toMatch(/^replay\/[0-9a-f]{64}\.json$/);
    const report = JSON.parse(await readContent(storeRoot, replay.reportRef!));
    expect(report.diffCount).toBe(0);
    expect(report.diffs).toEqual([]);
    expect(report.originalRunId).toBe(mainRunId);

    const after = await db.select().from(dbSchema.priceObservation);
    const afterQuotes = await db.select().from(dbSchema.dailyQuote);
    const afterIndicators = await db.select().from(dbSchema.derivedIndicator);
    expect(after).toHaveLength(before.length);
    expect(afterQuotes).toHaveLength(beforeQuotes.length);
    expect(afterIndicators).toHaveLength(beforeIndicators.length);
    const replayObservations = await db
      .select()
      .from(dbSchema.priceObservation)
      .where(eq(dbSchema.priceObservation.runId, replay.run.id));
    expect(replayObservations).toHaveLength(0);
    const replayQuotes = await db.select().from(dbSchema.dailyQuote).where(eq(dbSchema.dailyQuote.computationRunId, replay.run.id));
    expect(replayQuotes).toHaveLength(0);
    const replayIndicators = await db
      .select()
      .from(dbSchema.derivedIndicator)
      .where(eq(dbSchema.derivedIndicator.computationRunId, replay.run.id));
    expect(replayIndicators).toHaveLength(0);

    const replaySteps = await db
      .select()
      .from(dbSchema.pipelineStep)
      .where(eq(dbSchema.pipelineStep.runId, replay.run.id))
      .orderBy(dbSchema.pipelineStep.seq);
    expect(replaySteps.map((step) => step.seq)).toEqual([1, 2, 3]);
    expect(replaySteps.every((step) => step.status === 'succeeded')).toBe(true);
  });

  it('同幂等键重投复用既有 run，不重复采/不重复写观测', async () => {
    const before = await db.select().from(dbSchema.priceObservation);
    const again = await runFixturePipeline({ db, storeRoot, idempotencyKey: mainKey, triggeredBy: 'test' });
    expect(again.replayed).toBe(true);
    expect(again.run.id).toBe(mainRunId);
    const after = await db.select().from(dbSchema.priceObservation);
    expect(after).toHaveLength(before.length);
    expect(mainSummary.run.id).toBe(mainRunId);
  });

  it('合规闸门：未放行来源即使有适配器也不采集，异常留痕且 run partial', async () => {
    const code = `fixture-blocked-${randomUUID().slice(0, 8)}`;
    await markSourceBlocked(db, code);
    const blockedAdapter: SourceAdapter = {
      code,
      name: 'Blocked fixture',
      fetcherKind: 'fixture_json',
      license: { id: 'CC0-1.0', note: 'test' },
      async fetch() {
        throw new Error('不应调用未放行来源的 fetch');
      },
      extract() {
        return [];
      },
    };
    const key = `p0-3-blocked-${randomUUID()}`;
    const summary = await runFixturePipeline({
      db,
      storeRoot,
      adapters: new Map([[code, blockedAdapter]]),
      sourceCodes: [code],
      idempotencyKey: key,
    });
    expect(summary.run.status).toBe('partial');
    expect(summary.skippedSources).toEqual([code]);
    expect(summary.rawFetchIds).toHaveLength(0);
    expect(summary.observationIds).toHaveLength(0);
    const [run] = await db.select().from(dbSchema.pipelineRun).where(eq(dbSchema.pipelineRun.idempotencyKey, key));
    const fetches = await db.select().from(dbSchema.rawFetch).where(eq(dbSchema.rawFetch.runId, run!.id));
    expect(fetches).toHaveLength(0);
    const exceptions = await db.select().from(dbSchema.exceptionQueue).where(eq(dbSchema.exceptionQueue.kind, 'source'));
    expect(exceptions.some((row) => row.summary.includes('未放行'))).toBe(true);
  });

  it('映射查询遵守 source 专属 active 优先于 global active', async () => {
    const sourceB = seeded.source.get('fixture-b')!;
    await db
      .insert(dbSchema.termMapping)
      .values({
        scope: 'source',
        sourceId: sourceB,
        rawCategoryText: '废钢',
        rawSpecText: '统料',
        categoryId: seeded.category.get('scrap-steel')!,
        specId: seeded.spec.get('scrap-steel/medium')!,
        confidence: '0.99',
        status: 'active',
        decidedBy: 'test',
      })
      .onConflictDoNothing();
    const resolved = await resolveTermMapping(db, {
      sourceId: sourceB,
      rawCategoryText: '废钢',
      rawSpecText: '统料',
    });
    expect(resolved?.specId).toBe(seeded.spec.get('scrap-steel/medium'));
    const globalResolved = await resolveTermMapping(db, {
      sourceId: seeded.source.get('fixture-a')!,
      rawCategoryText: '废钢',
      rawSpecText: '统料',
    });
    expect(globalResolved?.specId).toBe(seeded.spec.get('scrap-steel/mixed'));
  });
});

function andDimensions(
  categoryId: string,
  specId: string,
  regionId: string,
  quoteDate: string,
  priceType: 'purchase' | 'sale' | 'ex_works' | 'indicative',
) {
  return and(
    eq(dbSchema.dailyQuote.categoryId, categoryId),
    eq(dbSchema.dailyQuote.specId, specId),
    eq(dbSchema.dailyQuote.regionId, regionId),
    eq(dbSchema.dailyQuote.quoteDate, quoteDate),
    eq(dbSchema.dailyQuote.priceType, priceType),
  );
}

describe('确定性价格抽取', () => {
  it('区间/单值/全角数字都能确定性解析，非数字原文直接失败', () => {
    expect(parsePriceText('2350-2400')).toEqual({ low: 2350, high: 2400 });
    expect(parsePriceText('2.4～2.5')).toEqual({ low: 2.4, high: 2.5 });
    expect(parsePriceText('２３５０—２４００')).toEqual({ low: 2350, high: 2400 });
    expect(parsePriceText('68000')).toEqual({ low: 68000, high: 68000 });
    expect(() => parsePriceText('面议')).toThrow('没有可确定性解析的数字');
  });
});
