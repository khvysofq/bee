/**
 * 时序层集成测试（market_series + series_point）。
 *
 * 覆盖 P1「三层数据」模型的三条硬约束：
 *  A. 层级 ↔ 地域绑定：国际不挂地域、区域必挂地域（CHECK）；
 *     全国层只能挂 country（触发器），把「全国均价」塞进区域序列在物理上写不进去。
 *  B. 时序点不可变：UPDATE / DELETE 拒绝；修正只能走 revision+1 新行。
 *  C. 归属一致：series_point 的 source 必须与序列登记的 source 一致（复合外键）；
 *     唯一键 (series, obs_date, revision) 挡住重复采集。
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createDb, dbSchema } from '../src/index';

const { marketSeries, seriesPoint, source, region, rawContent, rawFetch, unit } = dbSchema;

const TEST_URL = process.env.BEE_TEST_DATABASE_URL ?? '';
const db = createDb(TEST_URL);

describe.skipIf(!TEST_URL)('时序层：三层数据与不可变纪律', () => {
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

  async function ensureUnit() {
    await db
      .insert(unit)
      .values({ code: 't-series-ton', nameCn: '元/吨', isCanonical: 0 })
      .onConflictDoNothing({ target: unit.code });
    const [row] = await db.select().from(unit).where(eq(unit.code, 't-series-ton'));
    return row!.id;
  }

  async function newSource(p: string) {
    const [row] = await db
      .insert(source)
      .values({
        code: `${p}-src`,
        name: '测试交易所',
        type: 'api',
        baseUrl: 'https://example.invalid',
        robotsStatus: 'allowed',
        status: 'active',
      })
      .returning();
    return row!.id;
  }

  /** 一次抓取登记（series_point 的溯源锚点）。 */
  async function newFetch(p: string, sourceId: string) {
    const sha = `${p}${randomUUID()}`.replace(/-/g, '').padEnd(64, '0').slice(0, 64);
    await db.insert(rawContent).values({ contentSha256: sha, contentRef: `raw/test/${sha}.bin` });
    const [row] = await db
      .insert(rawFetch)
      .values({
        sourceId,
        url: `https://example.invalid/${p}`,
        fetchedAt: new Date('2026-10-27T00:00:00Z'),
        httpStatus: 200,
        contentSha256: sha,
      })
      .returning();
    return row!.id;
  }

  it('国际层序列不得挂地域节点（CHECK）', async () => {
    const p = `si${randomUUID().slice(0, 6)}`;
    const sourceId = await newSource(p);
    const unitId = await ensureUnit();
    const [cn] = await db.select().from(region).where(eq(region.level, 'country')).limit(1);
    if (!cn) return; // 无 country 根时本用例不适用（其余用例仍覆盖层级规则）

    // 国际层挂地域：触发器先于 CHECK 拦住（P0001），两层防守都算拒绝。
    try {
      await db.insert(marketSeries).values({
        code: `${p}.intl`,
        nameCn: '国际铜',
        layer: 'international',
        kind: 'index',
        frequency: 'monthly',
        sourceId,
        regionId: cn.id,
        instrumentCode: 'PCOPPUSDM',
        unitId,
        status: 'active',
      });
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      expect(['P0001', '23514']).toContain(e.code ?? e.cause?.code);
      return;
    }
    expect.fail('期望国际层挂地域被拒绝，但写入成功了');
  });

  it('区域层序列必须挂地域（CHECK）', async () => {
    const p = `sr${randomUUID().slice(0, 6)}`;
    const sourceId = await newSource(p);
    const unitId = await ensureUnit();

    await expectDbError(
      db.insert(marketSeries).values({
        code: `${p}.regional`,
        nameCn: '某仓库库存',
        layer: 'regional',
        kind: 'inventory',
        frequency: 'weekly',
        sourceId,
        instrumentCode: 'WH01',
        unitId,
        status: 'active',
      }),
      '23514',
    );
  });

  it('全国层序列只能挂 country，挂城市被触发器拒绝', async () => {
    const p = `sn${randomUUID().slice(0, 6)}`;
    const sourceId = await newSource(p);
    const unitId = await ensureUnit();
    const [cn] = await db.select().from(region).where(eq(region.level, 'country')).limit(1);
    const [city] = await db.select().from(region).where(eq(region.level, 'city')).limit(1);
    if (!cn || !city) return; // 需要 country 与 city 同时存在

    await db.insert(marketSeries).values({
      code: `${p}.national`,
      nameCn: '螺纹钢主力',
      layer: 'national',
      kind: 'futures',
      frequency: 'daily',
      sourceId,
      regionId: cn.id,
      instrumentCode: 'rb',
      unitId,
      status: 'active',
    });

    await expectDbError(
      db.insert(marketSeries).values({
        code: `${p}.bad`,
        nameCn: '错挂城市的全国序列',
        layer: 'national',
        kind: 'futures',
        frequency: 'daily',
        sourceId,
        regionId: city.id,
        instrumentCode: 'rb',
        unitId,
        status: 'active',
      }),
      'P0001',
    );
  });

  it('时序点值不可变：UPDATE / DELETE 均被拒绝', async () => {
    const p = `sp${randomUUID().slice(0, 6)}`;
    const sourceId = await newSource(p);
    const unitId = await ensureUnit();
    const fetchId = await newFetch(p, sourceId);

    const [series] = await db
      .insert(marketSeries)
      .values({
        code: `${p}.rb2701`,
        nameCn: '螺纹钢 rb2701',
        layer: 'national',
        kind: 'futures',
        frequency: 'daily',
        sourceId,
        instrumentCode: 'rb',
        unitId,
        status: 'active',
      })
      .returning();

    const [point] = await db
      .insert(seriesPoint)
      .values({
        seriesId: series!.id,
        sourceId,
        obsDate: '2026-10-23',
        value: '3116',
        settlePrice: '3116',
        fetchId,
      })
      .returning();

    await expectDbError(
      db.update(seriesPoint).set({ value: '9999' }).where(eq(seriesPoint.id, point!.id)),
      'P0001',
    );
    await expectDbError(db.delete(seriesPoint).where(eq(seriesPoint.id, point!.id)), 'P0001');

    // 修正的合法路径：同序列同日期 revision+1 的新行，旧值保留。
    await db.insert(seriesPoint).values({
      seriesId: series!.id,
      sourceId,
      obsDate: '2026-10-23',
      revision: 2,
      value: '3120',
      fetchId,
    });
    const rows = await db.select().from(seriesPoint).where(eq(seriesPoint.seriesId, series!.id));
    expect(rows).toHaveLength(2);
  });

  it('同一序列同一日期同一 revision 不可重复（唯一键）', async () => {
    const p = `su${randomUUID().slice(0, 6)}`;
    const sourceId = await newSource(p);
    const unitId = await ensureUnit();
    const fetchId = await newFetch(p, sourceId);

    const [series] = await db
      .insert(marketSeries)
      .values({
        code: `${p}.cu2611`,
        nameCn: '铜 cu2611',
        layer: 'national',
        kind: 'futures',
        frequency: 'daily',
        sourceId,
        instrumentCode: 'cu',
        unitId,
        status: 'active',
      })
      .returning();

    const values = { seriesId: series!.id, sourceId, obsDate: '2026-10-23', value: '108740', fetchId };
    await db.insert(seriesPoint).values(values);
    await expectDbError(db.insert(seriesPoint).values(values), '23505');
  });

  it('时序点不得声称属于别的来源（复合外键）', async () => {
    const p = `sm${randomUUID().slice(0, 6)}`;
    const sourceA = await newSource(p);
    const [otherSource] = await db
      .insert(source)
      .values({
        code: `${p}-other`,
        name: '另一家交易所',
        type: 'api',
        baseUrl: 'https://example.invalid',
        robotsStatus: 'allowed',
        status: 'active',
      })
      .returning();
    const unitId = await ensureUnit();
    const fetchId = await newFetch(p, sourceA);

    const [series] = await db
      .insert(marketSeries)
      .values({
        code: `${p}.al2611`,
        nameCn: '铝 al2611',
        layer: 'national',
        kind: 'futures',
        frequency: 'daily',
        sourceId: sourceA,
        instrumentCode: 'al',
        unitId,
        status: 'active',
      })
      .returning();

    await expectDbError(
      db.insert(seriesPoint).values({
        seriesId: series!.id,
        sourceId: otherSource!.id,
        obsDate: '2026-10-23',
        value: '21000',
        fetchId,
      }),
      '23503',
    );
  });
});