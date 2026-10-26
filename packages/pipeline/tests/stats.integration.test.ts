/**
 * P0-5 国家统计局旬价真实源端到端：真实 HTML 快照 → WORM → 确定性抽取 →
 * 规范化 → 校验 → 定档 → 全国参考锚点指标 → 回放零差异。
 *
 * 快照为 2026-10-26 从 stats.gov.cn 抓取的 2026年10月中旬公报，sha256 与线上一致；
 * 测试不访问外网，数字全部来自 HTML 表格解析。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, dbSchema } from '@bee/db';
import { seedPipelineDictionaries, type SeededPipelineDictionaries } from './helpers/seed';
import {
  ANCHOR_COVERAGE_NOTE,
  createSourceRegistry,
  readContent,
  readExtractArtifact,
  replayRun,
  runFixturePipeline,
  sha256Hex,
  StatsSourceAdapter,
  STATS_2026_10_MID_URL,
  seedStatsDictionaries,
  type SeededStatsDictionaries,
} from '../src';

const TEST_URL = process.env.BEE_TEST_DATABASE_URL ?? '';
const db = createDb(TEST_URL);
const SNAPSHOT_PATH = fileURLToPath(new URL('../fixtures/stats/2026-10-mid.html', import.meta.url));

describe.skipIf(!TEST_URL)('P0-5 国家统计局旬价真实源端到端', () => {
  let storeRoot = '';
  let seeded: SeededPipelineDictionaries;
  let statsSeeded: SeededStatsDictionaries;
  let summary: Awaited<ReturnType<typeof runFixturePipeline>>;
  const runKey = `p0-5-stats-${randomUUID()}`;

  beforeAll(async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), 'bee-p0-5-'));
    seeded = await seedPipelineDictionaries(db);
    statsSeeded = await seedStatsDictionaries(db);
  });

  afterAll(async () => {
    await db.$client.end();
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('一期真实旬价从采集→归档→抽取→规范化→台账→落库全程可回放', async () => {
    const adapter = new StatsSourceAdapter({
      snapshotPath: SNAPSHOT_PATH,
      documentUrl: STATS_2026_10_MID_URL,
      fetchedAt: new Date('2026-10-26T13:34:00Z'),
    });
    summary = await runFixturePipeline({
      db,
      storeRoot,
      adapters: new Map([['stats-cn', adapter]]),
      sourceCodes: ['stats-cn'],
      allowedLicenses: ['GOV-STATS-ATTRIBUTION'],
      idempotencyKey: runKey,
      triggeredBy: 'test:p0-5',
      gitSha: 'test-git-sha',
    });

    expect(summary.run.status).toBe('succeeded');
    expect(summary.rawFetchIds).toHaveLength(1);
    expect(summary.observationIds).toHaveLength(7);
    expect(summary.counts).toMatchObject({ validated: 7, isolated: 0, needsHuman: 0, quotes: 7, indicators: 7 });
    expect(summary.skippedSources).toEqual([]);

    // 1) WORM：归档正文哈希与真实快照一致，URL 指向公报原文，pagePublishedAt 来自 PubDate。
    const [fetch] = await db.select().from(dbSchema.rawFetch).where(eq(dbSchema.rawFetch.runId, summary.run.id));
    expect(fetch).toMatchObject({
      url: STATS_2026_10_MID_URL,
      httpStatus: 200,
      contentType: 'text/html; charset=utf-8',
    });
    const [content] = await db
      .select()
      .from(dbSchema.rawContent)
      .where(eq(dbSchema.rawContent.contentSha256, fetch!.contentSha256));
    const archived = await readContent(storeRoot, content!.contentRef);
    expect(sha256Hex(archived)).toBe(fetch!.contentSha256);
    expect(fetch!.contentSha256).toBe('0494d792da9be68ec70c2de17d7b76593ec7c72a519fab557b64df0d232f82a8');
    expect(fetch!.pagePublishedAt?.toISOString()).toBe('2026-10-24T01:30:00.000Z');
    expect(fetch!.fetchMeta).toMatchObject({
      adapter: 'stats_bulletin',
      license: 'GOV-STATS-ATTRIBUTION',
      periodText: '2026年10月中旬',
      periodEnd: '2026-10-20',
      sourceSection: '流通领域重要生产资料市场价格',
      targetRowCount: 7,
    });

    // 2) 确定性抽取：数字与原文逐字一致，环比也来自原文；不走 LLM。
    const artifact = await readExtractArtifact(storeRoot, summary.extractedRef!);
    const rows = artifact.documents.flatMap((document) => document.rows);
    expect(rows).toHaveLength(7);
    const rebar = rows.find((row) => row.rawCategoryText === '螺纹钢');
    expect(rebar).toMatchObject({
      rawSpecText: 'Φ20mm，HRB400E',
      rawText: '3187.8',
      rawValueLow: 3187.8,
      rawValueHigh: 3187.8,
      rawUnit: '元/吨',
      rawPriceTypeText: '本期价格',
      rawRegionText: '全国',
      quoteDate: '2026-10-20',
      rawChangeValue: 11.9,
      rawChangePct: 0.4,
      rawPeriodText: '2026年10月中旬',
      rawSectionText: '一、黑色金属',
    });
    expect(rows.find((row) => row.rawCategoryText === '电解铜')).toMatchObject({
      rawSpecText: '1#',
      rawValueLow: 110921.4,
      rawChangeValue: -821.1,
      rawChangePct: -0.7,
    });
    expect(rows.find((row) => row.rawCategoryText === '瓦楞纸')).toMatchObject({
      rawSpecText: 'AA级120g',
      rawValueLow: 3098.8,
      rawChangeValue: 12.1,
      rawChangePct: 0.4,
    });
    expect(rows.find((row) => row.rawCategoryText === '聚乙烯')).toMatchObject({
      rawSpecText: 'LLDPE，熔融指数2薄膜料',
      rawValueLow: 9999,
      rawChangeValue: 657.1,
      rawChangePct: 7,
    });

    // 3) 规范化：五品类锚点映射、元/吨、indicative、全国参考逻辑地域。
    const observations = await db
      .select()
      .from(dbSchema.priceObservation)
      .where(eq(dbSchema.priceObservation.runId, summary.run.id));
    expect(observations).toHaveLength(7);
    const rebarObs = observations.find((row) => row.rawCategoryText === '螺纹钢')!;
    expect(rebarObs).toMatchObject({
      categoryId: seeded.category.get('scrap-steel'),
      specId: statsSeeded.specs.get('scrap-steel/rebar-hrb400e-anchor'),
      regionId: statsSeeded.referenceRegionId,
      priceType: 'indicative',
      normValueLow: '3187.80',
      normValueHigh: '3187.80',
      validationStatus: 'validated',
    });
    expect(rebarObs.conversionApplied).toMatchObject({ from: '元/吨', factor: 1 });
    expect(new Set(observations.map((row) => row.categoryId))).toEqual(
      new Set([
        seeded.category.get('scrap-steel'),
        seeded.category.get('scrap-copper'),
        seeded.category.get('scrap-aluminum'),
        seeded.category.get('waste-paper'),
        seeded.category.get('waste-plastic'),
      ]),
    );

    // 4) 定档：七个原生品锚点报价，明确非废料分档现货；区域分档缺口写进覆盖说明。
    const quotes = await db
      .select()
      .from(dbSchema.dailyQuote)
      .where(eq(dbSchema.dailyQuote.computationRunId, summary.run.id));
    expect(quotes).toHaveLength(7);
    const rebarQuote = quotes.find((quote) => quote.specId === statsSeeded.specs.get('scrap-steel/rebar-hrb400e-anchor'))!;
    expect(rebarQuote).toMatchObject({
      quoteDate: '2026-10-20',
      priceType: 'indicative',
      valueLow: '3187.80',
      valueHigh: '3187.80',
      valueMid: '3187.80',
      method: 'single_source',
      sourceCount: 1,
      status: 'published',
    });
    expect(rebarQuote.coverageNote).toContain(ANCHOR_COVERAGE_NOTE);
    expect(rebarQuote.coverageNote).toContain('区域分档暂缺');
    expect(quotes.every((quote) => quote.coverageNote?.includes('原生品，非废料分档现货'))).toBe(true);

    // 5) 指标：national_reference（来源直发全国参考价），不是按城市加权编出来的均价。
    const indicators = await db
      .select()
      .from(dbSchema.derivedIndicator)
      .where(eq(dbSchema.derivedIndicator.computationRunId, summary.run.id));
    expect(indicators).toHaveLength(7);
    for (const indicator of indicators) {
      expect(indicator.kind).toBe('national_reference');
      expect(indicator.isAggregate).toBe(1);
      expect(indicator.regionId).toBe(seeded.region.get('cn'));
      expect(indicator.methodJson).toMatchObject({ formula: '直接引用' });
      expect(String((indicator.methodJson as { note?: string }).note)).toContain('区域分档暂缺');
      const contributions = await db
        .select()
        .from(dbSchema.indicatorContribution)
        .where(eq(dbSchema.indicatorContribution.indicatorId, indicator.id));
      expect(contributions).toHaveLength(1);
      expect(contributions[0]!.valueAtAggregation).toBe(indicator.value);
    }

    // 6) 台账：六步全 succeeded，raw_fetch 与 extract 引用可互相追溯。
    const steps = await db
      .select()
      .from(dbSchema.pipelineStep)
      .where(eq(dbSchema.pipelineStep.runId, summary.run.id))
      .orderBy(dbSchema.pipelineStep.seq);
    expect(steps.map((step) => step.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(steps.every((step) => step.status === 'succeeded')).toBe(true);
    expect(steps[0]!.outputRefs).toMatchObject({ archivedCount: 1 });
    expect(steps[1]!.outputRefs).toMatchObject({ rowCount: 7 });

    // 7) 回放：只读 raw_fetch 重新抽取/规范化/校验，零差异且不写生产观测/定档/指标。
    const replay = await replayRun({
      db,
      storeRoot,
      originalRunId: summary.run.id,
      idempotencyKey: `p0-5-replay-${randomUUID()}`,
      gitSha: 'test-git-sha',
    });
    expect(replay.diffCount).toBe(0);
    expect(replay.compared).toBe(7);
    expect(replay.counts).toMatchObject({ validated: 7, isolated: 0, needsHuman: 0 });
    expect(await db.select().from(dbSchema.priceObservation).where(eq(dbSchema.priceObservation.runId, replay.run.id))).toHaveLength(0);
    expect(
      await db.select().from(dbSchema.dailyQuote).where(eq(dbSchema.dailyQuote.computationRunId, replay.run.id)),
    ).toHaveLength(0);
  });

  it('同幂等键重投复用既有 run，不重复采集/落观测', async () => {
    const before = await db.select().from(dbSchema.priceObservation);
    const again = await runFixturePipeline({
      db,
      storeRoot,
      adapters: createSourceRegistry({ stats: { snapshotPath: SNAPSHOT_PATH } }),
      sourceCodes: ['stats-cn'],
      allowedLicenses: ['GOV-STATS-ATTRIBUTION'],
      idempotencyKey: runKey,
      triggeredBy: 'test:p0-5',
    });
    expect(again.replayed).toBe(true);
    expect(again.run.id).toBe(summary.run.id);
    const after = await db.select().from(dbSchema.priceObservation);
    expect(after).toHaveLength(before.length);
  });

  it('合规闸门：未显式放行 GOV-STATS-ATTRIBUTION 时拒绝入管线并留异常', async () => {
    const blockedKey = `p0-5-license-${randomUUID()}`;
    const adapter = new StatsSourceAdapter({
      snapshotPath: SNAPSHOT_PATH,
      fetchedAt: new Date('2026-10-26T13:34:00Z'),
    });
    const blocked = await runFixturePipeline({
      db,
      storeRoot,
      adapters: new Map([['stats-cn', adapter]]),
      sourceCodes: ['stats-cn'],
      idempotencyKey: blockedKey,
      triggeredBy: 'test:p0-5-license',
    });
    expect(blocked.run.status).toBe('partial');
    expect(blocked.skippedSources).toEqual(['stats-cn']);
    expect(blocked.observationIds).toHaveLength(0);
    const exceptions = await db
      .select()
      .from(dbSchema.exceptionQueue)
      .where(and(eq(dbSchema.exceptionQueue.kind, 'source'), eq(dbSchema.exceptionQueue.status, 'open')));
    expect(exceptions.some((row) => row.summary.includes('GOV-STATS-ATTRIBUTION'))).toBe(true);
  });
});
