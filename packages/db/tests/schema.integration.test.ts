/**
 * 集成测试 —— P0-1 验收标准的机械化证明。
 *
 * 覆盖：
 *  A. 「同一品类同城不同价」可表达（验收 1）：同城不同市场、同市场不同价类型、同 key 不同来源，
 *     四条观测共存，互不覆盖；定档报价按 key 唯一。
 *  B. 原始存档不可变（验收 2 的底座）：raw_fetch 的 UPDATE/DELETE 被触发器拒绝。
 *  C. 观测值不可变：仅 validation_status/superseded_by_id 可改，值字段改动被拒绝（修正=新观测）。
 *  D. 校验通过必须规范化完整：validated 状态缺维度/规范值被 CHECK 拒绝。
 *  E. 地域层级守卫：观测/定档只准挂 market|city；加工指标只准挂 country|macro_region|city。
 *  F. 加工指标恒为聚合：is_aggregate=0 被 CHECK 拒绝（「全国均价」物理上不可能是观测值）。
 *  G. 映射 scope 约束：scope=source 必须带 source_id。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, dbSchema } from '../src/index';

const {
  category,
  specGrade,
  region,
  source,
  rawFetch,
  priceObservation,
  dailyQuote,
  derivedIndicator,
  unit,
  termMapping,
} = dbSchema;

const TEST_URL = process.env.BEE_TEST_DATABASE_URL ?? '';
const db = createDb(TEST_URL);
describe.skipIf(!TEST_URL)('schema 集成：分层不变量', () => {

/**
 * 断言一次写操作触发给定 pg 错误码。
 * drizzle 0.36+ 会用 DrizzleQueryError 包装底层 pg 错误，真实 code 在 cause 上；两种形态都接受。
 */
async function expectDbError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    expect(e.code ?? e.cause?.code).toBe(code);
    return;
  }
  expect.fail(`期望触发 pg 错误 ${code}，但操作成功了`);
}

const DAY = '2026-10-26';

async function insertFixture() {
  const [steelCat] = await db
    .insert(category)
    .values({ code: 't-steel', nameCn: '废钢', status: 'active' })
    .returning();
  const [heavySpec] = await db
    .insert(specGrade)
    .values({ categoryId: steelCat!.id, code: 'heavy', nameCn: '重废', status: 'active' })
    .returning();
  const [cn] = await db
    .insert(region)
    .values({ code: 't-cn', nameCn: '中国', level: 'country', status: 'active' })
    .returning();
  const [eastChina] = await db
    .insert(region)
    .values({ code: 't-east', nameCn: '华东', level: 'macro_region', parentId: cn!.id, status: 'active' })
    .returning();
  const [linyi] = await db
    .insert(region)
    .values({ code: 't-linyi', nameCn: '临沂', level: 'city', parentId: eastChina!.id, status: 'active' })
    .returning();
  const [eastMarket] = await db
    .insert(region)
    .values({ code: 't-linyi-east', nameCn: '临沂·东市场', level: 'market', parentId: linyi!.id, status: 'active' })
    .returning();
  const [westMarket] = await db
    .insert(region)
    .values({ code: 't-linyi-west', nameCn: '临沂·西市场', level: 'market', parentId: linyi!.id, status: 'active' })
    .returning();

  const sources = await db
    .insert(source)
    .values([
      { code: 't-src-1', name: '源一', type: 'webpage', baseUrl: 'https://a.example.com', trustWeight: '60.0', status: 'active', robotsStatus: 'allowed' },
      { code: 't-src-2', name: '源二', type: 'webpage', baseUrl: 'https://b.example.com', trustWeight: '70.0', status: 'active', robotsStatus: 'allowed' },
      { code: 't-src-3', name: '源三', type: 'webpage', baseUrl: 'https://c.example.com', trustWeight: '40.0', status: 'active', robotsStatus: 'allowed' },
    ])
    .returning();

  const fetches = await db
    .insert(rawFetch)
    .values(
      sources.map((s, i) => ({
        sourceId: s!.id,
        url: `https://${'abc'[i]}.example.com/price/2026-10-26`,
        fetchedAt: new Date(`2026-10-26T08:0${i}:00Z`),
        httpStatus: 200,
        contentSha256: String.fromCharCode(97 + i).repeat(64),
        contentRef: `raw/2026/10/26/${String.fromCharCode(97 + i)}.bin`,
        contentType: 'text/html',
        contentSizeBytes: 1024,
      })),
    )
    .returning();

  const [cnyTon] = await db
    .insert(unit)
    .values({ code: 't-CNY_per_ton', nameCn: '元/吨', isCanonical: 1 })
    .returning();

  return {
    steelCat: steelCat!,
    heavySpec: heavySpec!,
    eastChina: eastChina!,
    eastMarket: eastMarket!,
    westMarket: westMarket!,
    sources,
    fetches,
    unitId: cnyTon!.id,
  };
}

function observationFixture(args: {
  fetchId: string;
  sourceId: string;
  rowIndex: number;
  regionId: string;
  priceType: 'purchase' | 'sale';
  normValue: string;
  status: 'validated' | 'isolated' | 'normalized' | 'pending_mapping';
  categoryId: string;
  specId: string;
  unitId: string;
}) {
  return {
    fetchId: args.fetchId,
    sourceId: args.sourceId,
    fetchedAt: new Date('2026-10-26T08:00:00Z'),
    sourceRowIndex: args.rowIndex,
    rawText: args.normValue,
    rawValueLow: args.normValue,
    rawValueHigh: args.normValue,
    rawUnit: '元/吨',
    rawCategoryText: '废钢',
    rawSpecText: '重废',
    rawRegionText: '临沂',
    rawPriceTypeText: args.priceType === 'purchase' ? '采购价' : '销售价',
    categoryId: args.categoryId,
    specId: args.specId,
    regionId: args.regionId,
    priceType: args.priceType,
    normValueLow: args.normValue,
    normValueHigh: args.normValue,
    unitId: args.unitId,
    conversionApplied: { from: '元/吨', factor: 1 },
    quoteDate: DAY,
    validationStatus: args.status,
  };
}

  beforeEach(async () => {
  // 全量清库，每个用例自建自洽的夹具。
  await db.execute(
    `TRUNCATE TABLE price_observation, validation_result, daily_quote, derived_indicator, raw_fetch,
      agent_invocation, pipeline_step, pipeline_run, exception_queue, source_event, source_coverage, source,
      term_mapping, region_mapping, impurity_rule, unit_conversion, unit, spec_grade, category, region,
      caliber_decision RESTART IDENTITY CASCADE`,
  );
});

  it('A. 同一品类同城不同价可表达（验收 1）', async () => {
  const f = await insertFixture();
  const [s1, s2, s3] = f.sources;
  const [f1, f2, f3] = f.fetches;
  const base = { categoryId: f.steelCat.id, specId: f.heavySpec.id, unitId: f.unitId };

  // 四条观测：同 key 多源、同市场不同价类型、同城不同市场 —— 全部共存。
  const obs = await db
    .insert(priceObservation)
    .values([
      observationFixture({ ...base, fetchId: f1!.id, sourceId: s1!.id, rowIndex: 0, regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'validated' }),
      observationFixture({ ...base, fetchId: f1!.id, sourceId: s1!.id, rowIndex: 1, regionId: f.eastMarket.id, priceType: 'sale', normValue: '2260.00', status: 'validated' }),
      observationFixture({ ...base, fetchId: f2!.id, sourceId: s2!.id, rowIndex: 0, regionId: f.westMarket.id, priceType: 'purchase', normValue: '2180.00', status: 'validated' }),
      observationFixture({ ...base, fetchId: f3!.id, sourceId: s3!.id, rowIndex: 0, regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2250.00', status: 'isolated' }),
    ])
    .returning();

  expect(obs).toHaveLength(4);
  expect(obs.map((o) => o.normValueLow).sort()).toEqual(['2180.00', '2200.00', '2250.00', '2260.00']);
  // 同 key（废钢×重废×东市场×当日×采购）两个来源的两条观测并存。
  const sameKey = obs.filter((o) => o.regionId === f.eastMarket.id && o.priceType === 'purchase');
  expect(sameKey.map((o) => o.sourceId).sort()).toEqual([s1!.id, s3!.id].sort());

  // 定档：三个不同 key 各成一行。
  await db.insert(dailyQuote).values([
    {
      categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.eastMarket.id, quoteDate: DAY, priceType: 'purchase',
      valueLow: '2200.00', valueHigh: '2200.00', valueMid: '2200.00', method: 'single_source',
      contributingObservationIds: [obs[0]!.id], sourceCount: 1, methodVersion: 'v1',
      confidence: 'medium', status: 'published',
    },
    {
      categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.eastMarket.id, quoteDate: DAY, priceType: 'sale',
      valueLow: '2260.00', valueHigh: '2260.00', valueMid: '2260.00', method: 'single_source',
      contributingObservationIds: [obs[1]!.id], sourceCount: 1, methodVersion: 'v1',
      confidence: 'medium', status: 'published',
    },
    {
      categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.westMarket.id, quoteDate: DAY, priceType: 'purchase',
      valueLow: '2180.00', valueHigh: '2180.00', valueMid: '2180.00', method: 'single_source',
      contributingObservationIds: [obs[2]!.id], sourceCount: 1, methodVersion: 'v1',
      confidence: 'medium', status: 'published',
    },
  ]);

  // 同 key 的第二条定档被唯一约束拒绝：主键语义（品类×规格×地域×日期×价类型）由 DB 强制。
  await expectDbError(
    db.insert(dailyQuote).values({
      categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.eastMarket.id, quoteDate: DAY, priceType: 'purchase',
      valueLow: '2210.00', valueHigh: '2210.00', valueMid: '2210.00', method: 'single_source',
      contributingObservationIds: [obs[3]!.id], sourceCount: 1, methodVersion: 'v1',
    }),
    '23505',
  );

  // 全国加工指标：挂大区层级、is_aggregate 恒 1，方法快照固化权重。
  const national = await db
    .insert(derivedIndicator)
    .values({
      kind: 'national_weighted_avg',
      categoryId: f.steelCat.id,
      specId: f.heavySpec.id,
      regionId: f.eastChina.id,
      priceType: 'purchase',
      basisDate: DAY,
      value: '2213.33',
      methodJson: {
        formula: '加权平均',
        note: '按各市场当日 validated 定档价加权（权重为示意）',
        weights: { [f.eastMarket.id]: 0.6, [f.westMarket.id]: 0.4 },
      },
      methodVersion: 'v1',
      contributingQuoteIds: [],
    })
    .returning();
  expect(national[0]!.isAggregate).toBe(1);
});

  it('B. 原始抓取存档不可变（WORM）', async () => {
  const f = await insertFixture();
  const [fetch1] = f.fetches;
  await expectDbError(
    db.execute(`UPDATE raw_fetch SET url = 'https://tampered.example.com' WHERE id = '${fetch1!.id}'`),
    'P0001',
  );
  await expectDbError(db.execute(`DELETE FROM raw_fetch WHERE id = '${fetch1!.id}'`), 'P0001');
});

  it('C. 观测值不可变，仅状态可流转', async () => {
  const f = await insertFixture();
  const [fetch1] = f.fetches;
  const [obs] = await db
    .insert(priceObservation)
    .values(
      observationFixture({
        categoryId: f.steelCat.id, specId: f.heavySpec.id, unitId: f.unitId,
        fetchId: fetch1!.id, sourceId: f.sources[0]!.id, rowIndex: 0,
        regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'normalized',
      }),
    )
    .returning();

  // 改值 → 拒绝（修正必须走新观测 + supersede 链）。
  await expectDbError(
    db.execute(`UPDATE price_observation SET norm_value_low = '9999.00' WHERE id = '${obs!.id}'`),
    'P0001',
  );
  // 删除 → 拒绝。
  await expectDbError(db.execute(`DELETE FROM price_observation WHERE id = '${obs!.id}'`), 'P0001');
  // 状态流转 → 允许。
  await db.execute(`UPDATE price_observation SET validation_status = 'isolated' WHERE id = '${obs!.id}'`);
  const [after] = await db
    .select({ status: priceObservation.validationStatus })
    .from(priceObservation)
    .where(eq(priceObservation.id, obs!.id));
  expect(after!.status).toBe('isolated');
});

  it('D. validated 必须规范化完整', async () => {
  const f = await insertFixture();
  const [fetch1] = f.fetches;
  await expectDbError(
    db.insert(priceObservation).values({
      fetchId: fetch1!.id, sourceId: f.sources[0]!.id, fetchedAt: new Date('2026-10-26T08:00:00Z'), sourceRowIndex: 9,
      rawText: '2200', rawCategoryText: '废钢', validationStatus: 'validated',
      // 缺 region/spec/norm 值 → CHECK 拒绝
      categoryId: f.steelCat.id, quoteDate: DAY,
    }),
    '23514',
  );
});

  it('E. 地域层级守卫', async () => {
  const f = await insertFixture();
  const [fetch1] = f.fetches;

  // 观测挂大区层级 → 触发器拒绝（来源发什么粒度记什么粒度，不许升格）。
  await expectDbError(
    db.insert(priceObservation).values({
      fetchId: fetch1!.id, sourceId: f.sources[0]!.id, fetchedAt: new Date('2026-10-26T08:00:00Z'), sourceRowIndex: 0,
      rawText: '2200', rawCategoryText: '废钢', regionId: f.eastChina.id,
    }),
    'P0001',
  );

  // 定档挂大区层级 → 拒绝。
  await expectDbError(
    db.insert(dailyQuote).values({
      categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.eastChina.id, quoteDate: DAY, priceType: 'purchase',
      valueLow: '2200.00', valueHigh: '2200.00', valueMid: '2200.00', method: 'single_source',
      contributingObservationIds: [], sourceCount: 1, methodVersion: 'v1',
    }),
    'P0001',
  );

  // 加工指标挂 market 层级 → 拒绝（聚合只存在于 city 及以上）。
  await expectDbError(
    db.insert(derivedIndicator).values({
      kind: 'city_aggregate', categoryId: f.steelCat.id, regionId: f.eastMarket.id, priceType: 'purchase',
      basisDate: DAY, value: '2200.00', methodJson: { formula: '加权平均' }, methodVersion: 'v1',
      contributingQuoteIds: [],
    }),
    'P0001',
  );
});

  it('F. 加工指标恒为聚合（「全国均价」不可能是观测值）', async () => {
  const f = await insertFixture();
  await expectDbError(
    db.insert(derivedIndicator).values({
      kind: 'national_median', categoryId: f.steelCat.id, regionId: f.eastChina.id, priceType: 'purchase',
      basisDate: DAY, value: '2200.00', methodJson: { formula: '中位数' }, methodVersion: 'v1',
      contributingQuoteIds: [], isAggregate: 0,
    }),
    '23514',
  );
});

  it('G. 来源专属映射必须绑定来源', async () => {
  const f = await insertFixture();
  await expectDbError(
    db.insert(termMapping).values({
      scope: 'source', sourceId: null, rawCategoryText: '干净料', categoryId: f.steelCat.id, status: 'proposed',
    }),
    '23514',
  );
});
});
