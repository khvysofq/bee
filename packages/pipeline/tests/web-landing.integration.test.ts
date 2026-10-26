/**
 * P0-6 落地页数据加载集成测试（GUA-26）：fixture 管线跑通后，loadLandingData 的
 * 每一个页面数字都必须能在 daily_quote 里按 id 回查到 —— 落地页没有手写价格。
 *
 * 隔离策略：本文件自建独立库 bee_test_web_landing（迁移 → 种子 → 管线），不共享 bee_test ——
 * 原始存档是内容寻址的本地文件，复用别的文件跑过的库会指向已被清理的 storeRoot（ENOENT），
 * 独立库同时让断言可以精确（库里只有本文件写入的数据）。文件排序仍在 pipeline 组最后，
 * 不改变既有测试的任何前置状态。
 *
 * loadLandingData 位于 apps/web（跨包相对导入）：它复用 P0-4 loadBriefing 查询逻辑，
 * 只读 daily_quote / derived_indicator / 字典表，不写库。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, dbSchema, type BeeDb } from '@bee/db';
import { runFixturePipeline } from '../src';
import { seedPipelineDictionaries } from './helpers/seed';
import { loadLandingData, pickRepresentative, TREND_WINDOW_DAYS } from '../../../apps/web/src/lib/landing-data';
import type { BriefingQuote } from '../../../apps/web/src/lib/briefing-data';

const BASE_URL = process.env.BEE_TEST_DATABASE_URL ?? '';
const LANDING_DB = 'bee_test_web_landing';
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../db/migrations', import.meta.url));

function rewriteDb(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describe.skipIf(!BASE_URL)('P0-6 落地页数据加载（loadLandingData）', () => {
  let db: BeeDb;
  let admin: BeeDb;
  let storeRoot = '';

  beforeAll(async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), 'bee-p0-6-'));
    admin = createDb(rewriteDb(BASE_URL, 'postgres'));
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${LANDING_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${LANDING_DB}`));
    db = createDb(rewriteDb(BASE_URL, LANDING_DB));
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    await seedPipelineDictionaries(db);
    const summary = await runFixturePipeline({
      db,
      storeRoot,
      idempotencyKey: `p0-6-landing-${randomUUID()}`,
      triggeredBy: 'test',
      gitSha: 'test-git-sha',
    });
    expect(summary.run.status).toBe('succeeded');
  });

  afterAll(async () => {
    await db?.$client.end();
    await admin?.execute(sql.raw(`DROP DATABASE IF EXISTS ${LANDING_DB} WITH (FORCE)`));
    await admin?.$client.end();
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('5 品类卡片数据全部来自 daily_quote：代表报价/涨跌/走势与库内定档逐数一致', async () => {
    const data = await loadLandingData(db);

    expect(data.empty).toBe(false);
    expect(data.latestQuoteDate).toBe('2026-10-26');
    expect(data.hasFixtureSource).toBe(true);
    expect(data.hasStatsSource).toBe(false);
    expect(data.stats.categoryCount).toBe(5);
    expect(data.stats.categoriesWithQuotes).toBe(5);
    // 最新定档日已发布 9 条：废钢3（重废采购/中废采购/重废销售）+ 废铜1 + 废铝1 + 废纸2 + 废塑料2。
    expect(data.stats.quoteCount).toBe(9);
    expect(TREND_WINDOW_DAYS).toBeGreaterThanOrEqual(7);
    expect(TREND_WINDOW_DAYS).toBeLessThanOrEqual(14);

    expect(data.categories.map((category) => category.code)).toEqual([
      'scrap-steel',
      'scrap-copper',
      'scrap-aluminum',
      'waste-paper',
      'waste-plastic',
    ]);

    for (const category of data.categories) {
      const quote = category.representative;
      expect(quote, `${category.code} 应有最新定档日的代表报价`).toBeTruthy();
      expect(quote!.quoteDate).toBe(data.latestQuoteDate);
      expect(quote!.sources.length).toBeGreaterThan(0);

      // 硬约束验证：主价按 id 回查 daily_quote，页面数字与库内已发布定档完全一致（非硬编码）。
      const [row] = await db
        .select()
        .from(dbSchema.dailyQuote)
        .where(eq(dbSchema.dailyQuote.id, quote!.id));
      expect(row, `代表报价 ${quote!.id} 必须真实存在于 daily_quote`).toBeTruthy();
      expect(row!.status).toBe('published');
      expect(row!.quoteDate).toBe(data.latestQuoteDate);
      expect(quote!.valueMid).toBe(Number(row!.valueMid));
      expect(quote!.valueLow).toBe(Number(row!.valueLow));
      expect(quote!.valueHigh).toBe(Number(row!.valueHigh));
      expect(quote!.valueMid).toBeGreaterThanOrEqual(quote!.valueLow);
      expect(quote!.valueMid).toBeLessThanOrEqual(quote!.valueHigh);

      // 走势序列 = 同口径已发布定档，升序、末点即卡片主价、窗口不超过 TREND_WINDOW_DAYS。
      expect(category.trend.length).toBeGreaterThan(0);
      expect(category.trend.length).toBeLessThanOrEqual(TREND_WINDOW_DAYS);
      const dates = category.trend.map((point) => point.date);
      expect(dates).toEqual([...dates].sort());
      expect(dates[dates.length - 1]).toBe(quote!.quoteDate);
      expect(category.trend[category.trend.length - 1]!.value).toBe(quote!.valueMid);
      expect(category.latestQuoteCount).toBeGreaterThan(0);
    }
  });

  it('废钢卡片：代表报价选有可比历史的采购价口径，日/周涨跌与走势是真实计算值', async () => {
    const data = await loadLandingData(db);
    const steel = data.categories.find((category) => category.code === 'scrap-steel')!;
    const quote = steel.representative!;

    // fixture 里只有「重废·苏州·采购价」有跨日历史（10-19/10-25/10-26），代表口径必须能反映涨跌。
    expect(quote.specName).toBe('重废');
    expect(quote.regionName).toBe('苏州');
    expect(quote.priceType).toBe('purchase');
    expect(quote.valueMid).toBe(2387.5);

    // 日涨跌 = (2387.5 - 2365) / 2365，周涨跌 = (2387.5 - 2335) / 2335：与简报同一套计算。
    expect(quote.dailyChange).toMatchObject({ quoteDate: '2026-10-25', previousValue: 2365, pct: 0.95 });
    expect(quote.weeklyChange).toMatchObject({ quoteDate: '2026-10-19', previousValue: 2335, pct: 2.25 });

    expect(steel.trend).toEqual([
      { date: '2026-10-19', value: 2335 },
      { date: '2026-10-25', value: 2365 },
      { date: '2026-10-26', value: 2387.5 },
    ]);

    // 单报价品类：废铜/废铝最新日只有一条定档，走势只有末点，无可比历史时缺失不当作持平。
    const copper = data.categories.find((category) => category.code === 'scrap-copper')!;
    expect(copper.representative!.valueMid).toBe(68600);
    expect(copper.trend).toEqual([{ date: '2026-10-26', value: 68600 }]);
    expect(copper.representative!.dailyChange).toBeNull();
    expect(copper.representative!.weeklyChange).toBeNull();

    // 多报价品类（废纸/废塑料）：代表报价口径确定性落在最新日采购价集合内。
    for (const code of ['waste-paper', 'waste-plastic']) {
      const category = data.categories.find((candidate) => candidate.code === code)!;
      expect(category.representative!.priceType).toBe('purchase');
      expect(category.latestQuoteCount).toBe(2);
    }
  });

  it('pickRepresentative 口径：只取最新定档日，优先采购价，其次有可比涨跌者，空集返回 null', () => {
    const makeQuote = (overrides: Partial<BriefingQuote>): BriefingQuote =>
      ({
        id: 'q',
        categoryId: 'c',
        categoryName: '废钢',
        specName: '重废',
        regionName: '苏州',
        regionLevel: 'city',
        quoteDate: '2026-10-26',
        priceType: 'purchase',
        valueLow: 0,
        valueHigh: 0,
        valueMid: 0,
        method: 'single_source',
        methodVersion: 'v1',
        confidence: 'high',
        coverageNote: null,
        status: 'published',
        fetchedFrom: null,
        fetchedTo: null,
        sources: [],
        previousTradingDay: null,
        weekAgo: null,
        ...overrides,
      }) as BriefingQuote;

    expect(pickRepresentative([], '2026-10-26')).toBeNull();

    // 旬报锚点（旧日期）在存在最新日报价时不能当选「今日行情」。
    const anchor = makeQuote({ id: 'anchor', quoteDate: '2026-10-20' });
    const latestSale = makeQuote({ id: 'sale', priceType: 'sale' });
    expect(pickRepresentative([anchor, latestSale], '2026-10-26')!.id).toBe('sale');

    // 同为最新日采购价：有上一交易日可比值者优先（卡片能真实呈现涨跌）。
    const noHistory = makeQuote({ id: 'no-history', specName: '中废' });
    const withHistory = makeQuote({
      id: 'with-history',
      previousTradingDay: { quoteDate: '2026-10-25', previousValue: 2365, pct: 0.95 },
    });
    expect(pickRepresentative([noHistory, withHistory], '2026-10-26')!.id).toBe('with-history');

    // 只有采购价缺席时才退到其他价类型。
    expect(pickRepresentative([latestSale], '2026-10-26')!.id).toBe('sale');
  });
});
