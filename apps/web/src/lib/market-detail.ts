import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { numericToNumber, timestampToIso } from '@bee/core';
import { db as defaultDb } from '../db';
import { PRICE_TYPE_LABEL, type PriceType } from './briefing-data';
import type { MarketChange, MarketSparkPoint, TrustMark } from './market-overview';
import { loadQuoteTrace } from './trace';

/**
 * 单品页数据层（行情台 v3）。
 *
 * 序列（期货 / 国际指数）与已发布报价（daily_quote）共用同一个页面结构，
 * 但数字来源分得很清楚：序列来自 series_point，报价来自 daily_quote；
 * 两者不互相换算、不拼成一条线。每个数字都能回到 raw_fetch。
 */

export interface DetailPoint {
  id: string;
  date: string;
  value: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  settle: number | null;
  volume: number | null;
  openInterest: number | null;
  revision: number;
}

export interface PointTraceRef {
  pointId: string;
  fetchId: string;
  sourceCode: string;
  sourceName: string;
  url: string;
  fetchedAt: string;
  contentSha256: string;
  sourceRowIndex: number;
}

export interface PeerChart {
  code: string;
  slug: string;
  label: string;
  market: string;
  unit: string;
  currency: string;
  points: MarketSparkPoint[];
  latestValue: number | null;
  latestDate: string | null;
}

export interface QuoteDetail {
  id: string;
  priceType: PriceType;
  priceTypeLabel: string;
  valueLow: number;
  valueHigh: number;
  valueMid: number;
  confidence: string;
  method: string;
  methodVersion: string;
  coverageNote: string | null;
  status: string;
  sources: Array<{ code: string; name: string; url: string; fetchedAt: string }>;
}

export interface RecentRow {
  id: string;
  date: string;
  value: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  settle: number | null;
  volume: number | null;
  openInterest: number | null;
  revision?: number;
  /** 报价行：区间与校验状态（序列行为 undefined）。 */
  valueLow?: number | null;
  valueHigh?: number | null;
  status?: string;
  /** 序列点：展开时调用 /api/trace/series/{id}。 */
  trace: PointTraceRef | null;
  /** 报价：展开时调用 /api/trace/quote/{id}。 */
  quoteId?: string;
}

export interface MarketDetail {
  kind: 'series' | 'quote';
  slug: string;
  categoryCode: string | null;
  categoryName: string | null;
  title: string;
  spec: string;
  market: string;
  marketKind: string;
  unit: string;
  currency: string;
  frequencyLabel: string;
  summary: string | null;
  sourceName: string | null;
  latestValue: number | null;
  latestDate: string | null;
  dayChange: MarketChange | null;
  weekChange: MarketChange | null;
  pointCount: number;
  trust: TrustMark;
  trustLabel: string;
  points: MarketSparkPoint[];
  recent: RecentRow[];
  peers: PeerChart[];
  quote: QuoteDetail | null;
}

const DAY_MS = 86_400_000;

function pct(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / DAY_MS);
}

function computeChanges(pointsAsc: MarketSparkPoint[], frequency: string): {
  day: MarketChange | null;
  week: MarketChange | null;
} {
  if (pointsAsc.length < 2) return { day: null, week: null };
  const latest = pointsAsc[pointsAsc.length - 1]!;
  const previous = pointsAsc[pointsAsc.length - 2]!;
  if (frequency !== 'daily' || daysBetween(latest.date, previous.date) > 7) {
    return { day: null, week: null };
  }
  const day = {
    date: previous.date,
    previousValue: previous.value,
    pct: pct(latest.value, previous.value),
  };
  const cutoff = addDays(latest.date, -7);
  let weekBase: MarketSparkPoint | null = null;
  for (const point of pointsAsc) {
    if (point.date <= cutoff && (!weekBase || point.date > weekBase.date)) weekBase = point;
  }
  return {
    day,
    week: weekBase
      ? { date: weekBase.date, previousValue: weekBase.value, pct: pct(latest.value, weekBase.value) }
      : null,
  };
}

function trustOf(lastDate: string | null, frequency: string): { trust: TrustMark; label: string } {
  if (!lastDate) return { trust: 'gap', label: '缺口' };
  // 序列详情不依赖「今天」，只判断数据本身是否还有近期更新；以数据库最新日期为参照。
  return { trust: 'normal', label: '正常' };
}

function frequencyLabel(frequency: string): string {
  if (frequency === 'daily') return '日频';
  if (frequency === 'monthly') return '月频';
  if (frequency === 'weekly') return '周频';
  return '不定期';
}

function marketKindLabel(kind: string): string {
  if (kind === 'futures') return '期货结算价';
  if (kind === 'index') return '指数';
  if (kind === 'inventory') return '库存';
  if (kind === 'macro') return '宏观';
  return '序列';
}

function slugForSeries(code: string): string {
  return `s-${code}`;
}

function slugForQuote(id: string): string {
  return `q-${id}`;
}

/* ------------------------------------------------------------------ */
/* 分层对比：同品类主力序列                                             */
/* ------------------------------------------------------------------ */

interface PeerMainRow {
  id: string;
  code: string;
  name_cn: string;
  layer: string;
  venue: string | null;
  instrument_code: string;
  currency: string;
  unit_name: string | null;
  value: string;
  obs_date: string;
}

async function loadPeerCharts(
  database: BeeDb,
  categoryId: string | null,
  current: { seriesId?: string; instrumentCode?: string | null },
): Promise<PeerChart[]> {
  if (!categoryId) return [];

  const mains = await database.execute(sql`
    with latest as (select max(obs_date) as max_date from series_point)
    select distinct on (s.venue, s.instrument_code, s.layer)
           s.id, s.code, s.name_cn, s.layer::text as layer, s.venue, s.instrument_code,
           s.currency, u.name_cn as unit_name,
           p.value::text as value, p.obs_date::text as obs_date
      from market_series s
      join series_point p on p.series_id = s.id
      join latest on true
      left join unit u on u.id = s.unit_id
     where s.display_allowed
       and s.status = 'active'
       and s.category_id = ${categoryId}
       and p.obs_date = (select max(p2.obs_date) from series_point p2 where p2.series_id = s.id)
       and p.obs_date >= latest.max_date - interval '30 days'
       ${current.seriesId ? sql`and s.id <> ${current.seriesId}` : sql``}
       ${current.instrumentCode ? sql`and s.instrument_code <> ${current.instrumentCode}` : sql``}
     order by s.venue, s.instrument_code, s.layer,
              (p.open_interest is null) asc, p.open_interest desc nulls last,
              p.volume desc nulls last, s.code
  `);

  const selected = mains.rows as unknown as PeerMainRow[];
  if (selected.length === 0) return [];

  const ids = selected.map((row) => row.id);
  const pointResult = await database.execute(sql`
    select series_id, obs_date::text as obs_date, value::text as value
      from (
        select series_id, obs_date, value,
               row_number() over (partition by series_id order by obs_date desc) as rn
          from series_point
         where ${inArray(dbSchema.seriesPoint.seriesId, ids)}
      ) recent
     where rn <= 30
     order by series_id, obs_date
  `);

  const pointsBySeries = new Map<string, MarketSparkPoint[]>();
  for (const raw of pointResult.rows as Array<{ series_id: string; obs_date: string; value: string }>) {
    const value = numericToNumber(raw.value);
    if (value === null) continue;
    const list = pointsBySeries.get(raw.series_id) ?? [];
    list.push({ date: raw.obs_date.slice(0, 10), value });
    pointsBySeries.set(raw.series_id, list);
  }

  return selected.map((row) => {
    const points = pointsBySeries.get(row.id) ?? [];
    return {
      code: row.code,
      slug: slugForSeries(row.code),
      label: row.name_cn,
      market: [row.venue ?? '—', row.layer === 'international' ? '国际基准' : '期货'].join(' · '),
      unit: row.unit_name ?? (row.currency === 'USD' ? '美元/吨' : '元/吨'),
      currency: row.currency,
      points,
      latestValue: numericToNumber(row.value),
      latestDate: row.obs_date.slice(0, 10),
    };
  });
}

/* ------------------------------------------------------------------ */
/* 序列单品                                                            */
/* ------------------------------------------------------------------ */

async function loadSeriesDetail(database: BeeDb, code: string): Promise<MarketDetail | null> {
  const [series] = await database
    .select({
      id: dbSchema.marketSeries.id,
      code: dbSchema.marketSeries.code,
      nameCn: dbSchema.marketSeries.nameCn,
      layer: dbSchema.marketSeries.layer,
      kind: dbSchema.marketSeries.kind,
      frequency: dbSchema.marketSeries.frequency,
      venue: dbSchema.marketSeries.venue,
      instrumentCode: dbSchema.marketSeries.instrumentCode,
      currency: dbSchema.marketSeries.currency,
      summary: dbSchema.marketSeries.summary,
      status: dbSchema.marketSeries.status,
      categoryId: dbSchema.marketSeries.categoryId,
      categoryCode: dbSchema.category.code,
      categoryName: dbSchema.category.nameCn,
      unitName: dbSchema.unit.nameCn,
      sourceName: dbSchema.source.name,
    })
    .from(dbSchema.marketSeries)
    .leftJoin(dbSchema.category, eq(dbSchema.category.id, dbSchema.marketSeries.categoryId))
    .leftJoin(dbSchema.unit, eq(dbSchema.unit.id, dbSchema.marketSeries.unitId))
    .innerJoin(dbSchema.source, eq(dbSchema.source.id, dbSchema.marketSeries.sourceId))
    .where(eq(dbSchema.marketSeries.code, code));

  if (!series) return null;

  const pointRows = await database
    .select({
      id: dbSchema.seriesPoint.id,
      date: dbSchema.seriesPoint.obsDate,
      value: dbSchema.seriesPoint.value,
      open: dbSchema.seriesPoint.openPrice,
      high: dbSchema.seriesPoint.highPrice,
      low: dbSchema.seriesPoint.lowPrice,
      close: dbSchema.seriesPoint.closePrice,
      settle: dbSchema.seriesPoint.settlePrice,
      volume: dbSchema.seriesPoint.volume,
      openInterest: dbSchema.seriesPoint.openInterest,
      revision: dbSchema.seriesPoint.revision,
      fetchId: dbSchema.seriesPoint.fetchId,
      sourceRowIndex: dbSchema.seriesPoint.sourceRowIndex,
    })
    .from(dbSchema.seriesPoint)
    .where(eq(dbSchema.seriesPoint.seriesId, series.id))
    .orderBy(asc(dbSchema.seriesPoint.obsDate), asc(dbSchema.seriesPoint.revision));

  const points: MarketSparkPoint[] = [];
  const allPoints: DetailPoint[] = [];
  // 同一天可能有修正版本（revision+1）：图表与表格只呈现该日最高版本，修正历史仍留在库里。
  const chosenByDate = new Map<string, (typeof pointRows)[number]>();
  for (const row of pointRows) {
    if (numericToNumber(row.value) === null) continue;
    const existing = chosenByDate.get(row.date);
    if (!existing || row.revision > existing.revision) chosenByDate.set(row.date, row);
  }
  const chosenRows = [...chosenByDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const row of chosenRows) {
    const value = numericToNumber(row.value);
    if (value === null) continue;
    points.push({ date: row.date, value });
    allPoints.push({
      id: row.id,
      date: row.date,
      value,
      open: numericToNumber(row.open),
      high: numericToNumber(row.high),
      low: numericToNumber(row.low),
      close: numericToNumber(row.close),
      settle: numericToNumber(row.settle),
      volume: numericToNumber(row.volume),
      openInterest: numericToNumber(row.openInterest),
      revision: row.revision,
    });
  }

  const recentPoints = allPoints.slice(-30);
  const recentIds = new Set(recentPoints.map((point) => point.id));
  const fetchIds = [...new Set(pointRows.filter((row) => recentIds.has(row.id)).map((row) => row.fetchId))];
  const fetchRows =
    fetchIds.length === 0
      ? []
      : await database
          .select({
            id: dbSchema.rawFetch.id,
            url: dbSchema.rawFetch.url,
            fetchedAt: dbSchema.rawFetch.fetchedAt,
            contentSha256: dbSchema.rawFetch.contentSha256,
            sourceCode: dbSchema.source.code,
            sourceName: dbSchema.source.name,
          })
          .from(dbSchema.rawFetch)
          .innerJoin(dbSchema.source, eq(dbSchema.source.id, dbSchema.rawFetch.sourceId))
          .where(inArray(dbSchema.rawFetch.id, fetchIds));
  const fetchById = new Map(fetchRows.map((row) => [row.id, row]));

  const recent: RecentRow[] = recentPoints.map((point) => {
    const source = pointRows.find((row) => row.id === point.id);
    const fetch = source ? fetchById.get(source.fetchId) : undefined;
    const fetchedAt = fetch ? timestampToIso(fetch.fetchedAt) : null;
    return {
      ...point,
      trace:
        fetch && fetchedAt && source
          ? {
              pointId: point.id,
              fetchId: fetch.id,
              sourceCode: fetch.sourceCode,
              sourceName: fetch.sourceName,
              url: fetch.url,
              fetchedAt,
              contentSha256: fetch.contentSha256,
              sourceRowIndex: source.sourceRowIndex,
            }
          : null,
    };
  });

  const latest = points[points.length - 1] ?? null;
  const changes = computeChanges(points, series.frequency);
  const trust = trustOf(latest?.date ?? null, series.frequency);
  const peers = await loadPeerCharts(database, series.categoryId, {
    seriesId: series.id,
    instrumentCode: series.instrumentCode,
  });

  return {
    kind: 'series',
    slug: slugForSeries(series.code),
    categoryCode: series.categoryCode,
    categoryName: series.categoryName,
    title: series.categoryName ?? series.nameCn,
    spec: series.nameCn,
    market: [series.venue ?? '—', marketKindLabel(series.kind)].join(' · '),
    marketKind: marketKindLabel(series.kind),
    unit: series.unitName ?? (series.currency === 'USD' ? '美元/吨' : '元/吨'),
    currency: series.currency,
    frequencyLabel: frequencyLabel(series.frequency),
    summary: series.summary,
    sourceName: series.sourceName,
    latestValue: latest?.value ?? null,
    latestDate: latest?.date ?? null,
    dayChange: changes.day,
    weekChange: changes.week,
    pointCount: points.length,
    trust: trust.trust,
    trustLabel: trust.label,
    points,
    recent,
    peers,
    quote: null,
  };
}

/* ------------------------------------------------------------------ */
/* 报价单品                                                            */
/* ------------------------------------------------------------------ */

async function loadQuoteDetail(database: BeeDb, id: string): Promise<MarketDetail | null> {
  const [quote] = await database
    .select({
      id: dbSchema.dailyQuote.id,
      categoryId: dbSchema.dailyQuote.categoryId,
      categoryCode: dbSchema.category.code,
      categoryName: dbSchema.category.nameCn,
      specId: dbSchema.dailyQuote.specId,
      specName: dbSchema.specGrade.nameCn,
      regionId: dbSchema.dailyQuote.regionId,
      regionName: dbSchema.region.nameCn,
      quoteDate: dbSchema.dailyQuote.quoteDate,
      priceType: dbSchema.dailyQuote.priceType,
      valueLow: dbSchema.dailyQuote.valueLow,
      valueHigh: dbSchema.dailyQuote.valueHigh,
      valueMid: dbSchema.dailyQuote.valueMid,
      method: dbSchema.dailyQuote.method,
      methodVersion: dbSchema.dailyQuote.methodVersion,
      confidence: dbSchema.dailyQuote.confidence,
      coverageNote: dbSchema.dailyQuote.coverageNote,
      status: dbSchema.dailyQuote.status,
    })
    .from(dbSchema.dailyQuote)
    .innerJoin(dbSchema.category, eq(dbSchema.category.id, dbSchema.dailyQuote.categoryId))
    .innerJoin(dbSchema.specGrade, eq(dbSchema.specGrade.id, dbSchema.dailyQuote.specId))
    .innerJoin(dbSchema.region, eq(dbSchema.region.id, dbSchema.dailyQuote.regionId))
    .where(and(eq(dbSchema.dailyQuote.id, id), eq(dbSchema.dailyQuote.status, 'published')));

  if (!quote) return null;

  const historyRows = await database
    .select({
      id: dbSchema.dailyQuote.id,
      quoteDate: dbSchema.dailyQuote.quoteDate,
      valueLow: dbSchema.dailyQuote.valueLow,
      valueHigh: dbSchema.dailyQuote.valueHigh,
      valueMid: dbSchema.dailyQuote.valueMid,
      priceType: dbSchema.dailyQuote.priceType,
      coverageNote: dbSchema.dailyQuote.coverageNote,
      confidence: dbSchema.dailyQuote.confidence,
      method: dbSchema.dailyQuote.method,
      methodVersion: dbSchema.dailyQuote.methodVersion,
      status: dbSchema.dailyQuote.status,
    })
    .from(dbSchema.dailyQuote)
    .where(
      and(
        eq(dbSchema.dailyQuote.categoryId, quote.categoryId),
        eq(dbSchema.dailyQuote.specId, quote.specId),
        eq(dbSchema.dailyQuote.regionId, quote.regionId),
        eq(dbSchema.dailyQuote.priceType, quote.priceType),
        eq(dbSchema.dailyQuote.status, 'published'),
      ),
    )
    .orderBy(asc(dbSchema.dailyQuote.quoteDate));

  const trace = await loadQuoteTrace(id, database);
  const sources =
    trace?.observations.map((observation) => ({
      code: observation.source.code,
      name: observation.source.name,
      url: observation.url,
      fetchedAt: observation.fetchedAt,
    })) ?? [];

  const points: MarketSparkPoint[] = [];
  const recent: RecentRow[] = [];
  for (const row of historyRows) {
    const value = numericToNumber(row.valueMid);
    if (value === null) continue;
    points.push({ date: row.quoteDate, value });
    recent.push({
      id: row.id,
      date: row.quoteDate,
      value,
      open: null,
      high: null,
      low: null,
      close: null,
      settle: null,
      volume: null,
      openInterest: null,
      revision: undefined,
      valueLow: numericToNumber(row.valueLow),
      valueHigh: numericToNumber(row.valueHigh),
      status: row.status,
      trace: null,
      quoteId: row.id,
    });
  }

  const changes = computeChanges(points, 'irregular');
  const latest = points[points.length - 1] ?? null;
  const peers = await loadPeerCharts(database, quote.categoryId, { instrumentCode: null });

  return {
    kind: 'quote',
    slug: slugForQuote(quote.id),
    categoryCode: quote.categoryCode,
    categoryName: quote.categoryName,
    title: quote.categoryName,
    spec: quote.specName,
    market: quote.regionName,
    marketKind: '已发布报价',
    unit: '元/吨',
    currency: 'CNY',
    frequencyLabel: '旬价',
    summary: quote.coverageNote,
    sourceName: sources[0]?.name ?? null,
    latestValue: latest?.value ?? null,
    latestDate: latest?.date ?? null,
    dayChange: changes.day,
    weekChange: changes.week,
    pointCount: points.length,
    trust: 'reference',
    trustLabel: '参考锚点',
    points,
    recent: recent.slice(-30),
    peers,
    quote: {
      id: quote.id,
      priceType: quote.priceType,
      priceTypeLabel: PRICE_TYPE_LABEL[quote.priceType],
      valueLow: numericToNumber(quote.valueLow) ?? 0,
      valueHigh: numericToNumber(quote.valueHigh) ?? 0,
      valueMid: numericToNumber(quote.valueMid) ?? 0,
      confidence: quote.confidence,
      method: quote.method,
      methodVersion: quote.methodVersion,
      coverageNote: quote.coverageNote,
      status: quote.status,
      sources,
    },
  };
}

/** slug → 单品数据；未知 slug 返回 null（页面 404）。 */
export async function loadMarketDetail(slug: string, database: BeeDb = defaultDb): Promise<MarketDetail | null> {
  if (slug.startsWith('s-')) return loadSeriesDetail(database, slug.slice(2));
  if (slug.startsWith('q-')) return loadQuoteDetail(database, slug.slice(2));
  return null;
}

export { slugForQuote, slugForSeries };