import { asc, eq } from 'drizzle-orm';
import { v4, type BeeDb } from '@bee/db';
import { numericToNumber } from '@bee/core';
import { db as defaultDb } from '../db';
import type { ChangeView } from './briefing-data';

/**
 * 品类卡片数据层（用户站首页）。
 *
 * 单一数字来源仍是 price_daily：每个品类取全球 / 全国 / 一个代表地域的最新已发布报价，
 * 涨跌与 30 日 spark 都由同一序列的真实前后点计算；没有数据的层级保持 null，
 * 页面显示「待接入」，绝不用别的层级或估算值顶替。
 */

export type RegionLevel = 'global' | 'country' | 'province' | 'city' | 'market';

export interface CategoryQuoteView {
  regionCode: string;
  regionName: string;
  level: RegionLevel;
  specCode: string | null;
  specName: string;
  value: number;
  unit: string;
  currency: string;
  date: string;
  dayChange: ChangeView | null;
  weekChange: ChangeView | null;
  sourceCode: string | null;
  sourceName: string | null;
  note: string | null;
}

export interface CategorySparkPoint {
  date: string;
  value: number;
}

export interface CategoryCardData {
  code: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  global: CategoryQuoteView | null;
  national: CategoryQuoteView | null;
  regional: CategoryQuoteView | null;
  /** 全国序列最近 30 个点（升序）；没有全国序列时回退全球序列。 */
  spark: CategorySparkPoint[];
  dayChange: ChangeView | null;
  weekChange: ChangeView | null;
  sourceCount: number;
  latestDate: string | null;
  hasDemo: boolean;
}

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / DAY_MS,
  );
}

function pct(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

/** 日/周变化：从真实历史点算；不足两天或无 7 天前基准时返回 null（缺失不当作持平）。 */
function changesFrom(pointsAsc: CategorySparkPoint[]): {
  day: ChangeView | null;
  week: ChangeView | null;
} {
  if (pointsAsc.length < 2) return { day: null, week: null };
  const latest = pointsAsc[pointsAsc.length - 1]!;
  const previous = pointsAsc[pointsAsc.length - 2]!;
  const day =
    daysBetween(latest.date, previous.date) <= 7
      ? {
          quoteDate: previous.date,
          previousValue: previous.value,
          pct: pct(latest.value, previous.value),
        }
      : null;

  const cutoff = addDays(latest.date, -7);
  let base: CategorySparkPoint | null = null;
  for (const point of pointsAsc) {
    if (point.date <= cutoff) base = point;
  }
  const week = base
    ? { quoteDate: base.date, previousValue: base.value, pct: pct(latest.value, base.value) }
    : null;
  return { day, week };
}

interface RawRow {
  categoryCode: string;
  categoryName: string;
  categoryNameEn: string | null;
  categoryDescription: string | null;
  categorySort: number;
  specCode: string | null;
  specName: string | null;
  regionCode: string;
  regionName: string;
  regionLevel: string;
  priceDate: string;
  priceType: string;
  valueMid: string;
  unit: string;
  currency: string;
  note: string | null;
  sourceCode: string | null;
  sourceName: string | null;
}

interface SeriesBucket {
  key: string;
  rows: RawRow[];
  points: CategorySparkPoint[];
}

const LEVEL_RANK: Record<string, number> = { province: 0, city: 1, market: 2 };

/**
 * 每个品类 × 规格 × 地域 × 价类型一条序列。同一地域/规格若有多种价类型，
 * 代表价取最新日期的价类型，避免把市场价与指导价混成一条线。
 */
async function loadBuckets(database: BeeDb): Promise<Map<string, SeriesBucket>> {
  const rows = (await database
    .select({
      categoryCode: v4.category.code,
      categoryName: v4.category.nameCn,
      categoryNameEn: v4.category.nameEn,
      categoryDescription: v4.category.description,
      categorySort: v4.category.sortOrder,
      specCode: v4.spec.code,
      specName: v4.spec.name,
      regionCode: v4.region.code,
      regionName: v4.region.name,
      regionLevel: v4.region.level,
      priceDate: v4.priceDaily.priceDate,
      priceType: v4.priceDaily.priceType,
      valueMid: v4.priceDaily.valueMid,
      unit: v4.priceDaily.unit,
      currency: v4.priceDaily.currency,
      note: v4.priceDaily.note,
      sourceCode: v4.source.code,
      sourceName: v4.source.name,
    })
    .from(v4.priceDaily)
    .innerJoin(v4.category, eq(v4.category.id, v4.priceDaily.categoryId))
    .innerJoin(v4.region, eq(v4.region.id, v4.priceDaily.regionId))
    .leftJoin(v4.spec, eq(v4.spec.id, v4.priceDaily.specId))
    .leftJoin(v4.source, eq(v4.source.id, v4.priceDaily.sourceId))
    .where(eq(v4.priceDaily.status, 'published'))
    .orderBy(asc(v4.category.sortOrder), asc(v4.priceDaily.priceDate))) as RawRow[];

  const buckets = new Map<string, SeriesBucket>();
  for (const row of rows) {
    const value = numericToNumber(row.valueMid);
    if (value === null) continue;
    const key = [
      row.categoryCode,
      row.specCode ?? 'all',
      row.regionCode,
      row.priceType,
    ].join('|');
    const existing = buckets.get(key);
    if (existing) {
      existing.rows.push(row);
      existing.points.push({ date: row.priceDate, value });
    } else {
      buckets.set(key, {
        key,
        rows: [row],
        points: [{ date: row.priceDate, value }],
      });
    }
  }
  return buckets;
}

interface Candidate {
  bucket: SeriesBucket;
  meta: RawRow;
  latestDate: string;
  latestValue: number;
  day: ChangeView | null;
  week: ChangeView | null;
}

function toCandidate(bucket: SeriesBucket): Candidate {
  const points = [...bucket.points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const meta = bucket.rows[bucket.rows.length - 1]!;
  const changes = changesFrom(points);
  const latest = points[points.length - 1]!;
  return {
    bucket,
    meta,
    latestDate: latest.date,
    latestValue: latest.value,
    day: changes.day,
    week: changes.week,
  };
}

function toQuote(candidate: Candidate): CategoryQuoteView {
  const { meta } = candidate;
  return {
    regionCode: meta.regionCode,
    regionName: meta.regionName,
    level: meta.regionLevel as RegionLevel,
    specCode: meta.specCode,
    specName: meta.specName ?? '品类级',
    value: candidate.latestValue,
    unit: meta.unit,
    currency: meta.currency,
    date: candidate.latestDate,
    dayChange: candidate.day,
    weekChange: candidate.week,
    sourceCode: meta.sourceCode,
    sourceName: meta.sourceName,
    note: meta.note,
  };
}

function pickLatest(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (a.latestDate !== b.latestDate) return a.latestDate < b.latestDate ? 1 : -1;
    if (a.bucket.points.length !== b.bucket.points.length) {
      return b.bucket.points.length - a.bucket.points.length;
    }
    return a.meta.regionCode.localeCompare(b.meta.regionCode);
  })[0]!;
}

function pickRegional(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (a.latestDate !== b.latestDate) return a.latestDate < b.latestDate ? 1 : -1;
    const levelA = LEVEL_RANK[a.meta.regionLevel] ?? 9;
    const levelB = LEVEL_RANK[b.meta.regionLevel] ?? 9;
    if (levelA !== levelB) return levelA - levelB;
    if (a.bucket.points.length !== b.bucket.points.length) {
      return b.bucket.points.length - a.bucket.points.length;
    }
    return b.latestValue - a.latestValue;
  })[0]!;
}

export async function loadCategoryOverview(database: BeeDb = defaultDb): Promise<CategoryCardData[]> {
  const categories = await database
    .select({
      id: v4.category.id,
      code: v4.category.code,
      name: v4.category.nameCn,
      nameEn: v4.category.nameEn,
      description: v4.category.description,
      sortOrder: v4.category.sortOrder,
    })
    .from(v4.category)
    .where(eq(v4.category.status, 'active'))
    .orderBy(asc(v4.category.sortOrder), asc(v4.category.code));

  if (categories.length === 0) return [];

  const buckets = await loadBuckets(database);
  const candidates = [...buckets.values()].map(toCandidate);

  return categories.map((category) => {
    const own = candidates.filter((candidate) => candidate.meta.categoryCode === category.code);
    const global = pickLatest(own.filter((candidate) => candidate.meta.regionLevel === 'global'));
    const national = pickLatest(own.filter((candidate) => candidate.meta.regionLevel === 'country'));
    const regional = pickRegional(
      own.filter((candidate) => ['province', 'city', 'market'].includes(candidate.meta.regionLevel)),
    );

    const sparkSource = national ?? global;
    const spark = sparkSource
      ? [...sparkSource.bucket.points]
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
          .slice(-30)
      : [];

    const sources = new Set(own.map((candidate) => candidate.meta.sourceCode).filter(Boolean));
    const latestDate = own.reduce<string | null>(
      (latest, candidate) => (!latest || candidate.latestDate > latest ? candidate.latestDate : latest),
      null,
    );

    return {
      code: category.code,
      name: category.name,
      nameEn: category.nameEn,
      description: category.description,
      global: global ? toQuote(global) : null,
      national: national ? toQuote(national) : null,
      regional: regional ? toQuote(regional) : null,
      spark,
      dayChange: national?.day ?? global?.day ?? null,
      weekChange: national?.week ?? global?.week ?? null,
      sourceCount: sources.size,
      latestDate,
      hasDemo: [...sources].some((code) => code?.startsWith('demo') ?? false),
    };
  });
}