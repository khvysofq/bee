import { inArray, sql } from 'drizzle-orm';
import { v4, type BeeDb } from '@bee/db';
import { numericToNumber } from '@bee/core';
import { db as defaultDb } from '../db';
import { STATS_SOURCE_CODE } from './compliance';
import { quoteSlug, parseQuoteSlug } from './market-types';
import type {
  MarketCategoryFacet,
  MarketChange,
  MarketOverview,
  MarketRegionFacet,
  MarketRow,
  MarketScope,
  MarketSparkPoint,
  SearchItem,
  TrustMark,
} from './market-types';
import { SCOPE_LABEL } from './market-types';

/**
 * 行情总览数据层（v4）。
 *
 * 唯一数字来源是 price_daily：每个「品类 × 地域 × 规格 × 价类型」取最近一条已发布价格，
 * 形成一行 MarketRow；spark 取该组合最近 30 个真实点（升序）。
 *
 * v4 不接期货/指数序列，series / points 计数恒为 0，也不伪造序列。
 * 没有价格的组合不生成行；区域层没有数据时页面显示「待接入」。
 */

export type {
  MarketCategoryFacet,
  MarketChange,
  MarketOverview,
  MarketRegionFacet,
  MarketRow,
  MarketScope,
  MarketSparkPoint,
  SearchItem,
  TrustMark,
};
export { SCOPE_LABEL };

const DAY_MS = 86_400_000;

const PRICE_TYPE_LABEL: Record<string, string> = {
  market: '市场价',
  purchase: '采购价',
  sale: '销售价',
  ex_works: '出厂价',
  indicative: '指导价',
};

function pct(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / DAY_MS,
  );
}

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function frequencyLabel(frequency: string): string {
  if (frequency === 'daily') return '日频';
  if (frequency === 'monthly') return '月频';
  if (frequency === 'weekly') return '周频';
  return '不定期';
}

function scopeOfRegion(level: string): MarketScope {
  if (level === 'global') return 'international';
  if (level === 'country') return 'domestic';
  return 'regional';
}

/** 从真实点位间隔推断频次；不足两点时按不定期处理（不下结论）。 */
function inferFrequency(pointsAsc: MarketSparkPoint[]): MarketRow['frequency'] {
  if (pointsAsc.length < 2) return 'irregular';
  const gaps: number[] = [];
  for (let i = 1; i < pointsAsc.length; i += 1) {
    gaps.push(daysBetween(pointsAsc[i]!.date, pointsAsc[i - 1]!.date));
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? Infinity;
  if (median <= 2) return 'daily';
  if (median <= 9) return 'weekly';
  if (median <= 45) return 'monthly';
  return 'irregular';
}

/** 从最近点序列（降序）计算日/周变化；不足或频次不适用时返回 null（缺失不当作持平）。 */
function changesFromPoints(
  pointsDesc: Array<{ date: string; value: number }>,
  frequency: string,
): { day: MarketChange | null; week: MarketChange | null } {
  if (frequency !== 'daily' || pointsDesc.length < 2) return { day: null, week: null };
  const latest = pointsDesc[0]!;
  const previous = pointsDesc[1]!;
  const day =
    daysBetween(latest.date, previous.date) <= 7
      ? { date: previous.date, previousValue: previous.value, pct: pct(latest.value, previous.value) }
      : null;

  const weekCutoff = addDays(latest.date, -7);
  const weekBase = pointsDesc.find((point) => point.date <= weekCutoff) ?? null;
  const week = weekBase
    ? { date: weekBase.date, previousValue: weekBase.value, pct: pct(latest.value, weekBase.value) }
    : null;
  return { day, week };
}

function trustForQuote(input: {
  frequency: string;
  lastDate: string;
  globalLatest: string | null;
}): { trust: TrustMark; label: string } {
  if (!input.globalLatest) return { trust: 'normal', label: '正常' };
  const age = daysBetween(input.globalLatest, input.lastDate);
  const limit = input.frequency === 'monthly' ? 62 : input.frequency === 'weekly' ? 21 : 10;
  if (age > limit) return { trust: 'review', label: '待复核' };
  return { trust: 'normal', label: '正常' };
}

interface PriceSqlRow {
  id: string;
  category_code: string;
  category_name: string;
  category_sort: number;
  spec_code: string | null;
  spec_name: string | null;
  region_code: string;
  region_name: string;
  region_level: string;
  price_date: string;
  price_type: string;
  value_low: string | null;
  value_high: string | null;
  value_mid: string | null;
  unit: string;
  currency: string;
  note: string | null;
  raw_url: string | null;
  captured_at: Date | string | null;
  source_code: string | null;
  source_name: string | null;
  rn: number;
  total: number;
}

interface PriceGroup {
  meta: PriceSqlRow;
  points: MarketSparkPoint[];
  total: number;
}

function groupKey(row: PriceSqlRow): string {
  return [row.category_code, row.region_code, row.spec_code ?? 'all', row.price_type].join('|');
}

/**
 * 每条价格记录只取最近 30 个点；rn/total 用窗口函数在库内算，避免把全表拉进内存。
 * 已撤回/草稿不进总览。
 */
async function loadPriceGroups(database: BeeDb): Promise<Map<string, PriceGroup>> {
  const result = await database.execute(sql`
    with ranked as (
      select pd.id,
             c.code as category_code,
             c.name_cn as category_name,
             c.sort_order as category_sort,
             s.code as spec_code,
             s.name as spec_name,
             r.code as region_code,
             r.name as region_name,
             r.level as region_level,
             pd.price_date::text as price_date,
             pd.price_type,
             pd.value_low::text as value_low,
             pd.value_high::text as value_high,
             pd.value_mid::text as value_mid,
             pd.unit,
             pd.currency,
             pd.note,
             pd.raw_url,
             pd.captured_at,
             src.code as source_code,
             src.name as source_name,
             row_number() over (
               partition by pd.category_id, pd.spec_id, pd.region_id, pd.price_type
               order by pd.price_date desc
             ) as rn,
             count(*) over (
               partition by pd.category_id, pd.spec_id, pd.region_id, pd.price_type
             ) as total
        from price_daily pd
        join category c on c.id = pd.category_id
        join region r on r.id = pd.region_id
        left join spec s on s.id = pd.spec_id
        left join source src on src.id = pd.source_id
       where pd.status = 'published'
    )
    select * from ranked
     where rn <= 30
     order by category_sort, category_code, region_code, spec_code nulls first, price_type, price_date asc
  `);

  const groups = new Map<string, PriceGroup>();
  for (const raw of result.rows as unknown as PriceSqlRow[]) {
    const value = numericToNumber(raw.value_mid);
    if (value === null) continue;
    const key = groupKey(raw);
    const existing = groups.get(key);
    if (existing) {
      existing.points.push({ date: raw.price_date.slice(0, 10), value });
    } else {
      groups.set(key, {
        meta: raw,
        points: [{ date: raw.price_date.slice(0, 10), value }],
        total: Number(raw.total),
      });
    }
  }
  return groups;
}

function toMarketRow(group: PriceGroup, globalLatest: string | null): MarketRow {
  const { meta, points, total } = group;
  const pointsAsc = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const pointsDesc = [...pointsAsc].reverse();
  const latest = pointsAsc[pointsAsc.length - 1]!;
  const frequency = inferFrequency(pointsAsc);
  const changes = changesFromPoints(pointsDesc, frequency);
  const trust = trustForQuote({ frequency, lastDate: latest.date, globalLatest });
  const specCode = meta.spec_code;
  const specName = meta.spec_name ?? '品类级';
  const slug = quoteSlug({
    categoryCode: meta.category_code,
    regionCode: meta.region_code,
    specCode,
    priceType: meta.price_type,
  });

  return {
    key: `price-${meta.category_code}-${meta.region_code}-${specCode ?? 'all'}-${meta.price_type}`,
    slug,
    kind: 'quote',
    scope: scopeOfRegion(meta.region_level),
    categoryCode: meta.category_code,
    categoryName: meta.category_name,
    instrument: meta.category_name,
    spec: specName,
    market: meta.source_name ? `${meta.region_name} · ${meta.source_name}` : meta.region_name,
    marketKind: '发布价格',
    unit: meta.unit,
    currency: meta.currency,
    frequency,
    frequencyLabel: frequencyLabel(frequency),
    latestValue: latest.value,
    latestDate: latest.date,
    dayChange: changes.day,
    weekChange: changes.week,
    pointCount: total,
    updatedAt: latest.date,
    trust: trust.trust,
    trustLabel: trust.label,
    spark: pointsAsc.slice(-30),
    note: meta.note,
    quoteId: meta.id,
  };
}

function sortRows(rows: MarketRow[]): MarketRow[] {
  return rows.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'international' ? -1 : 1;
    const catA = a.categoryName ?? a.instrument;
    const catB = b.categoryName ?? b.instrument;
    return (
      catA.localeCompare(catB, 'zh-CN') ||
      a.market.localeCompare(b.market, 'zh-CN') ||
      a.spec.localeCompare(b.spec, 'zh-CN') ||
      a.latestDate!.localeCompare(b.latestDate!)
    );
  });
}

async function loadRegionFacets(database: BeeDb, rows: MarketRow[]): Promise<MarketRegionFacet[]> {
  const regionRows = await database
    .select({ code: v4.region.code, name: v4.region.name })
    .from(v4.region)
    .where(inArray(v4.region.level, ['province', 'city', 'market']))
    .orderBy(v4.region.sortOrder, v4.region.name);

  return regionRows.map((region) => ({
    code: region.code,
    name: region.name,
    rowCount: rows.filter(
      (row) => row.scope === 'regional' && parseQuoteSlug(row.slug)?.regionCode === region.code,
    ).length,
  }));
}

export async function loadMarketOverview(database: BeeDb = defaultDb): Promise<MarketOverview> {
  const generatedAt = new Date().toISOString();

  const [categoryRows, groups] = await Promise.all([
    database
      .select({ code: v4.category.code, name: v4.category.nameCn, sortOrder: v4.category.sortOrder })
      .from(v4.category)
      .orderBy(v4.category.sortOrder, v4.category.code),
    loadPriceGroups(database),
  ]);

  const grouped = [...groups.values()];
  let globalLatest: string | null = null;
  for (const group of grouped) {
    for (const point of group.points) {
      if (!globalLatest || point.date > globalLatest) globalLatest = point.date;
    }
  }

  const rows = sortRows(grouped.map((group) => toMarketRow(group, globalLatest)));

  const categories: MarketCategoryFacet[] = categoryRows.map((category) => ({
    code: category.code,
    name: category.name,
    count: rows.filter((row) => row.categoryCode === category.code).length,
  }));

  const regions = await loadRegionFacets(database, rows);

  let dataCutoffAt: string | null = null;
  let statsSourceUrl: string | null = null;
  let statsSourceAt: string | null = null;
  let hasFixtureSource = false;
  for (const group of grouped) {
    const captured = group.meta.captured_at;
    const iso = captured instanceof Date ? captured.toISOString() : captured;
    if (iso && (!dataCutoffAt || iso > dataCutoffAt)) dataCutoffAt = iso;
    if (group.meta.source_code === STATS_SOURCE_CODE && group.meta.raw_url) {
      if (!statsSourceAt || (iso !== null && iso > statsSourceAt)) {
        statsSourceAt = iso;
        statsSourceUrl = group.meta.raw_url;
      }
    }
    if (
      group.meta.source_code?.startsWith('fixture') ||
      group.meta.source_code === 'open-cc0-sample'
    ) {
      hasFixtureSource = true;
    }
  }

  return {
    generatedAt,
    globalLatest,
    rows,
    categories,
    regions,
    counts: {
      series: 0,
      points: 0,
      quotes: rows.length,
      international: rows.filter((row) => row.scope === 'international').length,
      domestic: rows.filter((row) => row.scope === 'domestic').length,
      regional: rows.filter((row) => row.scope === 'regional').length,
    },
    dataCutoffAt,
    hasStatsSource: statsSourceUrl !== null || grouped.some((group) => group.meta.source_code === STATS_SOURCE_CODE),
    statsSourceUrl,
    hasFixtureSource,
  };
}

/** 轻量搜索索引：给全站头部搜索框做纯前端过滤用，不查询点位。 */
export async function loadSearchIndex(database: BeeDb = defaultDb): Promise<SearchItem[]> {
  const categories = await database
    .select({ code: v4.category.code, name: v4.category.nameCn })
    .from(v4.category)
    .orderBy(v4.category.sortOrder, v4.category.code);

  const priceResult = await database.execute(sql`
    select distinct on (pd.category_id, pd.spec_id, pd.region_id, pd.price_type)
           c.code as category_code,
           c.name_cn as category_name,
           s.code as spec_code,
           s.name as spec_name,
           r.code as region_code,
           r.name as region_name,
           pd.price_date::text as price_date,
           pd.price_type
      from price_daily pd
      join category c on c.id = pd.category_id
      join region r on r.id = pd.region_id
      left join spec s on s.id = pd.spec_id
     where pd.status = 'published'
     order by pd.category_id, pd.spec_id, pd.region_id, pd.price_type, pd.price_date desc
  `);

  const priceItems: SearchItem[] = (
    priceResult.rows as unknown as Array<{
      category_code: string;
      category_name: string;
      spec_code: string | null;
      spec_name: string | null;
      region_code: string;
      region_name: string;
      price_date: string;
      price_type: string;
    }>
  ).map((row) => {
    const slug = quoteSlug({
      categoryCode: row.category_code,
      regionCode: row.region_code,
      specCode: row.spec_code,
      priceType: row.price_type,
    });
    return {
      href: `/m/${slug}`,
      label: `${row.category_name} · ${row.spec_name ?? '品类级'} · ${row.region_name}`,
      meta: `${row.price_date} · ${PRICE_TYPE_LABEL[row.price_type] ?? row.price_type}`,
      keywords: `${row.category_name} ${row.spec_name ?? ''} ${row.region_name} ${row.price_date}`,
    };
  });

  return [
    ...categories.map((category) => ({
      href: `/?category=${encodeURIComponent(category.code)}`,
      label: category.name,
      meta: '品类筛选',
      keywords: category.name,
    })),
    ...priceItems,
  ];
}

/* ------------------------------------------------------------------ */
/* 旧期货合约选择器（v4 不接期货；保留纯函数以兼容既有单测，不查库）      */
/* ------------------------------------------------------------------ */

export interface SeriesSqlRow {
  id: string;
  code: string;
  name_cn: string;
  layer: string;
  kind: string;
  frequency: string;
  venue: string | null;
  instrument_code: string;
  currency: string;
  summary: string | null;
  status: string;
  category_code: string | null;
  category_name: string | null;
  category_sort: number | null;
  unit_name: string | null;
  point_count: number;
  last_date: string | null;
  obs_date: string | null;
  value: string | null;
  volume: string | null;
  is_main?: boolean;
}

/**
 * 从一个品种的多个合约里挑主力（成交量最大）。v4 不接期货，总览不再调用；
 * 保留导出是因为既有契约单测把它当作纯函数锁定。
 */
export function selectRepresentativeContracts<T extends { meta: SeriesSqlRow; points: MarketSparkPoint[] }>(
  entries: T[],
): T[] {
  const futures = new Map<string, T[]>();
  const rest: T[] = [];

  for (const entry of entries) {
    const { meta } = entry;
    if (meta.kind === 'futures' && meta.category_code && meta.instrument_code) {
      const key = `${meta.category_code}||${meta.instrument_code.toUpperCase()}`;
      const list = futures.get(key);
      if (list) list.push(entry);
      else futures.set(key, [entry]);
    } else {
      rest.push(entry);
    }
  }

  const volumeOf = (entry: { meta: SeriesSqlRow }): number => {
    const raw = entry.meta.volume;
    const parsed = raw === null ? null : Number(raw);
    return parsed !== null && Number.isFinite(parsed) ? parsed : -1;
  };

  const chosen: T[] = [];
  for (const list of futures.values()) {
    const sorted = [...list].sort((a, b) => {
      const diff = volumeOf(b) - volumeOf(a);
      if (diff !== 0) return diff;
      return a.meta.code.localeCompare(b.meta.code);
    });
    const best = sorted[0];
    if (best) chosen.push({ ...best, meta: { ...best.meta, is_main: true } });
  }

  const maxVolumeByCategory = new Map<string, number>();
  for (const entry of chosen) {
    const category = entry.meta.category_code ?? '';
    const volume = volumeOf(entry);
    if (volume <= 0) continue;
    const current = maxVolumeByCategory.get(category) ?? 0;
    if (volume > current) maxVolumeByCategory.set(category, volume);
  }
  const kept = chosen.filter((entry) => {
    const volume = volumeOf(entry);
    if (volume <= 0) return true;
    const max = maxVolumeByCategory.get(entry.meta.category_code ?? '') ?? 0;
    return max <= 0 || volume >= max * 0.2;
  });

  return [...rest, ...kept];
}