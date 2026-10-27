import { sql } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { numericToNumber } from '@bee/core';
import { db as defaultDb } from '../db';
import { loadBriefing } from './briefing-data';
import { STATS_SOURCE_CODE } from './compliance';

/**
 * 行情总览数据层（行情台 v3）。
 *
 * 只读 market_series / series_point 与 daily_quote，不接受任何手写行情数字。
 * 两条数据链在这里并列展示但永不混合计算：
 *  - market_series + series_point = 交易所结算价 / 国际指数（预期价或基准，非现货）；
 *  - daily_quote = 已发布现货/统计报价（当前为国家统计局旬价全国参考锚点）。
 *
 * 缺口表达：区域层没有数据时返回空数组 + 区域骨架，页面显示「待接入」，
 * 不用其他层级的数据顶替，也不补点、不插值。
 */

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

function pct(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / DAY_MS);
}

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, 10);
}

function frequencyLabel(frequency: string): string {
  if (frequency === 'daily') return '日频';
  if (frequency === 'monthly') return '月频';
  if (frequency === 'weekly') return '周频';
  return '不定期';
}

function marketKindLabel(kind: string): string {
  if (kind === 'futures') return '期货';
  if (kind === 'index') return '指数';
  if (kind === 'inventory') return '库存';
  if (kind === 'macro') return '宏观';
  return '序列';
}

function trustForSeries(input: {
  frequency: string;
  lastDate: string | null;
  globalLatest: string | null;
}): { trust: TrustMark; label: string } {
  if (!input.lastDate) return { trust: 'gap', label: '缺口' };
  if (!input.globalLatest) return { trust: 'normal', label: '正常' };
  const age = daysBetween(input.globalLatest, input.lastDate);
  const limit = input.frequency === 'monthly' ? 62 : 10;
  if (age > limit) return { trust: 'review', label: '待复核' };
  return { trust: 'normal', label: '正常' };
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
  /** 展示层标记：该合约是否为所属品种的成交主力（只在总览里挑一个）。 */
  is_main?: boolean;
}

interface QuoteSqlRow {
  category_code: string;
  category_name: string;
  quote: Awaited<ReturnType<typeof loadBriefing>>['categories'][number]['quotes'][number];
}

function quoteScope(row: QuoteSqlRow): MarketScope {
  // 统计局全国参考锚点属于「国内全国」层；其他已发布现货报价按地域层级归入区域层。
  if (row.quote.regionName.includes('全国参考')) return 'domestic';
  return 'regional';
}

function quoteMarket(row: QuoteSqlRow): { market: string; kind: string } {
  const hasStats = row.quote.sources.some((source) => source.code === 'stats-cn');
  if (hasStats) return { market: '国家统计局 · 旬价', kind: '统计报价' };
  const source = row.quote.sources[0];
  return { market: source ? `${source.name} · 现货` : '已发布报价', kind: '现货报价' };
}

function toQuoteRow(row: QuoteSqlRow): MarketRow {
  const { quote } = row;
  const { market, kind } = quoteMarket(row);
  return {
    key: `quote-${quote.id}`,
    slug: `q-${quote.id}`,
    kind: 'quote',
    scope: quoteScope(row),
    categoryCode: row.category_code,
    categoryName: row.category_name,
    instrument: row.category_name,
    spec: quote.specName,
    market,
    marketKind: kind,
    unit: '元/吨',
    currency: 'CNY',
    frequency: 'irregular',
    frequencyLabel: '旬价',
    latestValue: quote.valueMid,
    latestDate: quote.quoteDate,
    dayChange: quote.previousTradingDay
      ? {
          date: quote.previousTradingDay.quoteDate,
          previousValue: quote.previousTradingDay.previousValue,
          pct: quote.previousTradingDay.pct,
        }
      : null,
    weekChange: quote.weekAgo
      ? {
          date: quote.weekAgo.quoteDate,
          previousValue: quote.weekAgo.previousValue,
          pct: quote.weekAgo.pct,
        }
      : null,
    pointCount: 1,
    updatedAt: quote.fetchedTo?.slice(0, 10) ?? quote.quoteDate,
    trust: 'reference',
    trustLabel: '参考锚点',
    spark: [{ date: quote.quoteDate, value: quote.valueMid }],
    note: quote.coverageNote,
    quoteId: quote.id,
  };
}

/** 全库序列/点位计数（页头读数，来自库）。 */
async function loadTotals(database: BeeDb): Promise<{ series: number; points: number }> {
  const result = await database.execute(sql`
    select (select count(*)::int from market_series) as series,
           (select count(*)::int from series_point) as points
  `);
  const row = result.rows[0] as { series: number; points: number } | undefined;
  return { series: row?.series ?? 0, points: row?.points ?? 0 };
}

/**
 * 总览查询：只取「可对外展示」且当前仍有数据的国内品类序列 + 国际基准，
 * 已过期合约不混进今日列表；它们仍在库里，单品页与溯源不受影响。
 */
/** 合约代码末尾的 YYMM，用来在同成交量时按「先到期」排序。 */
function expiryOf(code: string): number {
  const match = code.match(/(\d{3,4})$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** 交易所口径：ine.* 属于上期能源，shfe.* 属于上期所；bc 两边都登记过，按代码前缀认。 */
function canonicalVenue(code: string, venue: string | null): string {
  const prefix = code.split('.')[0]?.toUpperCase();
  return prefix === 'SHFE' || prefix === 'INE' || prefix === 'CZCE' || prefix === 'DCE' || prefix === 'GFEX'
    ? prefix
    : (venue ?? '');
}

/**
 * 总览只展示「一个品种一个合约」：同一品种（category + instrument）里挑成交量最大的主力合约。
 *
 * 为什么要在展示层挑：交易所目录里有几十个交割月（cu2610…cu2709），
 * 逐月铺开等于把合约表当行情表，用户要的是一条「今天的铜价」。
 * 库里数据不删、不聚合，单品页与溯源仍能查到每个合约。
 *
 * 顺带处理两个已知的数据毛刺：
 *  1. bc（国际铜）同时被登记成 shfe.bc* 与 ine.bc*，按代码前缀认归属，避免同一合约出现两次；
 *  2. 成交清淡的品种（如国际铜，约为沪铜的十分之一）不进总览，阈值 20%，避免并列一堆没人交易的合约。
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

  // 每个品种先挑一个主力合约。
  const chosen: T[] = [];
  for (const list of futures.values()) {
    const sorted = [...list].sort((a, b) => {
      const diff = volumeOf(b) - volumeOf(a);
      if (diff !== 0) return diff;
      // 同一合约被两个场所重复登记时，认代码前缀对应的那个场所。
      const venueA = canonicalVenue(a.meta.code, a.meta.venue) === a.meta.venue ? 0 : 1;
      const venueB = canonicalVenue(b.meta.code, b.meta.venue) === b.meta.venue ? 0 : 1;
      if (venueA !== venueB) return venueA - venueB;
      const expiry = expiryOf(a.meta.code) - expiryOf(b.meta.code);
      if (expiry !== 0) return expiry;
      return a.meta.code.localeCompare(b.meta.code);
    });
    const best = sorted[0];
    if (best) chosen.push({ ...best, meta: { ...best.meta, is_main: true } });
  }

  // 再按品类剔除成交明显偏薄的品种（< 该品类主力成交量的 20%）。
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
    if (volume <= 0) return true; // 没有成交量字段的品种一律保留，不猜。
    const max = maxVolumeByCategory.get(entry.meta.category_code ?? '') ?? 0;
    return max <= 0 || volume >= max * 0.2;
  });

  return [...rest, ...kept];
}

function pickRepresentativeContracts<T extends { meta: SeriesSqlRow; points: MarketSparkPoint[] }>(
  grouped: Map<string, T>,
): T[] {
  return selectRepresentativeContracts([...grouped.values()]);
}

async function loadSeriesRows(database: BeeDb): Promise<{ rows: MarketRow[]; globalLatest: string | null }> {
  const result = await database.execute(sql`
    with latest as (
      select max(obs_date) as max_date from series_point
    ),
    scoped as (
      select s.id, s.code, s.name_cn, s.layer::text as layer, s.kind::text as kind,
             s.frequency::text as frequency, s.venue, s.instrument_code, s.currency,
             s.summary, s.status::text as status, s.category_id,
             c.code as category_code, c.name_cn as category_name, c.sort_order as category_sort,
             u.name_cn as unit_name,
             stats.cnt::int as point_count, stats.last_date
        from market_series s
        left join category c on c.id = s.category_id
        left join unit u on u.id = s.unit_id
        join lateral (
          select count(distinct obs_date)::int as cnt, max(p.obs_date) as last_date
            from series_point p where p.series_id = s.id
        ) stats on true
        join latest on true
       where s.display_allowed
         and s.status = 'active'
         and (
           s.layer = 'international'
           or (s.category_id is not null and stats.last_date >= latest.max_date - interval '30 days')
         )
    )
    select scoped.*, p.obs_date::text as obs_date, p.value::text as value, p.volume::text as volume
      from scoped
      join lateral (
        select obs_date, value, volume
          from series_point
         where series_id = scoped.id
         order by obs_date desc, revision desc
         limit 31
      ) p on true
     order by scoped.layer, scoped.category_sort nulls last, scoped.venue,
              scoped.instrument_code, scoped.code, p.obs_date desc
  `);

  const grouped = new Map<string, { meta: SeriesSqlRow; points: MarketSparkPoint[] }>();
  for (const raw of result.rows as unknown as SeriesSqlRow[]) {
    const lastDate = isoDate(raw.last_date);
    const obsDate = isoDate(raw.obs_date);
    const value = numericToNumber(raw.value);
    if (!obsDate || value === null) continue;
    // 每个合约只认最新一天的成交量（查询已按 obs_date 降序，第一次即最新）。
    const volume = numericToNumber(raw.volume);
    const row = grouped.get(raw.id);
    if (row) {
      // 同一天可能有修正版本；查询已按 revision 降序，只保留第一条。
      if (!row.points.some((point) => point.date === obsDate)) {
        row.points.push({ date: obsDate, value });
      }
    } else {
      grouped.set(raw.id, {
        meta: { ...raw, last_date: lastDate, volume: volume === null ? null : String(volume) },
        points: [{ date: obsDate, value }],
      });
    }
  }

  const groupedEntries = pickRepresentativeContracts(grouped);

  let globalLatest: string | null = null;
  for (const { meta } of groupedEntries) {
    if (meta.last_date && (!globalLatest || meta.last_date > globalLatest)) globalLatest = meta.last_date;
  }

  const rows: MarketRow[] = [];
  for (const { meta, points } of groupedEntries) {
    const pointsDesc = [...points].sort((a, b) => (a.date < b.date ? 1 : -1));
    const latest = pointsDesc[0] ?? null;
    if (!latest || !meta.last_date) continue;
    const changes = changesFromPoints(pointsDesc, meta.frequency);
    const trust = trustForSeries({
      frequency: meta.frequency,
      lastDate: meta.last_date,
      globalLatest: globalLatest,
    });
    const scope: MarketScope =
      meta.layer === 'international' ? 'international' : meta.layer === 'regional' ? 'regional' : 'domestic';
    const parsed = meta.name_cn.match(/^(.*?)\s+([A-Za-z]+\d+)$/);
    const instrument = meta.category_name ?? parsed?.[1] ?? meta.name_cn;
    const spec = meta.category_name ? meta.name_cn : meta.frequency === 'monthly' ? '月均指数' : meta.kind;
    rows.push({
      key: `series-${meta.id}`,
      slug: `s-${meta.code}`,
      kind: 'series',
      scope,
      categoryCode: meta.category_code,
      categoryName: meta.category_name,
      instrument,
      spec,
      // 总览里期货只展示一个主力合约，标签要写清楚，别让读者以为是「唯一报价」。
      market: [meta.venue ?? '—', marketKindLabel(meta.kind), meta.is_main && meta.kind === 'futures' ? '主力' : '']
        .filter(Boolean)
        .join(' · '),
      marketKind: marketKindLabel(meta.kind),
      unit: meta.unit_name ?? (meta.currency === 'USD' ? '美元/吨' : '元/吨'),
      currency: meta.currency,
      frequency: meta.frequency as MarketRow['frequency'],
      frequencyLabel: frequencyLabel(meta.frequency),
      latestValue: latest.value,
      latestDate: latest.date,
      dayChange: changes.day,
      weekChange: changes.week,
      pointCount: meta.point_count,
      updatedAt: latest.date,
      trust: trust.trust,
      trustLabel: trust.label,
      spark: [...points].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-30),
      note: meta.summary,
      seriesId: meta.id,
    });
  }

  // 统一按「国际 / 国内」分开后由页面排序；这里保持库内稳定的品类→市场顺序。
  rows.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'international' ? -1 : 1;
    const catA = a.categoryName ?? a.instrument;
    const catB = b.categoryName ?? b.instrument;
    return (
      catA.localeCompare(catB, 'zh-CN') ||
      a.market.localeCompare(b.market, 'zh-CN') ||
      a.spec.localeCompare(b.spec, 'zh-CN')
    );
  });

  return { rows, globalLatest };
}

async function loadRegionFacets(database: BeeDb, rows: MarketRow[]): Promise<MarketRegionFacet[]> {
  const result = await database.execute(sql`
    select code, name_cn from region
     where level = 'macro_region' and code <> 'cn-reference'
     order by name_cn
  `);
  return (result.rows as Array<{ code: string; name_cn: string }>).map((region) => ({
    code: region.code,
    name: region.name_cn,
    rowCount: rows.filter((row) => row.scope === 'regional' && row.market.includes(region.name_cn)).length,
  }));
}

export async function loadMarketOverview(database: BeeDb = defaultDb): Promise<MarketOverview> {
  const generatedAt = new Date().toISOString();
  const [seriesResult, briefing, totals] = await Promise.all([
    loadSeriesRows(database),
    loadBriefing(database),
    loadTotals(database),
  ]);

  const quoteRows: MarketRow[] = briefing.categories.flatMap((category) =>
    category.quotes.map((quote) =>
      toQuoteRow({
        category_code: category.code,
        category_name: category.name,
        quote,
      }),
    ),
  );

  const rows = [...seriesResult.rows, ...quoteRows];
  const globalLatest =
    seriesResult.globalLatest ??
    briefing.latestQuoteDate ??
    null;

  const categories: MarketCategoryFacet[] = briefing.categories.map((category) => ({
    code: category.code,
    name: category.name,
    count: rows.filter((row) => row.categoryCode === category.code).length,
  }));

  const regions = await loadRegionFacets(database, rows);
  const statsSource = briefing.sources.find((source) => source.code === STATS_SOURCE_CODE);

  return {
    generatedAt,
    globalLatest,
    rows,
    categories,
    regions,
    counts: {
      series: totals.series,
      points: totals.points,
      quotes: quoteRows.length,
      international: rows.filter((row) => row.scope === 'international').length,
      domestic: rows.filter((row) => row.scope === 'domestic').length,
      regional: rows.filter((row) => row.scope === 'regional').length,
    },
    dataCutoffAt: briefing.dataCutoffAt,
    hasStatsSource: Boolean(statsSource),
    statsSourceUrl: statsSource?.latestFetchUrl ?? null,
    hasFixtureSource: briefing.sources.some(
      (source) => source.code.startsWith('fixture') || source.code === 'open-cc0-sample',
    ),
  };
}

/** 轻量搜索索引：给全站头部搜索框做纯前端过滤用，不查询点位。 */
export async function loadSearchIndex(database: BeeDb = defaultDb): Promise<SearchItem[]> {
  const [seriesResult, quoteResult, categories] = await Promise.all([
    database
      .select({
        code: dbSchema.marketSeries.code,
        nameCn: dbSchema.marketSeries.nameCn,
        venue: dbSchema.marketSeries.venue,
        layer: dbSchema.marketSeries.layer,
        categoryName: dbSchema.category.nameCn,
      })
      .from(dbSchema.marketSeries)
      .leftJoin(dbSchema.category, sql`${dbSchema.category.id} = ${dbSchema.marketSeries.categoryId}`)
      .where(sql`${dbSchema.marketSeries.displayAllowed} = true and (${dbSchema.marketSeries.categoryId} is not null or ${dbSchema.marketSeries.layer} = 'international')`)
      .orderBy(dbSchema.marketSeries.code),
    database
      .select({
        id: dbSchema.dailyQuote.id,
        quoteDate: dbSchema.dailyQuote.quoteDate,
        categoryName: dbSchema.category.nameCn,
        specName: dbSchema.specGrade.nameCn,
        regionName: dbSchema.region.nameCn,
      })
      .from(dbSchema.dailyQuote)
      .innerJoin(dbSchema.category, sql`${dbSchema.category.id} = ${dbSchema.dailyQuote.categoryId}`)
      .innerJoin(dbSchema.specGrade, sql`${dbSchema.specGrade.id} = ${dbSchema.dailyQuote.specId}`)
      .innerJoin(dbSchema.region, sql`${dbSchema.region.id} = ${dbSchema.dailyQuote.regionId}`)
      .where(sql`${dbSchema.dailyQuote.status} = 'published'`)
      .orderBy(dbSchema.dailyQuote.quoteDate),
    database.select({ code: dbSchema.category.code, name: dbSchema.category.nameCn }).from(dbSchema.category),
  ]);

  const items: SearchItem[] = [
    ...categories.map((category) => ({
      href: `/?category=${encodeURIComponent(category.code)}`,
      label: category.name,
      meta: '品类筛选',
      keywords: category.name,
    })),
    ...seriesResult.map((series) => ({
      href: `/m/s-${series.code}`,
      label: series.categoryName ? `${series.categoryName} · ${series.nameCn}` : series.nameCn,
      meta: [series.venue ?? '', series.layer === 'international' ? '国际' : '国内'].filter(Boolean).join(' · '),
      keywords: `${series.categoryName ?? ''} ${series.nameCn} ${series.code} ${series.venue ?? ''}`,
    })),
    ...quoteResult.map((quote) => ({
      href: `/m/q-${quote.id}`,
      label: `${quote.categoryName} · ${quote.specName} · ${quote.regionName}`,
      meta: `${quote.quoteDate} · 参考报价`,
      keywords: `${quote.categoryName} ${quote.specName} ${quote.regionName} ${quote.quoteDate}`,
    })),
  ];
  return items;
}