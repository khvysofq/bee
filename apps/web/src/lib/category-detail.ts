import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { v4, type BeeDb } from '@bee/db';
import { numericToNumber } from '@bee/core';
import { db as defaultDb } from '../db';
import type { ChangeView } from './briefing-data';
import type { CategorySparkPoint, RegionLevel } from './category-overview';

/**
 * 品类详情数据层（用户站 /c/<code>）。
 *
 * 一个品类下所有已发布价格按「地域 × 规格」聚成序列（同一组合若有多种价类型，
 * 取最新日期的那种），主图、今日快照、统计与今日全表都从这批真实行派生。
 * 内容只取 public + published，每类最多 5 条；没有内容时页面写「待发布」。
 */

export interface CategorySeries {
  key: string;
  regionCode: string;
  regionName: string;
  level: RegionLevel;
  specCode: string | null;
  specName: string;
  priceType: string;
  unit: string;
  currency: string;
  sourceCode: string | null;
  sourceName: string | null;
  note: string | null;
  points: CategorySparkPoint[];
  latestDate: string;
  latestValue: number;
  dayChange: ChangeView | null;
  weekChange: ChangeView | null;
  pointCount: number;
}

export interface CategoryTodayRow {
  key: string;
  regionCode: string;
  regionName: string;
  level: RegionLevel;
  specCode: string | null;
  specName: string;
  priceType: string;
  value: number;
  unit: string;
  currency: string;
  date: string;
  dayChange: ChangeView | null;
  sourceCode: string | null;
  sourceName: string | null;
  note: string | null;
}

export interface CategoryStats {
  basis: '全国' | '全球';
  basisRegion: string;
  high: number;
  low: number;
  average: number;
  sampleCount: number;
  latestDate: string;
  unit: string;
  currency: string;
}

export interface ContentCard {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  contentDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  meta: Record<string, unknown>;
}

export interface CategoryDetail {
  id: string;
  code: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  specs: Array<{ code: string; name: string; aliases: string[]; tier: number | null }>;
  series: CategorySeries[];
  todayRows: CategoryTodayRow[];
  stats: CategoryStats | null;
  contents: {
    news_digest: ContentCard[];
    analysis: ContentCard[];
    forecast: ContentCard[];
  };
  latestDate: string | null;
  hasDemo: boolean;
  sourceCount: number;
}

const DAY_MS = 86_400_000;
const LEVEL_RANK: Record<string, number> = {
  global: 0,
  country: 1,
  province: 2,
  city: 3,
  market: 4,
};

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

interface RawPriceRow {
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  categoryNameEn: string | null;
  categoryDescription: string | null;
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

/** 同一地域×规格只保留一种价类型：取该组合最新日期的那条所在的价类型。 */
function choosePriceTypes(rows: RawPriceRow[]): Map<string, string> {
  const latestByKey = new Map<string, { date: string; priceType: string }>();
  for (const row of rows) {
    const key = `${row.specCode ?? 'all'}|${row.regionCode}`;
    const current = latestByKey.get(key);
    if (!current || row.priceDate > current.date) {
      latestByKey.set(key, { date: row.priceDate, priceType: row.priceType });
    }
  }
  return new Map([...latestByKey].map(([key, value]) => [key, value.priceType]));
}

function buildSeries(rows: RawPriceRow[]): CategorySeries[] {
  const priceTypes = choosePriceTypes(rows);
  const buckets = new Map<string, RawPriceRow[]>();
  for (const row of rows) {
    const comboKey = `${row.specCode ?? 'all'}|${row.regionCode}`;
    if (priceTypes.get(comboKey) !== row.priceType) continue;
    const key = `${comboKey}|${row.priceType}`;
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }

  const series: CategorySeries[] = [];
  for (const [key, group] of buckets) {
    const meta = group[0]!;
    const points = group
      .map((row) => ({ date: row.priceDate, value: numericToNumber(row.valueMid)! }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (points.length === 0) continue;
    const latest = points[points.length - 1]!;
    const changes = changesFrom(points);
    series.push({
      key,
      regionCode: meta.regionCode,
      regionName: meta.regionName,
      level: meta.regionLevel as RegionLevel,
      specCode: meta.specCode,
      specName: meta.specName ?? '品类级',
      priceType: meta.priceType,
      unit: meta.unit,
      currency: meta.currency,
      sourceCode: meta.sourceCode,
      sourceName: meta.sourceName,
      note: meta.note,
      points,
      latestDate: latest.date,
      latestValue: latest.value,
      dayChange: changes.day,
      weekChange: changes.week,
      pointCount: points.length,
    });
  }

  return series.sort((a, b) => {
    const levelA = LEVEL_RANK[a.level] ?? 9;
    const levelB = LEVEL_RANK[b.level] ?? 9;
    return (
      levelA - levelB ||
      a.regionName.localeCompare(b.regionName, 'zh-CN') ||
      a.specName.localeCompare(b.specName, 'zh-CN')
    );
  });
}

function buildTodayRows(
  rows: RawPriceRow[],
  series: CategorySeries[],
  latestDate: string | null,
): CategoryTodayRow[] {
  if (!latestDate) return [];
  const seriesByKey = new Map(series.map((item) => [item.key, item]));
  return rows
    .filter((row) => row.priceDate === latestDate)
    .map((row) => {
      const key = `${row.specCode ?? 'all'}|${row.regionCode}|${row.priceType}`;
      const matched = seriesByKey.get(key);
      return {
        key,
        regionCode: row.regionCode,
        regionName: row.regionName,
        level: row.regionLevel as RegionLevel,
        specCode: row.specCode,
        specName: row.specName ?? '品类级',
        priceType: row.priceType,
        value: numericToNumber(row.valueMid)!,
        unit: row.unit,
        currency: row.currency,
        date: row.priceDate,
        dayChange: matched?.latestDate === latestDate ? matched.dayChange : null,
        sourceCode: row.sourceCode,
        sourceName: row.sourceName,
        note: row.note,
      };
    })
    .sort((a, b) => {
      const levelA = LEVEL_RANK[a.level] ?? 9;
      const levelB = LEVEL_RANK[b.level] ?? 9;
      return (
        levelA - levelB ||
        a.regionName.localeCompare(b.regionName, 'zh-CN') ||
        a.specName.localeCompare(b.specName, 'zh-CN')
      );
    });
}

function buildStats(series: CategorySeries[]): CategoryStats | null {
  const national = series
    .filter((item) => item.level === 'country')
    .sort((a, b) => b.pointCount - a.pointCount)[0];
  const basis = national ?? series.find((item) => item.level === 'global');
  if (!basis) return null;

  const window = basis.points.slice(-30);
  if (window.length === 0) return null;
  const values = window.map((point) => point.value);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    basis: basis.level === 'country' ? '全国' : '全球',
    basisRegion: basis.regionName,
    high: Math.max(...values),
    low: Math.min(...values),
    average: Math.round((sum / values.length) * 100) / 100,
    sampleCount: values.length,
    latestDate: basis.latestDate,
    unit: basis.unit,
    currency: basis.currency,
  };
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export async function loadCategoryDetail(
  database: BeeDb,
  code: string,
): Promise<CategoryDetail | null> {
  const [category] = await database
    .select({
      id: v4.category.id,
      code: v4.category.code,
      name: v4.category.nameCn,
      nameEn: v4.category.nameEn,
      description: v4.category.description,
    })
    .from(v4.category)
    .where(and(eq(v4.category.code, code), eq(v4.category.status, 'active')))
    .limit(1);
  if (!category) return null;

  const [specs, rawRows, contentRows] = await Promise.all([
    database
      .select({ code: v4.spec.code, name: v4.spec.name, aliases: v4.spec.aliases, tier: v4.spec.tier })
      .from(v4.spec)
      .where(and(eq(v4.spec.categoryId, category.id), eq(v4.spec.status, 'active')))
      .orderBy(desc(v4.spec.tier), asc(v4.spec.code)),
    database
      .select({
        categoryId: v4.priceDaily.categoryId,
        categoryCode: v4.category.code,
        categoryName: v4.category.nameCn,
        categoryNameEn: v4.category.nameEn,
        categoryDescription: v4.category.description,
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
      .innerJoin(v4.region, eq(v4.region.id, v4.priceDaily.regionId))
      .leftJoin(v4.spec, eq(v4.spec.id, v4.priceDaily.specId))
      .leftJoin(v4.source, eq(v4.source.id, v4.priceDaily.sourceId))
      .innerJoin(v4.category, eq(v4.category.id, v4.priceDaily.categoryId))
      .where(and(eq(v4.priceDaily.categoryId, category.id), eq(v4.priceDaily.status, 'published')))
      .orderBy(asc(v4.priceDaily.priceDate)),
    database
      .select({
        id: v4.content.id,
        kind: v4.content.kind,
        title: v4.content.title,
        summary: v4.content.summary,
        contentDate: v4.content.contentDate,
        periodStart: v4.content.periodStart,
        periodEnd: v4.content.periodEnd,
        meta: v4.content.meta,
      })
      .from(v4.content)
      .where(
        and(
          eq(v4.content.categoryId, category.id),
          eq(v4.content.visibility, 'public'),
          eq(v4.content.status, 'published'),
          inArray(v4.content.kind, ['news_digest', 'analysis', 'forecast']),
        ),
      )
      .orderBy(desc(v4.content.contentDate), desc(v4.content.createdAt)),
  ]);

  const rows = (rawRows as RawPriceRow[]).filter((row) => numericToNumber(row.valueMid) !== null);
  const series = buildSeries(rows);

  const latestDate = rows.reduce<string | null>(
    (latest, row) => (!latest || row.priceDate > latest ? row.priceDate : latest),
    null,
  );

  const contents: CategoryDetail['contents'] = { news_digest: [], analysis: [], forecast: [] };
  for (const row of contentRows) {
    const kind = row.kind as keyof CategoryDetail['contents'];
    if (contents[kind] && contents[kind].length < 5) {
      contents[kind].push({
        id: row.id,
        kind: row.kind,
        title: row.title,
        summary: row.summary,
        contentDate: row.contentDate,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        meta: parseMeta(row.meta),
      });
    }
  }

  const sources = new Set(rows.map((row) => row.sourceCode).filter(Boolean));

  return {
    id: category.id,
    code: category.code,
    name: category.name,
    nameEn: category.nameEn,
    description: category.description,
    specs,
    series,
    todayRows: buildTodayRows(rows, series, latestDate),
    stats: buildStats(series),
    contents,
    latestDate,
    hasDemo: [...sources].some((source) => source?.startsWith('demo') ?? false),
    sourceCount: sources.size,
  };
}