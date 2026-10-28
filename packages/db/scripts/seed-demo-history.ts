/**
 * 演示历史价格：2026-08-01 ~ 2026-10-28 每日一条，供首页卡片与品类详情曲线演示。
 *
 * 幂等：以 (category_id, spec_id, region_id, price_date, price_type) 为键 upsert，
 * 重复执行行数不变。数据标记为 demo-history 来源，页面据此显示「演示数据」角标。
 *
 * 价格是确定性的正弦/余弦叠加，仅用于演示趋势形态，不代表任何真实报价。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as v4 from '../src/schema-v4';
import { resolveV4DatabaseUrl } from '../src/env';

const SOURCE = {
  code: 'demo-history',
  name: '演示历史价格',
  type: 'price',
  baseUrl: 'fixture://demo-history',
  robotsStatus: 'allowed',
  redistribution: 'licensed',
} as const;

const EXTRA_REGIONS = [
  { code: '1302', name: '唐山', level: 'city', parent: '13', sortOrder: 1302 },
  { code: '3302', name: '宁波', level: 'city', parent: '33', sortOrder: 3302 },
  { code: '3713', name: '临沂', level: 'city', parent: '37', sortOrder: 3713 },
] as const;

interface SeriesSpec {
  category: string;
  spec: string;
  /** 国内基准价（元/吨）；全球序列使用 usdBase。 */
  base: number;
  usdBase: number;
  regions: string[];
  /** 相位偏移，让不同序列的曲线形状不完全重合。 */
  phase: number;
}

const SERIES: SeriesSpec[] = [
  {
    category: '1110105',
    spec: 'heavy',
    base: 2450,
    usdBase: 385,
    regions: ['WORLD', 'CN', '1302', '3205', '4406'],
    phase: 0,
  },
  {
    category: '1110201',
    spec: 'bright',
    base: 62100,
    usdBase: 8650,
    regions: ['WORLD', 'CN', '4406', '4401', '3205', '12'],
    phase: 1.1,
  },
  {
    category: '1110202',
    spec: 'raw-alum',
    base: 17600,
    usdBase: 2150,
    regions: ['WORLD', 'CN', '4406', '3302', '3713'],
    phase: 2.2,
  },
];

const START = '2026-08-01';
const END = '2026-10-28';
const DAY_MS = 86_400_000;

function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += DAY_MS) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}

/** 基准 × (1 + 0.012·sin(day/7 + φ) + 0.006·cos(day/3.3 + φ))，保留两位小数。 */
function priceAt(base: number, day: number, phase: number): string {
  const factor =
    1 + 0.012 * Math.sin(day / 7 + phase) + 0.006 * Math.cos(day / 3.3 + phase);
  return (base * factor).toFixed(2);
}

async function main() {
  const pool = new pg.Pool({ connectionString: resolveV4DatabaseUrl(), max: 1 });
  const db = drizzle(pool, { schema: v4 });

  const dates = datesBetween(START, END);

  await db.transaction(async (tx) => {
    await tx
      .insert(v4.source)
      .values({
        code: SOURCE.code,
        name: SOURCE.name,
        type: SOURCE.type,
        baseUrl: SOURCE.baseUrl,
        robotsStatus: SOURCE.robotsStatus,
        redistribution: SOURCE.redistribution,
        enabled: true,
        notes: '演示历史价格，仅用于界面演示，不代表真实报价。',
      })
      .onConflictDoUpdate({
        target: v4.source.code,
        set: {
          name: SOURCE.name,
          type: SOURCE.type,
          baseUrl: SOURCE.baseUrl,
          robotsStatus: SOURCE.robotsStatus,
          redistribution: SOURCE.redistribution,
          enabled: true,
          updatedAt: new Date(),
        },
      });

    const [sourceRow] = await tx
      .select()
      .from(v4.source)
      .where(eq(v4.source.code, SOURCE.code));
    if (!sourceRow) throw new Error('缺少 demo-history 来源');

    for (const region of EXTRA_REGIONS) {
      const [parent] = await tx
        .select({ id: v4.region.id })
        .from(v4.region)
        .where(eq(v4.region.code, region.parent));
      if (!parent) throw new Error(`地域 ${region.code} 缺少父级 ${region.parent}`);
      await tx
        .insert(v4.region)
        .values({
          code: region.code,
          name: region.name,
          level: region.level,
          parentId: parent.id,
          sortOrder: region.sortOrder,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: v4.region.code,
          set: {
            name: region.name,
            level: region.level,
            parentId: parent.id,
            sortOrder: region.sortOrder,
            status: 'active',
          },
        });
    }

    const categories = await tx
      .select({ id: v4.category.id, code: v4.category.code })
      .from(v4.category)
      .where(inArray(v4.category.code, SERIES.map((series) => series.category)));
    const categoryIdByCode = new Map(categories.map((row) => [row.code, row.id]));

    const specRows = await tx
      .select({ id: v4.spec.id, categoryId: v4.spec.categoryId, code: v4.spec.code })
      .from(v4.spec)
      .where(inArray(v4.spec.code, SERIES.map((series) => series.spec)));
    const specIdByKey = new Map(specRows.map((row) => [`${row.categoryId}|${row.code}`, row.id]));

    const regionCodes = [...new Set(SERIES.flatMap((series) => series.regions))];
    const regionRows = await tx
      .select({ id: v4.region.id, code: v4.region.code })
      .from(v4.region)
      .where(inArray(v4.region.code, regionCodes));
    const regionIdByCode = new Map(regionRows.map((row) => [row.code, row.id]));

    const rows: (typeof v4.priceDaily.$inferInsert)[] = [];
    for (const series of SERIES) {
      const categoryId = categoryIdByCode.get(series.category);
      if (!categoryId) throw new Error(`缺少品类 ${series.category}`);
      const specId = specIdByKey.get(`${categoryId}|${series.spec}`);
      if (!specId) throw new Error(`缺少规格 ${series.category}/${series.spec}`);

      for (const regionCode of series.regions) {
        const regionId = regionIdByCode.get(regionCode);
        if (!regionId) throw new Error(`缺少地域 ${regionCode}`);
        const global = regionCode === 'WORLD';
        const base = global ? series.usdBase : series.base;
        for (const [day, date] of dates.entries()) {
          // 地域相位：全球固定 0，国内序列依次错开，曲线形态可见但基调一致。
          const regionPhase = series.phase + (global ? 0 : series.regions.indexOf(regionCode) * 0.27);
          const value = priceAt(base, day, regionPhase);
          rows.push({
            categoryId,
            specId,
            regionId,
            priceDate: date,
            priceType: 'market',
            valueLow: value,
            valueMid: value,
            valueHigh: value,
            unit: global ? 'USD/吨' : '元/吨',
            currency: global ? 'USD' : 'CNY',
            sourceId: sourceRow.id,
            rawUrl: `fixture://demo-history/${series.category}/${date}`,
            capturedAt: new Date(`${date}T08:00:00Z`),
            status: 'published',
            note: '演示数据（seed-demo-history）',
          });
        }
      }
    }

    // 分批 upsert，避免单条 SQL 参数过多。
    const BATCH = 400;
    for (let index = 0; index < rows.length; index += BATCH) {
      const batch = rows.slice(index, index + BATCH);
      await tx
        .insert(v4.priceDaily)
        .values(batch)
        .onConflictDoUpdate({
          target: [
            v4.priceDaily.categoryId,
            v4.priceDaily.specId,
            v4.priceDaily.regionId,
            v4.priceDaily.priceDate,
            v4.priceDaily.priceType,
          ],
          set: {
            valueLow: sql`excluded."value_low"`,
            valueHigh: sql`excluded."value_high"`,
            valueMid: sql`excluded."value_mid"`,
            unit: sql`excluded."unit"`,
            currency: sql`excluded."currency"`,
            sourceId: sql`excluded."source_id"`,
            rawUrl: sql`excluded."raw_url"`,
            capturedAt: sql`excluded."captured_at"`,
            status: sql`excluded."status"`,
            note: sql`excluded."note"`,
            updatedAt: new Date(),
          },
        });
    }

    const [sourceCount] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(v4.priceDaily)
      .where(and(eq(v4.priceDaily.sourceId, sourceRow.id), eq(v4.priceDaily.status, 'published')));

    const [allRows] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(v4.priceDaily);

    console.log(
      `演示历史价格完成：${dates.length} 天 × ${SERIES.reduce((sum, s) => sum + s.regions.length, 0)} 序列 = ${rows.length} 行（本次来源 ${sourceCount?.total ?? 0} 行；price_daily 总 ${allRows?.total ?? 0} 行）。`,
    );
  });

  await pool.end();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});