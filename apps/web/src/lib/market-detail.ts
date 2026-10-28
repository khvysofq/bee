import { and, asc, desc, eq, gte, isNull } from 'drizzle-orm';
import { v4, type BeeDb } from '@bee/db';
import { numericToNumber, timestampToIso } from '@bee/core';
import { db as defaultDb } from '../db';
import { PRICE_TYPE_LABEL, type PriceType } from './briefing-data';
import { parseQuoteSlug } from './market-types';
import type { MarketChange, MarketSparkPoint, TrustMark } from './market-overview';
import type { MarketDetail, PeerChart, QuoteDetail, RecentRow } from './market-detail-types';

/**
 * 单品页数据层（v4）。
 *
 * 解析稳定 slug `p-<categoryCode>-<regionCode>-<specCode|all>-<priceType>`，
 * 按 category / region / spec / price_type 查 price_daily 历史（最多 365 天）。
 * v4 不接期货序列：s- / q- 等旧 slug 一律返回 null（404）。
 *
 * v4 没有观测层与聚合层：quote.method / confidence 等旧字段用明确默认值，
 * 不伪造 observation id，也不把单源直取说成多源聚合。
 */

export type {
  DetailPoint,
  MarketDetail,
  PeerChart,
  PointTraceRef,
  QuoteDetail,
  RecentRow,
} from './market-detail-types';

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 365;

function pct(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / DAY_MS,
  );
}

function frequencyLabel(frequency: string): string {
  if (frequency === 'daily') return '日频';
  if (frequency === 'monthly') return '月频';
  if (frequency === 'weekly') return '周频';
  return '不定期';
}

/** 从真实点位间隔推断频次；不足两点按不定期处理。 */
function inferFrequency(pointsAsc: MarketSparkPoint[]): MarketDetailFrequency {
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

type MarketDetailFrequency = 'daily' | 'monthly' | 'weekly' | 'irregular';

function computeChanges(
  pointsAsc: MarketSparkPoint[],
  frequency: string,
): { day: MarketChange | null; week: MarketChange | null } {
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

function priceTypeLabel(priceType: string): string {
  return PRICE_TYPE_LABEL[priceType as PriceType] ?? priceType;
}

/** 按 slug 里的品类/地域/规格/价类型查库；查不到返回 null。 */
async function loadQuoteDetail(
  database: BeeDb,
  parsed: NonNullable<ReturnType<typeof parseQuoteSlug>>,
  slug: string,
): Promise<MarketDetail | null> {
  const specCondition =
    parsed.specCode === null ? isNull(v4.priceDaily.specId) : eq(v4.spec.code, parsed.specCode);
  const baseConditions = and(
    eq(v4.category.code, parsed.categoryCode),
    eq(v4.region.code, parsed.regionCode),
    eq(v4.priceDaily.priceType, parsed.priceType),
    eq(v4.priceDaily.status, 'published'),
    specCondition,
  );

  const selectShape = {
    id: v4.priceDaily.id,
    categoryId: v4.priceDaily.categoryId,
    categoryCode: v4.category.code,
    categoryName: v4.category.nameCn,
    specCode: v4.spec.code,
    specName: v4.spec.name,
    regionCode: v4.region.code,
    regionName: v4.region.name,
    regionLevel: v4.region.level,
    priceDate: v4.priceDaily.priceDate,
    priceType: v4.priceDaily.priceType,
    valueLow: v4.priceDaily.valueLow,
    valueHigh: v4.priceDaily.valueHigh,
    valueMid: v4.priceDaily.valueMid,
    unit: v4.priceDaily.unit,
    currency: v4.priceDaily.currency,
    note: v4.priceDaily.note,
    status: v4.priceDaily.status,
    rawUrl: v4.priceDaily.rawUrl,
    capturedAt: v4.priceDaily.capturedAt,
    sourceCode: v4.source.code,
    sourceName: v4.source.name,
    sourceBaseUrl: v4.source.baseUrl,
  } as const;

  const [latestRow] = await database
    .select(selectShape)
    .from(v4.priceDaily)
    .innerJoin(v4.category, eq(v4.category.id, v4.priceDaily.categoryId))
    .innerJoin(v4.region, eq(v4.region.id, v4.priceDaily.regionId))
    .leftJoin(v4.spec, eq(v4.spec.id, v4.priceDaily.specId))
    .leftJoin(v4.source, eq(v4.source.id, v4.priceDaily.sourceId))
    .where(baseConditions)
    .orderBy(desc(v4.priceDaily.priceDate))
    .limit(1);

  if (!latestRow) return null;

  const cutoff = addDays(latestRow.priceDate, -(HISTORY_DAYS - 1));
  const historyRows = await database
    .select(selectShape)
    .from(v4.priceDaily)
    .innerJoin(v4.category, eq(v4.category.id, v4.priceDaily.categoryId))
    .innerJoin(v4.region, eq(v4.region.id, v4.priceDaily.regionId))
    .leftJoin(v4.spec, eq(v4.spec.id, v4.priceDaily.specId))
    .leftJoin(v4.source, eq(v4.source.id, v4.priceDaily.sourceId))
    .where(and(baseConditions, gte(v4.priceDaily.priceDate, cutoff)))
    .orderBy(asc(v4.priceDaily.priceDate));

  const points: MarketSparkPoint[] = [];
  const recentAll: RecentRow[] = [];
  for (const row of historyRows) {
    const value = numericToNumber(row.valueMid);
    if (value === null) continue;
    points.push({ date: row.priceDate, value });
    recentAll.push({
      id: row.id,
      date: row.priceDate,
      value,
      open: null,
      high: null,
      low: null,
      close: null,
      settle: null,
      volume: null,
      openInterest: null,
      revision: 0,
      valueLow: numericToNumber(row.valueLow),
      valueHigh: numericToNumber(row.valueHigh),
      status: row.status,
      trace: null,
      quoteId: row.id,
    });
  }

  const frequency = inferFrequency(points);
  const changes = computeChanges(points, frequency);
  const latest = points[points.length - 1] ?? null;

  // 来源：历史行里出现过的 source，去重；没有 source_id 时保持空数组，不编造来源。
  const sourceByCode = new Map<string, QuoteDetail['sources'][number]>();
  for (const row of historyRows) {
    if (!row.sourceCode) continue;
    // 按时间升序遍历，后写入的（更新的）抓取链接覆盖旧值。
    sourceByCode.set(row.sourceCode, {
      code: row.sourceCode,
      name: row.sourceName ?? row.sourceCode,
      url: row.rawUrl ?? row.sourceBaseUrl ?? '',
      fetchedAt: timestampToIso(row.capturedAt) ?? '',
    });
  }
  const sources = [...sourceByCode.values()].sort((a, b) => a.code.localeCompare(b.code));

  const latestValue = latest?.value ?? null;
  const unit = latestRow.unit;
  const currency = latestRow.currency;
  const trust: { trust: TrustMark; label: string } = latest
    ? { trust: 'normal', label: '正常' }
    : { trust: 'gap', label: '缺口' };

  const quote: QuoteDetail = {
    id: latestRow.id,
    priceType: (latestRow.priceType as PriceType) ?? 'market',
    priceTypeLabel: priceTypeLabel(latestRow.priceType),
    valueLow: numericToNumber(latestRow.valueLow) ?? latestValue ?? 0,
    valueHigh: numericToNumber(latestRow.valueHigh) ?? latestValue ?? 0,
    valueMid: numericToNumber(latestRow.valueMid) ?? latestValue ?? 0,
    // v4 是来源直发，没有多源定档；confidence 是旧契约字段，用中性默认值。
    confidence: 'medium',
    method: '单源直取',
    methodVersion: 'v4',
    coverageNote: latestRow.note,
    status: latestRow.status,
    sources,
  };

  return {
    kind: 'quote',
    slug,
    categoryCode: latestRow.categoryCode,
    categoryName: latestRow.categoryName,
    title: latestRow.categoryName,
    spec: latestRow.specName ?? '品类级',
    market: latestRow.regionName,
    marketKind: '发布价格',
    unit,
    currency,
    frequencyLabel: frequencyLabel(frequency),
    summary: latestRow.note,
    sourceName: latestRow.sourceName ?? sources[0]?.name ?? null,
    latestValue,
    latestDate: latest?.date ?? null,
    dayChange: changes.day,
    weekChange: changes.week,
    pointCount: points.length,
    trust: trust.trust,
    trustLabel: trust.label,
    points,
    recent: recentAll.slice(-30),
    peers: [] as PeerChart[],
    quote,
  };
}

/** slug → 单品数据；非 p- 前缀或未知 slug 返回 null（页面 404）。 */
export async function loadMarketDetail(
  slug: string,
  database: BeeDb = defaultDb,
): Promise<MarketDetail | null> {
  const parsed = parseQuoteSlug(slug);
  if (!parsed) return null;
  return loadQuoteDetail(database, parsed, slug);
}