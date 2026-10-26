/**
 * 集成测试 —— P0-1 验收标准的机械化证明 + DAW-33 评审修复（P0 1–4 / P1 5–7）的回归锁。
 *
 * 测试纪律（与库的不可变承诺一致）：
 *  - 不 TRUNCATE、不 DELETE 清库 —— 库本身有守卫触发器，这正是被测对象；
 *    测试库 bee_test 由 global-setup 每次运行整体重建，测试只做追加写。
 *  - 每个用例用唯一前缀自建夹具（code 类唯一列互不碰撞）；country / unit 两行
 *    全库共享（country 单根、canonical 单位本身是唯一约束）。
 *
 * 覆盖：
 *  A. 「同一品类同城不同价」可表达（验收 1）+ 定档 key 唯一 + 全国指标挂 country + 贡献明细。
 *  B. 原始存档 WORM：UPDATE/DELETE 拒绝；TRUNCATE 拒绝（DAW-33 P0-1 回归 —— 0000 只挡行级操作）。
 *  C. 观测值不可变：仅 validation_status/superseded_by_id 可改。
 *  D. validated 必须规范化完整（CHECK）。
 *  E. 地域层级守卫：观测/定档只准 market|city；指标 kind↔层级绑定（DAW-33 P0-3）。
 *  F. 加工指标恒为聚合（is_aggregate=0 被 CHECK 拒绝）。
 *  G. 映射 scope 约束：scope=source 必须带 source_id。
 *  H. 修正链（DAW-33 P0-2）：同 fetch 同行 revision 递增合法写入、supersede 指针规则。
 *  I. region 树（DAW-33 P0-3）：阶梯防插错、country 单根、被引用 region 冻结。
 *  J. 指标贡献明细（DAW-33 P0-4）：维度一致、写定冻结、非空、重算事务、指标维度冻结/禁删。
 *  K. 外键补洞（DAW-33 P1-5）：复合外键与断链 FK 全部拒绝伪造归属。
 *  L. 映射确定性（DAW-33 P1-6）：active 唯一部分索引。
 *  M. run/step 台账（DAW-33 P1-7）：seq 唯一、状态机、终态冻结、append-only、幂等键。
 *  N. 字典 CHECK：换算系数>0、单 canonical、active 来源须 robots allowed、杂质规则期间合法。
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb, dbSchema } from '../src/index';

const {
  category,
  specGrade,
  region,
  source,
  sourceCoverage,
  rawContent,
  rawFetch,
  priceObservation,
  dailyQuote,
  derivedIndicator,
  indicatorContribution,
  unit,
  unitConversion,
  termMapping,
  regionMapping,
  impurityRule,
  agentInvocation,
  pipelineRun,
  pipelineStep,
  validationResult,
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

  /**
   * 断言操作被数据库拒绝（TRUNCATE 场景）：带入站外键的表 PG 会先抛 0A000
   * （cannot truncate a table referenced in a foreign key constraint），无外键引用的
   * 表才轮到守卫触发器 P0001。回归点是「被挡住」，两种形态都算防住。
   */
  async function expectBlocked(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      expect(['P0001', '0A000']).toContain(e.code ?? e.cause?.code);
      return;
    }
    expect.fail('期望 TRUNCATE 被拒绝，但清库成功了 —— WORM 被 TRUNCATE 绕过');
  }

  const DAY = '2026-10-26';
  const T0 = new Date('2026-10-26T08:00:00Z');

  /**
   * 全库共享的行：country 单根（briefing 套件的 seed 先跑会种下 `cn`，单跑本文件时则自建
   * `t-cn`——两种起点都要成立）+ 单位（canonical 唯一性是全局约束，不能每用例各造一份）。
   */
  async function ensureSingletons() {
    await db
      .insert(unit)
      .values({ code: 't-unit-ton', nameCn: '元/吨', isCanonical: 0 })
      .onConflictDoNothing({ target: unit.code });
    const [unitRow] = await db.select().from(unit).where(eq(unit.code, 't-unit-ton'));

    // country 单根：库里有 country（seed 过）就复用；否则自建。
    const [existing] = await db.select().from(region).where(eq(region.level, 'country')).limit(1);
    let cnId = existing?.id;
    if (!cnId) {
      await db
        .insert(region)
        .values({ code: 't-cn', nameCn: '中国', level: 'country', status: 'active' })
        .onConflictDoNothing({ target: region.code });
      const [cn] = await db.select().from(region).where(eq(region.code, 't-cn'));
      cnId = cn!.id;
    }
    return { cnId: cnId!, unitId: unitRow!.id };
  }

  /** 每用例自建夹具（p 为本用例唯一前缀）。 */
  async function insertFixture(p: string) {
    const { cnId, unitId } = await ensureSingletons();

    const [steelCat] = await db
      .insert(category)
      .values({ code: `${p}-steel`, nameCn: '废钢', status: 'active' })
      .returning();
    const [heavySpec] = await db
      .insert(specGrade)
      .values({ categoryId: steelCat!.id, code: 'heavy', nameCn: '重废', status: 'active' })
      .returning();
    const [eastChina] = await db
      .insert(region)
      .values({ code: `${p}-east`, nameCn: '华东', level: 'macro_region', parentId: cnId, status: 'active' })
      .returning();
    const [linyi] = await db
      .insert(region)
      .values({ code: `${p}-linyi`, nameCn: '临沂', level: 'city', parentId: eastChina!.id, status: 'active' })
      .returning();
    const [eastMarket] = await db
      .insert(region)
      .values({ code: `${p}-linyi-east`, nameCn: '临沂·东市场', level: 'market', parentId: linyi!.id, status: 'active' })
      .returning();
    const [westMarket] = await db
      .insert(region)
      .values({ code: `${p}-linyi-west`, nameCn: '临沂·西市场', level: 'market', parentId: linyi!.id, status: 'active' })
      .returning();

    const sources = await db
      .insert(source)
      .values([
        { code: `${p}-src-1`, name: '源一', type: 'webpage', baseUrl: 'https://a.example.com', trustWeight: '60.0', status: 'active', robotsStatus: 'allowed' },
        { code: `${p}-src-2`, name: '源二', type: 'webpage', baseUrl: 'https://b.example.com', trustWeight: '70.0', status: 'active', robotsStatus: 'allowed' },
        { code: `${p}-src-3`, name: '源三', type: 'webpage', baseUrl: 'https://c.example.com', trustWeight: '40.0', status: 'active', robotsStatus: 'allowed' },
      ])
      .returning();

    // 内容寻址：先登记内容对象，再登记抓取事件（同内容可被多次抓取）。
    const contents = await db
      .insert(rawContent)
      .values(
        [0, 1, 2].map((i) => ({
          contentSha256: `${p}-${i}`.padEnd(64, '0'),
          contentRef: `raw/2026/10/26/${p}-${i}.bin`,
        })),
      )
      .returning();
    const fetches = await db
      .insert(rawFetch)
      .values(
        sources.map((s, i) => ({
          sourceId: s!.id,
          url: `https://${'abc'[i]}.example.com/price/2026-10-26`,
          fetchedAt: new Date(`2026-10-26T08:0${i}:00Z`),
          httpStatus: 200,
          contentSha256: contents[i]!.contentSha256,
          contentType: 'text/html',
          contentSizeBytes: 1024,
        })),
      )
      .returning();

    return {
      cnId,
      unitId,
      steelCat: steelCat!,
      heavySpec: heavySpec!,
      eastChina: eastChina!,
      linyi: linyi!,
      eastMarket: eastMarket!,
      westMarket: westMarket!,
      sources,
      fetches,
    };
  }

  function observationFixture(args: {
    fetchId: string;
    sourceId: string;
    fetchedAt: Date;
    rowIndex: number;
    revision?: number;
    regionId: string;
    priceType: 'purchase' | 'sale';
    normValue: string;
    status: 'validated' | 'isolated' | 'normalized' | 'pending_mapping' | 'superseded';
    categoryId: string;
    specId: string;
    unitId: string;
    quoteDate?: string;
  }) {
    return {
      fetchId: args.fetchId,
      sourceId: args.sourceId,
      fetchedAt: args.fetchedAt,
      sourceRowIndex: args.rowIndex,
      revision: args.revision ?? 1,
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
      quoteDate: args.quoteDate ?? DAY,
      validationStatus: args.status,
    };
  }

  /** 一条可参与定档的 validated 观测（全维度齐备）。 */
  async function insertValidatedObservation(f: Awaited<ReturnType<typeof insertFixture>>, rowIndex: number, value: string) {
    const [obs] = await db
      .insert(priceObservation)
      .values(
        observationFixture({
          fetchId: f.fetches[0]!.id,
          sourceId: f.sources[0]!.id,
          fetchedAt: T0,
          rowIndex,
          regionId: f.eastMarket.id,
          priceType: 'purchase',
          normValue: value,
          status: 'validated',
          categoryId: f.steelCat.id,
          specId: f.heavySpec.id,
          unitId: f.unitId,
        }),
      )
      .returning();
    return obs!;
  }

  /** 一条挂 market 层级的已定档报价（引用 validated 观测）。 */
  async function insertQuote(f: Awaited<ReturnType<typeof insertFixture>>, obsId: string, value: string, priceType: 'purchase' | 'sale' = 'purchase') {
    const [q] = await db
      .insert(dailyQuote)
      .values({
        categoryId: f.steelCat.id,
        specId: f.heavySpec.id,
        regionId: f.eastMarket.id,
        quoteDate: DAY,
        priceType,
        valueLow: value,
        valueHigh: value,
        valueMid: value,
        method: 'single_source',
        contributingObservationIds: [obsId],
        sourceCount: 1,
        methodVersion: 'v1',
      })
      .returning();
    return q!;
  }

  // ------------------------------------------------------------------

  it('A. 同一品类同城不同价可表达；全国指标挂 country 并落贡献明细', async () => {
    const f = await insertFixture('a');
    const [s1, s2, s3] = f.sources;
    const [f1, f2, f3] = f.fetches;
    const base = { categoryId: f.steelCat.id, specId: f.heavySpec.id, unitId: f.unitId };

    // 四条观测：同 key 多源、同市场不同价类型、同城不同市场 —— 全部共存。
    const obs = await db
      .insert(priceObservation)
      .values([
        observationFixture({ ...base, fetchId: f1!.id, sourceId: s1!.id, fetchedAt: new Date('2026-10-26T08:00:00Z'), rowIndex: 0, regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'validated' }),
        observationFixture({ ...base, fetchId: f1!.id, sourceId: s1!.id, fetchedAt: new Date('2026-10-26T08:00:00Z'), rowIndex: 1, regionId: f.eastMarket.id, priceType: 'sale', normValue: '2260.00', status: 'validated' }),
        observationFixture({ ...base, fetchId: f2!.id, sourceId: s2!.id, fetchedAt: new Date('2026-10-26T08:01:00Z'), rowIndex: 0, regionId: f.westMarket.id, priceType: 'purchase', normValue: '2180.00', status: 'validated' }),
        observationFixture({ ...base, fetchId: f3!.id, sourceId: s3!.id, fetchedAt: new Date('2026-10-26T08:02:00Z'), rowIndex: 0, regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2250.00', status: 'isolated' }),
      ])
      .returning();

    expect(obs).toHaveLength(4);
    // 同 key（废钢×重废×东市场×当日×采购）两个来源的两条观测并存。
    const sameKey = obs.filter((o) => o.regionId === f.eastMarket.id && o.priceType === 'purchase');
    expect(sameKey.map((o) => o.sourceId).sort()).toEqual([s1!.id, s3!.id].sort());

    // 定档：三个不同 key 各成一行。
    const quotes = await db
      .insert(dailyQuote)
      .values([
        {
          categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.eastMarket.id, quoteDate: DAY, priceType: 'purchase',
          valueLow: '2200.00', valueHigh: '2200.00', valueMid: '2200.00', method: 'single_source',
          contributingObservationIds: [obs[0]!.id], sourceCount: 1, methodVersion: 'v1',
        },
        {
          categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.eastMarket.id, quoteDate: DAY, priceType: 'sale',
          valueLow: '2260.00', valueHigh: '2260.00', valueMid: '2260.00', method: 'single_source',
          contributingObservationIds: [obs[1]!.id], sourceCount: 1, methodVersion: 'v1',
        },
        {
          categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.westMarket.id, quoteDate: DAY, priceType: 'purchase',
          valueLow: '2180.00', valueHigh: '2180.00', valueMid: '2180.00', method: 'single_source',
          contributingObservationIds: [obs[2]!.id], sourceCount: 1, methodVersion: 'v1',
        },
      ])
      .returning();
    expect(quotes).toHaveLength(3);

    // 同 key 的第二条定档被唯一约束拒绝。
    await expectDbError(
      db.insert(dailyQuote).values({
        categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.eastMarket.id, quoteDate: DAY, priceType: 'purchase',
        valueLow: '2210.00', valueHigh: '2210.00', valueMid: '2210.00', method: 'single_source',
        contributingObservationIds: [obs[3]!.id], sourceCount: 1, methodVersion: 'v1',
      }),
      '23505',
    );

    // 全国加工指标：national_* 只准挂 country 层级（kind↔层级绑定），贡献明细同事务落库。
    let indicatorId = '';
    await db.transaction(async (tx) => {
      const [national] = await tx
        .insert(derivedIndicator)
        .values({
          kind: 'national_weighted_avg',
          categoryId: f.steelCat.id,
          specId: f.heavySpec.id,
          regionId: f.cnId,
          priceType: 'purchase',
          basisDate: DAY,
          value: '2192.00',
          methodJson: {
            formula: '加权平均',
            note: '按各市场当日 validated 定档价加权（权重为示意）',
            weights: { [f.eastMarket.id]: 0.6, [f.westMarket.id]: 0.4 },
          },
          methodVersion: 'v1',
        })
        .returning();
      indicatorId = national!.id;
      await tx.insert(indicatorContribution).values([
        { indicatorId: national!.id, quoteId: quotes[0]!.id, valueAtAggregation: '2200.00', weight: '0.600000' },
        { indicatorId: national!.id, quoteId: quotes[2]!.id, valueAtAggregation: '2180.00', weight: '0.400000' },
      ]);
    });
    const contributions = await db.select().from(indicatorContribution).where(eq(indicatorContribution.indicatorId, indicatorId));
    expect(contributions).toHaveLength(2);

    // 同一 (indicator, quote) 二次贡献 → 唯一拒绝（去重由 DB 强制）。
    await expectDbError(
      db.insert(indicatorContribution).values({ indicatorId, quoteId: quotes[0]!.id, valueAtAggregation: '2200.00' }),
      '23505',
    );
    // 聚合时值快照必须落在 quote 区间内。
    await expectDbError(
      db.insert(indicatorContribution).values({ indicatorId, quoteId: quotes[0]!.id, valueAtAggregation: '9999.00' }),
      'P0001',
    );

    // 定档发布（状态流转触发延迟复检，引用的都是 validated 观测 → 通过）。
    await db.update(dailyQuote).set({ status: 'published', publishedAt: new Date() }).where(eq(dailyQuote.id, quotes[0]!.id));
  });

  it('B. 原始存档不可变（WORM + TRUNCATE）', async () => {
    const f = await insertFixture('b');
    const [fetch1] = f.fetches;
    await expectDbError(
      db.execute(`UPDATE raw_fetch SET url = 'https://tampered.example.com' WHERE id = '${fetch1!.id}'`),
      'P0001',
    );
    await expectDbError(db.execute(`DELETE FROM raw_fetch WHERE id = '${fetch1!.id}'`), 'P0001');
    // 内容对象同样 WORM。
    const contentSha = `${'b'}-0`.padEnd(64, '0');
    await expectDbError(db.execute(`UPDATE raw_content SET content_ref = 'x' WHERE content_sha256 = '${contentSha}'`), 'P0001');
    await expectDbError(db.execute(`DELETE FROM raw_content WHERE content_sha256 = '${contentSha}'`), 'P0001');
    // TRUNCATE 绕过已被堵死（DAW-33 P0-1 回归：0000 的行级守卫不拦 TRUNCATE）。
    // validation_result 无入站外键 → 由守卫触发器本体拦截（P0001）。
    await expectDbError(db.execute('TRUNCATE TABLE validation_result'), 'P0001');
    // 带入站外键的表（raw_fetch）→ PG 外键机制先挡（0A000）；无论哪层，清库不可能发生。
    await expectBlocked(db.execute('TRUNCATE TABLE raw_fetch'));
    // 旧测试的 beforeEach 清库写法（CASCADE 整组清）—— 修复前这个语句就是绕过路径，现在被拒。
    await expectBlocked(
      db.execute(
        `TRUNCATE TABLE price_observation, validation_result, daily_quote, derived_indicator, raw_fetch,
          agent_invocation, pipeline_step, pipeline_run RESTART IDENTITY CASCADE`,
      ),
    );
  });

  it('C. 观测值不可变，仅状态可流转', async () => {
    const f = await insertFixture('c');
    const obs = await insertValidatedObservation(f, 0, '2200.00');

    await expectDbError(
      db.execute(`UPDATE price_observation SET norm_value_low = '9999.00' WHERE id = '${obs.id}'`),
      'P0001',
    );
    await expectDbError(db.execute(`DELETE FROM price_observation WHERE id = '${obs.id}'`), 'P0001');
    await db.update(priceObservation).set({ validationStatus: 'isolated' }).where(eq(priceObservation.id, obs.id));
    const [after] = await db
      .select({ status: priceObservation.validationStatus })
      .from(priceObservation)
      .where(eq(priceObservation.id, obs.id));
    expect(after!.status).toBe('isolated');
  });

  it('D. validated 必须规范化完整', async () => {
    const f = await insertFixture('d');
    await expectDbError(
      db.insert(priceObservation).values({
        fetchId: f.fetches[0]!.id, sourceId: f.sources[0]!.id, fetchedAt: T0, sourceRowIndex: 9,
        rawText: '2200', rawCategoryText: '废钢', validationStatus: 'validated',
        categoryId: f.steelCat.id, quoteDate: DAY,
      }),
      '23514',
    );
  });

  it('E. 地域层级守卫 + 指标 kind↔层级绑定', async () => {
    const f = await insertFixture('e');

    // 观测挂大区层级 → 拒绝（来源发什么粒度记什么粒度，不许升格）。
    await expectDbError(
      db.insert(priceObservation).values({
        fetchId: f.fetches[0]!.id, sourceId: f.sources[0]!.id, fetchedAt: T0, sourceRowIndex: 0,
        rawText: '2200', rawCategoryText: '废钢', regionId: f.eastChina.id,
      }),
      'P0001',
    );

    // 定档挂大区层级 → 拒绝。
    await expectDbError(
      db.insert(dailyQuote).values({
        categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.eastChina.id, quoteDate: DAY, priceType: 'purchase',
        valueLow: '2200.00', valueHigh: '2200.00', valueMid: '2200.00', method: 'single_source',
        contributingObservationIds: [await insertValidatedObservation(f, 0, '2200.00').then((o) => o.id)], sourceCount: 1, methodVersion: 'v1',
      }),
      'P0001',
    );

    // 指标：national_* 挂大区 → 拒绝（只准 country）；city_aggregate 挂市场 → 拒绝（只准 city）。
    await expectDbError(
      db.insert(derivedIndicator).values({
        kind: 'national_weighted_avg', categoryId: f.steelCat.id, regionId: f.eastChina.id, priceType: 'purchase',
        basisDate: DAY, value: '2200.00', methodJson: { formula: '加权平均' }, methodVersion: 'v1',
      }),
      'P0001',
    );
    await expectDbError(
      db.insert(derivedIndicator).values({
        kind: 'city_aggregate', categoryId: f.steelCat.id, regionId: f.eastMarket.id, priceType: 'purchase',
        basisDate: DAY, value: '2200.00', methodJson: { formula: '加权平均' }, methodVersion: 'v1',
      }),
      'P0001',
    );

    // 正向：city_aggregate 挂 city + market 层报价的贡献（同事务提交，非空约束满足）。
    const obs = await insertValidatedObservation(f, 1, '2200.00');
    const quote = await insertQuote(f, obs.id, '2200.00');
    let ok = false;
    await db.transaction(async (tx) => {
      const [cityAgg] = await tx
        .insert(derivedIndicator)
        .values({
          kind: 'city_aggregate', categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.linyi.id, priceType: 'purchase',
          basisDate: DAY, value: '2200.00', methodJson: { formula: '加权平均' }, methodVersion: 'v1',
        })
        .returning();
      await tx.insert(indicatorContribution).values({ indicatorId: cityAgg!.id, quoteId: quote.id, valueAtAggregation: '2200.00' });
      ok = true;
    });
    expect(ok).toBe(true);
  });

  it('F. 加工指标恒为聚合（「全国均价」不可能是观测值）', async () => {
    const f = await insertFixture('f');
    await expectDbError(
      db.insert(derivedIndicator).values({
        kind: 'national_median', categoryId: f.steelCat.id, regionId: f.cnId, priceType: 'purchase',
        basisDate: DAY, value: '2200.00', methodJson: { formula: '中位数' }, methodVersion: 'v1',
        isAggregate: 0,
      }),
      '23514',
    );
  });

  it('G. 来源专属映射必须绑定来源', async () => {
    const f = await insertFixture('g');
    await expectDbError(
      db.insert(termMapping).values({
        scope: 'source', sourceId: null, rawCategoryText: '干净料', categoryId: f.steelCat.id, status: 'proposed',
      }),
      '23514',
    );
  });

  it('H. 修正链：同槽位唯一活跃 revision + supersede 指针规则 + 单事务原子性（P0-2 / DAW-34 闭合）', async () => {
    const f = await insertFixture('h');
    const base = { categoryId: f.steelCat.id, specId: f.heavySpec.id, unitId: f.unitId };

    // 首版观测（旧 schema 的 unique(fetch, row) 允许；新 schema 是 (fetch, row, revision)）。
    const [v1] = await db
      .insert(priceObservation)
      .values(
        observationFixture({
          ...base, fetchId: f.fetches[0]!.id, sourceId: f.sources[0]!.id, fetchedAt: T0, rowIndex: 0,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'validated',
        }),
      )
      .returning();

    // 合法修正 = 单事务两笔原子写：插入后继 + 标记前驱。
    // 0002 的可延迟槽位守卫在提交时校验「同槽位仅一个活跃版本」—— 中间态（两笔都已写、
    // 前驱未标）在事务内合法，提交时必须已闭合；这是 P0-2 修正链闭合的核心路径。
    const v2 = await db.transaction(async (tx) => {
      const [succ] = await tx
        .insert(priceObservation)
        .values(
          observationFixture({
            ...base, fetchId: f.fetches[0]!.id, sourceId: f.sources[0]!.id, fetchedAt: T0, rowIndex: 0, revision: 2,
            regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2210.00', status: 'validated',
          }),
        )
        .returning();
      await tx
        .update(priceObservation)
        .set({ validationStatus: 'superseded', supersededById: succ!.id })
        .where(eq(priceObservation.id, v1!.id));
      return succ!;
    });
    expect(v2!.revision).toBe(2);
    // 提交后：同槽位（fetch 0, row 0）有且只有一个未 superseded 的版本。
    const activeInSlot = await db
      .select({ id: priceObservation.id })
      .from(priceObservation)
      .where(
        and(
          eq(priceObservation.fetchId, f.fetches[0]!.id),
          eq(priceObservation.sourceRowIndex, 0),
          isNull(priceObservation.supersededById),
        ),
      );
    expect(activeInSlot).toHaveLength(1);
    expect(activeInSlot[0]!.id).toBe(v2!.id);

    // 半修正回归（DAW-34 探针路径）：后继单独提交、前驱未标 → 提交时槽位双活跃，整体拒绝。
    // 拆成两次提交的修正不是修正，是数据污染 —— 在这里被挡死。
    await db
      .insert(priceObservation)
      .values(
        observationFixture({
          ...base, fetchId: f.fetches[0]!.id, sourceId: f.sources[0]!.id, fetchedAt: T0, rowIndex: 8,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'validated',
        }),
      )
      .returning();
    await expectDbError(
      db.insert(priceObservation).values(
        observationFixture({
          ...base, fetchId: f.fetches[0]!.id, sourceId: f.sources[0]!.id, fetchedAt: T0, rowIndex: 8, revision: 2,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2230.00', status: 'validated',
        }),
      ),
      'P0001',
    );

    // 指向不存在的后继 → 拒绝（合法顺序是先插后继；先后驱后指针 = 指空）。
    await expectDbError(
      db
        .update(priceObservation)
        .set({ validationStatus: 'superseded', supersededById: randomUUID() })
        .where(eq(priceObservation.id, v2!.id)),
      'P0001',
    );

    // 指针与状态双向锁定（CHECK）：事务内只给指针不给状态 → 拒绝且整体回滚（后继插入一并撤销）。
    const [v1b] = await db
      .insert(priceObservation)
      .values(
        observationFixture({
          ...base, fetchId: f.fetches[0]!.id, sourceId: f.sources[0]!.id, fetchedAt: T0, rowIndex: 1,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'validated',
        }),
      )
      .returning();
    await expectDbError(
      db.transaction(async (tx) => {
        const [v2b] = await tx
          .insert(priceObservation)
          .values(
            observationFixture({
              ...base, fetchId: f.fetches[0]!.id, sourceId: f.sources[0]!.id, fetchedAt: T0, rowIndex: 1, revision: 2,
              regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2215.00', status: 'validated',
            }),
          )
          .returning();
        await tx
          .update(priceObservation)
          .set({ supersededById: v2b!.id })
          .where(eq(priceObservation.id, v1b!.id));
      }),
      '23514',
    );
    // 只有状态没有指针 → 拒绝。
    await expectDbError(
      db.insert(priceObservation).values(
        observationFixture({
          ...base, fetchId: f.fetches[1]!.id, sourceId: f.sources[1]!.id, fetchedAt: new Date('2026-10-26T08:01:00Z'), rowIndex: 5,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'superseded',
        }),
      ),
      '23514',
    );

    // 指向后继但 revision 不更大 → 拒绝（单调递增 = 物理无环）。
    await expectDbError(
      db
        .update(priceObservation)
        .set({ validationStatus: 'superseded', supersededById: v1!.id })
        .where(eq(priceObservation.id, v2!.id)),
      'P0001',
    );

    // 同槽位同 revision 重复 → 唯一拒绝。
    await expectDbError(
      db.insert(priceObservation).values(
        observationFixture({
          ...base, fetchId: f.fetches[0]!.id, sourceId: f.sources[0]!.id, fetchedAt: T0, rowIndex: 0, revision: 2,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2220.00', status: 'validated',
        }),
      ),
      '23505',
    );

    // 后继必须同槽位：跨 fetch/跨行的嫁接 → 拒绝（修正是「一条原始记录的换代」，不是跨记录搬运）。
    const [otherSlot] = await db
      .insert(priceObservation)
      .values(
        observationFixture({
          ...base, fetchId: f.fetches[0]!.id, sourceId: f.sources[0]!.id, fetchedAt: T0, rowIndex: 7, revision: 2,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'validated',
        }),
      )
      .returning();
    await expectDbError(
      db
        .update(priceObservation)
        .set({ validationStatus: 'superseded', supersededById: otherSlot!.id })
        .where(eq(priceObservation.id, v2!.id)),
      'P0001',
    );

    // 后继必须同维度：同槽位但换了品类 → 拒绝（同源同口径，修正不允许跨口径替换）。
    const [copperCat] = await db
      .insert(category)
      .values({ code: 'h-copper', nameCn: '废铜', status: 'active' })
      .returning();
    const [copperSpec] = await db
      .insert(specGrade)
      .values({ categoryId: copperCat!.id, code: 'bright-wire', nameCn: '光亮铜线', status: 'active' })
      .returning();
    const [p9] = await db
      .insert(priceObservation)
      .values(
        observationFixture({
          ...base, fetchId: f.fetches[1]!.id, sourceId: f.sources[1]!.id, fetchedAt: new Date('2026-10-26T08:01:00Z'), rowIndex: 9,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'validated',
        }),
      )
      .returning();
    await expectDbError(
      db.transaction(async (tx) => {
        const [succ9] = await tx
          .insert(priceObservation)
          .values(
            observationFixture({
              categoryId: copperCat!.id, specId: copperSpec!.id, unitId: f.unitId,
              fetchId: f.fetches[1]!.id, sourceId: f.sources[1]!.id, fetchedAt: new Date('2026-10-26T08:01:00Z'), rowIndex: 9, revision: 2,
              regionId: f.eastMarket.id, priceType: 'purchase', normValue: '58000.00', status: 'validated',
            }),
          )
          .returning();
        await tx
          .update(priceObservation)
          .set({ validationStatus: 'superseded', supersededById: succ9!.id })
          .where(eq(priceObservation.id, p9!.id));
      }),
      'P0001',
    );
  });

  it('I. region 树：阶梯、单根、引用冻结（P0-3）', async () => {
    const f = await insertFixture('i');

    // market 直接挂 country → 拒绝（必须逐级上行）。
    await expectDbError(
      db.insert(region).values({ code: 'i-bad-market', nameCn: '坏市场', level: 'market', parentId: f.cnId }),
      'P0001',
    );
    // city 不挂父 → 拒绝。
    await expectDbError(
      db.insert(region).values({ code: 'i-orphan', nameCn: '孤儿城市', level: 'city' }),
      'P0001',
    );
    // 第二个 country → 拒绝（单根）。
    await expectDbError(
      db.insert(region).values({ code: 'i-cn-2', nameCn: '第二个国家', level: 'country' }),
      '23505',
    );

    // 东市场被观测引用后：改层级/父节点 → 拒绝；删除 → 拒绝。
    await insertValidatedObservation(f, 0, '2200.00');
    await expectDbError(
      db.update(region).set({ parentId: f.cnId }).where(eq(region.id, f.eastMarket.id)),
      'P0001',
    );
    await expectDbError(
      db.update(region).set({ level: 'city' }).where(eq(region.id, f.eastMarket.id)),
      'P0001',
    );
    await expectDbError(db.delete(region).where(eq(region.id, f.eastMarket.id)), 'P0001');

    // 未被引用的 region 可正常删（字典行为，不误伤）。
    await db.delete(region).where(eq(region.id, f.westMarket.id));
  });

  it('J. 指标贡献明细：维度一致、写定冻结、非空、重算事务（P0-4）', async () => {
    const f = await insertFixture('j');
    const obs = await insertValidatedObservation(f, 0, '2200.00');
    const quote = await insertQuote(f, obs.id, '2200.00');

    // 零贡献提交 → 可延迟非空约束在 commit 时拒绝。
    await expectDbError(
      db.transaction(async (tx) => {
        await tx.insert(derivedIndicator).values({
          kind: 'city_aggregate', categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.linyi.id, priceType: 'purchase',
          basisDate: DAY, value: '2200.00', methodJson: { formula: '加权平均' }, methodVersion: 'v1',
        });
      }),
      'P0001',
    );

    // 正向：指标 + 贡献同事务。
    let indicatorId = '';
    await db.transaction(async (tx) => {
      const [ind] = await tx
        .insert(derivedIndicator)
        .values({
          kind: 'city_aggregate', categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.linyi.id, priceType: 'purchase',
          basisDate: DAY, value: '2200.00', methodJson: { formula: '加权平均' }, methodVersion: 'v1',
        })
        .returning();
      indicatorId = ind!.id;
      await tx.insert(indicatorContribution).values({ indicatorId: ind!.id, quoteId: quote.id, valueAtAggregation: '2200.00' });
    });

    // 贡献行写定即冻结：禁 UPDATE。
    await expectDbError(
      db.update(indicatorContribution).set({ weight: '0.500000' }).where(eq(indicatorContribution.indicatorId, indicatorId)),
      'P0001',
    );

    // 维度不匹配：跨品类 quote 不能当贡献。
    const [copperCat] = await db
      .insert(category)
      .values({ code: 'j-copper', nameCn: '废铜', status: 'active' })
      .returning();
    const [copperSpec] = await db
      .insert(specGrade)
      .values({ categoryId: copperCat!.id, code: 'bright-wire', nameCn: '光亮铜线', status: 'active' })
      .returning();
    const [copperObs] = await db
      .insert(priceObservation)
      .values(
        observationFixture({
          categoryId: copperCat!.id, specId: copperSpec!.id, unitId: f.unitId,
          fetchId: f.fetches[1]!.id, sourceId: f.sources[1]!.id, fetchedAt: new Date('2026-10-26T08:01:00Z'), rowIndex: 0,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '60000.00', status: 'validated',
        }),
      )
      .returning();
    const [copperQuote] = await db
      .insert(dailyQuote)
      .values({
        categoryId: copperCat!.id, specId: copperSpec!.id, regionId: f.eastMarket.id, quoteDate: DAY, priceType: 'purchase',
        valueLow: '60000.00', valueHigh: '60000.00', valueMid: '60000.00', method: 'single_source',
        contributingObservationIds: [copperObs!.id], sourceCount: 1, methodVersion: 'v1',
      })
      .returning();
    await expectDbError(
      db.insert(indicatorContribution).values({ indicatorId, quoteId: copperQuote!.id, valueAtAggregation: '60000.00' }),
      'P0001',
    );

    // 层级不严格更低：city 层报价不能贡献给 city 层指标（聚合只能自下而上）。
    const [cityObs] = await db
      .insert(priceObservation)
      .values(
        observationFixture({
          categoryId: f.steelCat.id, specId: f.heavySpec.id, unitId: f.unitId,
          fetchId: f.fetches[2]!.id, sourceId: f.sources[2]!.id, fetchedAt: new Date('2026-10-26T08:02:00Z'), rowIndex: 0,
          regionId: f.linyi.id, priceType: 'purchase', normValue: '2190.00', status: 'validated',
        }),
      )
      .returning();
    const [cityQuote] = await db
      .insert(dailyQuote)
      .values({
        categoryId: f.steelCat.id, specId: f.heavySpec.id, regionId: f.linyi.id, quoteDate: DAY, priceType: 'purchase',
        valueLow: '2190.00', valueHigh: '2190.00', valueMid: '2190.00', method: 'single_source',
        contributingObservationIds: [cityObs!.id], sourceCount: 1, methodVersion: 'v1',
      })
      .returning();
    await expectDbError(
      db.insert(indicatorContribution).values({ indicatorId, quoteId: cityQuote!.id, valueAtAggregation: '2190.00' }),
      'P0001',
    );

    // 重算：同事务删旧插新 → 允许（非空约束在提交时满足）。
    // value_at_aggregation 仍须落在 quote 区间内 —— quote 本身没变，快照值也不能变着花样写。
    await db.transaction(async (tx) => {
      await tx.delete(indicatorContribution).where(eq(indicatorContribution.indicatorId, indicatorId));
      await tx.insert(indicatorContribution).values({ indicatorId, quoteId: quote.id, valueAtAggregation: '2200.00', weight: '1.000000' });
    });

    // 计算字段可随重算更新；维度字段冻结；DELETE 指标被拒。
    await db.update(derivedIndicator).set({ value: '2205.00', methodVersion: 'v2' }).where(eq(derivedIndicator.id, indicatorId));
    await expectDbError(
      db.update(derivedIndicator).set({ categoryId: copperCat!.id }).where(eq(derivedIndicator.id, indicatorId)),
      'P0001',
    );
    await expectDbError(db.delete(derivedIndicator).where(eq(derivedIndicator.id, indicatorId)), 'P0001');
  });

  it('K. 外键补洞：伪造归属全部被拒（P1-5）', async () => {
    const f = await insertFixture('k');
    const [s1, s2] = f.sources;
    const [f1] = f.fetches;
    const base = { categoryId: f.steelCat.id, specId: f.heavySpec.id, unitId: f.unitId };

    // (fetch, source) 错配：观测不许谎报来源。
    await expectDbError(
      db.insert(priceObservation).values(
        observationFixture({
          ...base, fetchId: f1!.id, sourceId: s2!.id, fetchedAt: T0, rowIndex: 0,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'validated',
        }),
      ),
      '23503',
    );

    // (fetch, fetched_at) 错配：观测不许谎报抓取时间。
    await expectDbError(
      db.insert(priceObservation).values(
        observationFixture({
          ...base, fetchId: f1!.id, sourceId: s1!.id, fetchedAt: new Date('2026-10-26T09:00:00Z'), rowIndex: 1,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'validated',
        }),
      ),
      '23503',
    );

    // (category, spec) 跨品类挂靠：观测与定档都不许。
    const [copperCat] = await db
      .insert(category)
      .values({ code: 'k-copper', nameCn: '废铜', status: 'active' })
      .returning();
    const obs = await insertValidatedObservation(f, 0, '2200.00');
    await expectDbError(
      db.insert(priceObservation).values(
        observationFixture({
          categoryId: copperCat!.id, specId: f.heavySpec.id, unitId: f.unitId,
          fetchId: f1!.id, sourceId: s1!.id, fetchedAt: T0, rowIndex: 2,
          regionId: f.eastMarket.id, priceType: 'purchase', normValue: '2200.00', status: 'validated',
        }),
      ),
      '23503',
    );
    await expectDbError(
      db.insert(dailyQuote).values({
        categoryId: copperCat!.id, specId: f.heavySpec.id, regionId: f.eastMarket.id, quoteDate: DAY, priceType: 'purchase',
        valueLow: '2200.00', valueHigh: '2200.00', valueMid: '2200.00', method: 'single_source',
        contributingObservationIds: [obs.id], sourceCount: 1, methodVersion: 'v1',
      }),
      '23503',
    );

    // region_mapping.region_id 断链 → 拒绝。
    await expectDbError(
      db.insert(regionMapping).values({
        scope: 'global', rawRegionText: '临沂', regionId: '00000000-0000-0000-0000-00000000dead',
      }),
      '23503',
    );

    // source_coverage 的 spec/region 断链 → 拒绝。
    await expectDbError(
      db.insert(sourceCoverage).values({
        sourceId: s1!.id, categoryId: f.steelCat.id,
        specId: '00000000-0000-0000-0000-00000000dead',
      }),
      '23503',
    );

    // 台账归属：step 不属于该 run 的 agent_invocation → 拒绝。
    const [run1] = await db.insert(pipelineRun).values({ kind: 'daily_collect', triggeredBy: 'manual' }).returning();
    const [run2] = await db.insert(pipelineRun).values({ kind: 'daily_collect', triggeredBy: 'manual' }).returning();
    await db.insert(pipelineStep).values({ runId: run2!.id, stepKind: 'fetch', seq: 1, stepVersion: 'v1' });
    await expectDbError(
      db.insert(agentInvocation).values({
        runId: run1!.id, stepId: (await db.select().from(pipelineStep).where(eq(pipelineStep.runId, run2!.id)))[0]!.id,
        purpose: 'validation_judgment', model: 'test', promptVersion: 'v1', inputJson: {}, outputJson: {},
      }),
      '23503',
    );

    // validation_result.agent_invocation_id 断链 → 拒绝。
    const obs2 = await insertValidatedObservation(f, 1, '2210.00');
    await expectDbError(
      db.insert(validationResult).values({
        observationId: obs2.id, checkKind: 'cross_source', verdict: 'pass', detail: {},
        performedByKind: 'rule', performedByRef: 'rule:cross_source@v1',
        agentInvocationId: '00000000-0000-0000-0000-00000000dead',
      }),
      '23503',
    );
  });

  it('L. 映射确定性：同一原文只允许一条 active（P1-6）', async () => {
    const f = await insertFixture('l');

    await db.insert(termMapping).values({
      scope: 'global', rawCategoryText: '干净料', categoryId: f.steelCat.id, status: 'active',
    });
    // 第二条同 key active → 唯一拒绝（解析结果不再依赖查询顺序）。
    await expectDbError(
      db.insert(termMapping).values({
        scope: 'global', rawCategoryText: '干净料', categoryId: f.steelCat.id, status: 'active',
      }),
      '23505',
    );
    // 非 active（rejected/proposed）历史行不冲突 —— 修正走新行。
    await db.insert(termMapping).values({
      scope: 'global', rawCategoryText: '干净料', categoryId: f.steelCat.id, status: 'rejected',
    });
    // source 专属 active 与 global active 同文本共存 —— 「来源口径优先于全局」契约的物理前提。
    await db.insert(termMapping).values({
      scope: 'source', sourceId: f.sources[0]!.id, rawCategoryText: '干净料', categoryId: f.steelCat.id, status: 'active',
    });

    // region_mapping 同构。
    await db.insert(regionMapping).values({ scope: 'global', rawRegionText: '鲁南', regionId: f.linyi.id, status: 'active' });
    await expectDbError(
      db.insert(regionMapping).values({ scope: 'global', rawRegionText: '鲁南', regionId: f.eastMarket.id, status: 'active' }),
      '23505',
    );
  });

  it('M. run/step 台账：seq 唯一、状态机、终态冻结、append-only、幂等键（P1-7）', async () => {
    const f = await insertFixture('m');

    const [run] = await db.insert(pipelineRun).values({ kind: 'daily_collect', triggeredBy: 'manual' }).returning();
    const [step] = await db
      .insert(pipelineStep)
      .values({ runId: run!.id, stepKind: 'fetch', seq: 1, stepVersion: 'v1' })
      .returning();

    // 同 run 重复 seq → 唯一拒绝（并发 worker / 重投建步）。
    await expectDbError(
      db.insert(pipelineStep).values({ runId: run!.id, stepKind: 'extract', seq: 1, stepVersion: 'v1' }),
      '23505',
    );

    // 状态机正向。
    await db.update(pipelineRun).set({ status: 'running', startedAt: new Date() }).where(eq(pipelineRun.id, run!.id));
    await db.update(pipelineStep).set({ status: 'running', startedAt: new Date() }).where(eq(pipelineStep.id, step!.id));
    await db.update(pipelineStep).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(pipelineStep.id, step!.id));
    await db.update(pipelineRun).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(pipelineRun.id, run!.id));

    // 终态冻结：再改（重复 finish / 复活）→ 拒绝。
    await expectDbError(
      db.update(pipelineRun).set({ status: 'failed' }).where(eq(pipelineRun.id, run!.id)),
      'P0001',
    );
    await expectDbError(
      db.update(pipelineStep).set({ status: 'failed' }).where(eq(pipelineStep.id, step!.id)),
      'P0001',
    );

    // 状态回退（running → pending）→ 拒绝。
    const [run2] = await db.insert(pipelineRun).values({ kind: 'daily_collect', triggeredBy: 'schedule' }).returning();
    await db.update(pipelineRun).set({ status: 'running' }).where(eq(pipelineRun.id, run2!.id));
    await expectDbError(
      db.update(pipelineRun).set({ status: 'pending' }).where(eq(pipelineRun.id, run2!.id)),
      'P0001',
    );

    // append-only：run / step 禁删。
    await expectDbError(db.delete(pipelineRun).where(eq(pipelineRun.id, run2!.id)), 'P0001');
    await expectDbError(db.delete(pipelineStep).where(eq(pipelineStep.id, step!.id)), 'P0001');

    // 幂等键：同键二个 run → 唯一拒绝（pg-boss at-least-once 重投的安全网）。
    await db.insert(pipelineRun).values({ kind: 'daily_collect', triggeredBy: 'schedule', idempotencyKey: `${f.steelCat.id}-job-1` });
    await expectDbError(
      db.insert(pipelineRun).values({ kind: 'daily_collect', triggeredBy: 'retry', idempotencyKey: `${f.steelCat.id}-job-1` }),
      '23505',
    );

    // INSERT 状态机（DAW-34 复审修复，0002 守卫）：run/step 只能以 pending 落库 ——
    // 裸 INSERT 直接写 succeeded run / failed step、跳过 pending→running→终态的路径被堵死。
    expect(run!.status).toBe('pending');
    expect(step!.status).toBe('pending');
    await expectDbError(
      db.insert(pipelineRun).values({ kind: 'daily_collect', triggeredBy: 'manual', status: 'succeeded' }),
      'P0001',
    );
    const [run3] = await db
      .insert(pipelineRun)
      .values({ kind: 'daily_collect', triggeredBy: 'manual' })
      .returning();
    await expectDbError(
      db
        .insert(pipelineStep)
        .values({ runId: run3!.id, stepKind: 'fetch', seq: 1, stepVersion: 'v1', status: 'failed' }),
      'P0001',
    );
    // 终态 run 冻结：事后追加 step = 伪造台账 → 拒绝。
    const [runDone] = await db
      .insert(pipelineRun)
      .values({ kind: 'daily_collect', triggeredBy: 'manual' })
      .returning();
    await db.update(pipelineRun).set({ status: 'running', startedAt: new Date() }).where(eq(pipelineRun.id, runDone!.id));
    await db
      .update(pipelineRun)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(pipelineRun.id, runDone!.id));
    await expectDbError(
      db.insert(pipelineStep).values({ runId: runDone!.id, stepKind: 'fetch', seq: 1, stepVersion: 'v1' }),
      'P0001',
    );
  });

  it('N. 字典 CHECK：换算系数、单 canonical、采集前置、杂质规则期间', async () => {
    const f = await insertFixture('n');

    // 换算系数必须 > 0。
    const [fromUnit] = await db
      .insert(unit)
      .values({ code: 'n-CNY_per_kg', nameCn: '元/公斤', isCanonical: 0 })
      .returning();
    await expectDbError(
      db.insert(unitConversion).values({ fromUnitId: fromUnit!.id, toUnitId: f.unitId, factor: '0' }),
      '23514',
    );

    // canonical 单位全局唯一（种子里的元/吨 只能有一个）。
    // 单例隔离（DAW-34）：不假设执行顺序 —— bee_test 可能已被 briefing 套件 seed 过（串行下它先跑），
    // 也可能单跑本文件（无 canonical）。先快照既有 canonical，测完原样恢复：
    // 本测试不得把「谁当 canonical」的隐式顺序泄漏给其他套件，也不留自己的残留。
    const priorCanonical = await db.select({ id: unit.id }).from(unit).where(eq(unit.isCanonical, 1));
    await db.update(unit).set({ isCanonical: 0 }).where(eq(unit.isCanonical, 1));
    const [canon1] = await db
      .insert(unit)
      .values({ code: 'n-canonical-1', nameCn: '规范单位一', isCanonical: 1 })
      .returning();
    await expectDbError(
      db.insert(unit).values({ code: 'n-canonical-2', nameCn: '规范单位二', isCanonical: 1 }),
      '23505',
    );
    // 退位后才能换人。
    await db.update(unit).set({ isCanonical: 0 }).where(eq(unit.id, canon1!.id));
    await db.insert(unit).values({ code: 'n-canonical-3', nameCn: '规范单位三', isCanonical: 1 });
    // 清掉本测试建的 canonical，恢复进测试前的原状（至多一行，部分唯一索引保证）。
    await db.update(unit).set({ isCanonical: 0 }).where(eq(unit.isCanonical, 1));
    for (const row of priorCanonical) {
      await db.update(unit).set({ isCanonical: 1 }).where(eq(unit.id, row.id));
    }

    // active 来源必须 robots allowed。
    await expectDbError(
      db.insert(source).values({
        code: 'n-src-bad', name: '坏来源', type: 'webpage', baseUrl: 'https://x.example.com',
        status: 'active', robotsStatus: 'unknown',
      }),
      '23514',
    );

    // 杂质规则生效区间必须自洽。
    await expectDbError(
      db.insert(impurityRule).values({
        categoryId: f.steelCat.id, ruleKind: 'weight_percent', paramJson: { percent: 3 },
        effectiveFrom: '2026-10-26', effectiveTo: '2026-10-25',
      }),
      '23514',
    );
  });
});
