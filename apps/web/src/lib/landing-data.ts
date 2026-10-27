import { eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { numericToNumber } from '@bee/core';
import { db as defaultDb } from '../db';
import {
  loadBriefing,
  PRICE_TYPE_LABEL,
  type BriefingQuote,
  type ChangeView,
  type PriceType,
  type SourceRef,
} from './briefing-data';
import { STATS_SOURCE_CODE } from './compliance';
import { pickRepresentative } from './representative';

export { pickRepresentative } from './representative';

/**
 * 落地页（GUA-26 / P0-6）数据加载层。
 *
 * 硬约束：页面上一切报价数字都来自 daily_quote / derived_indicator —— 本文件只复用
 * loadBriefing（P0-4 定稿查询逻辑）+ 一条已发布定档的历史序列查询，不接受任何手写价格。
 */

/** 走势图取样窗口（天）：近 7~14 天，取 14 天上限内的全部已发布定档。 */
export const TREND_WINDOW_DAYS = 14;

export interface TrendPoint {
  /** 定档日（YYYY-MM-DD，来自 daily_quote.quote_date）。 */
  date: string;
  /** 中值（元/吨，来自 daily_quote.value_mid）。 */
  value: number;
}

/** 序列点：多带一个 daily_quote 行 id，供行业问答做数字回查（GUA-35）。 */
export interface QuoteSeriesPoint extends TrendPoint {
  quoteId: string;
}

/** key = 品类 code|规格名|地域名|价格类型。 */
export type QuoteSeriesMap = Map<string, QuoteSeriesPoint[]>;

export function quoteSeriesKey(parts: {
  categoryCode: string;
  specName: string;
  regionName: string;
  priceType: string;
}): string {
  return [parts.categoryCode, parts.specName, parts.regionName, parts.priceType].join('|');
}

/** 序列取样起点（含）：最新报价日往前 TREND_WINDOW_DAYS 天。 */
export function seriesCutoff(latestQuoteDate: string | null): string | null {
  return latestQuoteDate ? addDays(latestQuoteDate, -(TREND_WINDOW_DAYS - 1)) : null;
}

/**
 * 全库已发布报价的历史中值序列，按「品类×规格×地域×价类型」聚合（升序由调用方保证）。
 * 只查 daily_quote，不接受任何手写价格；行业问答与趋势推演共用这一条查询。
 */
export async function loadQuoteSeries(database: BeeDb = defaultDb): Promise<QuoteSeriesMap> {
  const seriesRows = await database
    .select({
      id: dbSchema.dailyQuote.id,
      categoryCode: dbSchema.category.code,
      specName: dbSchema.specGrade.nameCn,
      regionName: dbSchema.region.nameCn,
      priceType: dbSchema.dailyQuote.priceType,
      quoteDate: dbSchema.dailyQuote.quoteDate,
      valueMid: dbSchema.dailyQuote.valueMid,
    })
    .from(dbSchema.dailyQuote)
    .innerJoin(dbSchema.category, eq(dbSchema.dailyQuote.categoryId, dbSchema.category.id))
    .innerJoin(dbSchema.specGrade, eq(dbSchema.dailyQuote.specId, dbSchema.specGrade.id))
    .innerJoin(dbSchema.region, eq(dbSchema.dailyQuote.regionId, dbSchema.region.id))
    .where(eq(dbSchema.dailyQuote.status, 'published'));

  const seriesByKey: QuoteSeriesMap = new Map();
  for (const row of seriesRows) {
    const value = numericToNumber(row.valueMid);
    if (value === null) continue;
    const key = quoteSeriesKey({
      categoryCode: row.categoryCode,
      specName: row.specName,
      regionName: row.regionName,
      priceType: row.priceType,
    });
    const list = seriesByKey.get(key) ?? [];
    list.push({ date: row.quoteDate, value, quoteId: row.id });
    seriesByKey.set(key, list);
  }
  return seriesByKey;
}

export interface LandingQuote {
  id: string;
  specName: string;
  regionName: string;
  regionLevel: 'market' | 'city';
  priceType: PriceType;
  priceTypeLabel: string;
  quoteDate: string;
  valueLow: number;
  valueHigh: number;
  valueMid: number;
  confidence: string;
  sources: SourceRef[];
  /** 较上一交易日（真实计算值；无可比定档时为 null，缺失不当作持平）。 */
  dailyChange: ChangeView | null;
  /** 较上周同口径（真实计算值；无可比定档时为 null）。 */
  weeklyChange: ChangeView | null;
}

export interface LandingCategory {
  id: string;
  code: string;
  name: string;
  /** 卡片主报价：最新定档日的一条代表报价（口径见 pickRepresentative）。 */
  representative: LandingQuote | null;
  /** 代表报价同口径（品类×规格×地域×价类型）近 TREND_WINDOW_DAYS 天走势，升序。 */
  trend: TrendPoint[];
  /** 最新定档日该品类的已发布定档条数。 */
  latestQuoteCount: number;
}

export interface LandingData {
  generatedAt: string;
  latestQuoteDate: string | null;
  dataCutoffAt: string | null;
  categories: LandingCategory[];
  hasFixtureSource: boolean;
  hasStatsSource: boolean;
  /** 统计局公报原文链接（仅用于数据说明中的规范署名；不是来源列表）。 */
  statsSourceUrl: string | null;
  stats: {
    categoryCount: number;
    categoriesWithQuotes: number;
    quoteCount: number;
    sourceCount: number;
  };
  /** 全库尚无已发布定档（fixture 管线未跑）。 */
  empty: boolean;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 代表报价挑选口径（确定性，页面展示规格/地域标签，不隐藏口径）：
 *  见 ./representative.ts，集成测试仍从本模块导入。
 */

function toLandingQuote(quote: BriefingQuote): LandingQuote {
  return {
    id: quote.id,
    specName: quote.specName,
    regionName: quote.regionName,
    regionLevel: quote.regionLevel,
    priceType: quote.priceType,
    priceTypeLabel: PRICE_TYPE_LABEL[quote.priceType],
    quoteDate: quote.quoteDate,
    valueLow: quote.valueLow,
    valueHigh: quote.valueHigh,
    valueMid: quote.valueMid,
    confidence: quote.confidence,
    sources: quote.sources,
    dailyChange: quote.previousTradingDay,
    weeklyChange: quote.weekAgo,
  };
}

export async function loadLandingData(database: BeeDb = defaultDb): Promise<LandingData> {
  const briefing = await loadBriefing(database);

  // 走势序列：与简报同源的 daily_quote 已发布报价，按「品类×规格×地域×价类型」聚成时间序列。
  const seriesByKey = await loadQuoteSeries(database);
  const cutoff = seriesCutoff(briefing.latestQuoteDate);

  const categories: LandingCategory[] = briefing.categories.map((category) => {
    const representative = pickRepresentative(category.quotes, briefing.latestQuoteDate);
    let trend: TrendPoint[] = [];
    if (representative) {
      const key = quoteSeriesKey({
        categoryCode: category.code,
        specName: representative.specName,
        regionName: representative.regionName,
        priceType: representative.priceType,
      });
      trend = (seriesByKey.get(key) ?? [])
        .filter((point) => !cutoff || point.date >= cutoff)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        // 落地页只渲染日期与中值；行 id 是问答做数字回查用的，不带进这一层。
        .map((point): TrendPoint => ({ date: point.date, value: point.value }));
    }
    const latestQuoteCount = briefing.latestQuoteDate
      ? category.quotes.filter((quote) => quote.quoteDate === briefing.latestQuoteDate).length
      : category.quotes.length;
    return {
      id: category.id,
      code: category.code,
      name: category.name,
      representative: representative ? toLandingQuote(representative) : null,
      trend,
      latestQuoteCount,
    };
  });

  return {
    generatedAt: briefing.generatedAt,
    latestQuoteDate: briefing.latestQuoteDate,
    dataCutoffAt: briefing.dataCutoffAt,
    categories,
    hasFixtureSource: briefing.sources.some(
      (source) => source.code.startsWith('fixture') || source.code === 'open-cc0-sample',
    ),
    hasStatsSource: briefing.sources.some((source) => source.code === STATS_SOURCE_CODE),
    statsSourceUrl:
      briefing.sources.find((source) => source.code === STATS_SOURCE_CODE)?.latestFetchUrl ?? null,
    stats: {
      categoryCount: briefing.stats.categoryCount,
      categoriesWithQuotes: briefing.stats.categoriesWithQuotes,
      quoteCount: briefing.stats.quoteCount,
      sourceCount: briefing.stats.sourceCount,
    },
    empty: briefing.latestQuoteDate === null,
  };
}
