import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4, type BeeDb } from '@bee/db';
import { numericToNumber, timestampToIso } from '@bee/core';
import { db as defaultDb } from '../db';

/** price_daily.price_type 的取值；market 是 v4 的默认价类型。 */
export type PriceType = 'market' | 'purchase' | 'sale' | 'ex_works' | 'indicative';

export const PRICE_TYPE_LABEL: Record<PriceType, string> = {
  market: '市场价',
  purchase: '采购价',
  sale: '销售价',
  ex_works: '出厂价',
  indicative: '指导价',
};

export const INDICATOR_KIND_LABEL: Record<string, string> = {
  national_weighted_avg: '全国加权均价',
  national_median: '全国中位数',
  national_reference: '全国参考价（来源直发）',
  region_aggregate: '大区聚合价',
  city_aggregate: '城市聚合价',
};

export interface SourceRef {
  code: string;
  name: string;
  /** v4 source 表没有可信权重列；这里保留旧契约字段，统一给 0 表示「未标定」。 */
  trustWeight: number;
  fetchedAt: string;
}

/** 简报页署名用的来源登记信息（含最新原文链接与 ToS 链接）。 */
export interface BriefingSourceInfo {
  code: string;
  name: string;
  baseUrl: string | null;
  tosUrl: string | null;
  latestFetchUrl: string | null;
}

export interface ChangeView {
  quoteDate: string;
  previousValue: number;
  /** 相对上一交易日/上周的中值变化，正负号为真实计算值（不是 LLM 生成）。 */
  pct: number;
}

export interface BriefingQuote {
  id: string;
  categoryId: string;
  categoryName: string;
  specName: string;
  regionName: string;
  regionLevel: 'market' | 'city';
  quoteDate: string;
  priceType: PriceType;
  valueLow: number;
  valueHigh: number;
  valueMid: number;
  method: string;
  methodVersion: string;
  confidence: string;
  coverageNote: string | null;
  status: string;
  fetchedFrom: string | null;
  fetchedTo: string | null;
  sources: SourceRef[];
  previousTradingDay: ChangeView | null;
  weekAgo: ChangeView | null;
}

export interface BriefingIndicator {
  id: string;
  kind: string;
  kindLabel: string;
  categoryName: string;
  regionName: string;
  basisDate: string;
  value: number;
  methodNote: string;
  methodVersion: string;
  contributionCount: number;
  contributingQuoteIds: string[];
}

export interface BriefingCategory {
  id: string;
  code: string;
  name: string;
  quotes: BriefingQuote[];
  indicators: BriefingIndicator[];
  coverage: {
    regions: number;
    sources: number;
    specs: number;
    quoteCount: number;
  };
  gaps: string[];
}

export interface BriefingData {
  generatedAt: string;
  latestQuoteDate: string | null;
  dataCutoffAt: string | null;
  categories: BriefingCategory[];
  sources: BriefingSourceInfo[];
  stats: {
    categoryCount: number;
    categoriesWithQuotes: number;
    quoteCount: number;
    sourceCount: number;
    openExceptions: number;
    highPriorityExceptions: number;
  };
  globalGaps: string[];
}

function changePct(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 旧 BriefingQuote.regionLevel 只允许 market/city。v4 地域可以是 global/country/province，
 * 这里只做展示层归类，不改库里事实：city 保持 city，其余按 market 展示。
 */
function asRegionLevel(level: string): 'market' | 'city' {
  return level === 'city' ? 'city' : 'market';
}

function asPriceType(value: string): PriceType {
  if (
    value === 'market' ||
    value === 'purchase' ||
    value === 'sale' ||
    value === 'ex_works' ||
    value === 'indicative'
  ) {
    return value;
  }
  return 'market';
}

/**
 * 简报数据层（v4）：品类来自 category，报价来自 price_daily 最新发布行。
 *
 * v4 没有加工指标表，indicators 恒为空数组；比较基数来自同组合的历史真实行。
 * 不补点、不插值、不把缺失当作持平。
 */
export async function loadBriefing(database: BeeDb = defaultDb): Promise<BriefingData> {
  const generatedAt = new Date().toISOString();
  const categories = await database
    .select()
    .from(v4.category)
    .orderBy(v4.category.sortOrder, v4.category.code);

  const [latestRow] = await database
    .select({ latest: sql<string | null>`max(${v4.priceDaily.priceDate})` })
    .from(v4.priceDaily)
    .where(eq(v4.priceDaily.status, 'published'));
  const latestQuoteDate = latestRow?.latest ?? null;

  if (!latestQuoteDate) {
    return {
      generatedAt,
      latestQuoteDate: null,
      dataCutoffAt: null,
      categories: categories.map((category) => ({
        id: category.id,
        code: category.code,
        name: category.nameCn,
        quotes: [],
        indicators: [],
        coverage: { regions: 0, sources: 0, specs: 0, quoteCount: 0 },
        gaps: ['尚无已发布的定档报价'],
      })),
      sources: [],
      stats: {
        categoryCount: categories.length,
        categoriesWithQuotes: 0,
        quoteCount: 0,
        sourceCount: 0,
        openExceptions: 0,
        highPriorityExceptions: 0,
      },
      globalGaps: ['尚无已发布的定档报价：等待 v4 采集任务写入 price_daily'],
    };
  }

  const selectQuote = {
    id: v4.priceDaily.id,
    categoryId: v4.priceDaily.categoryId,
    categoryName: v4.category.nameCn,
    categorySort: v4.category.sortOrder,
    specName: v4.spec.name,
    regionName: v4.region.name,
    regionLevel: v4.region.level,
    regionCode: v4.region.code,
    quoteDate: v4.priceDaily.priceDate,
    priceType: v4.priceDaily.priceType,
    valueLow: v4.priceDaily.valueLow,
    valueHigh: v4.priceDaily.valueHigh,
    valueMid: v4.priceDaily.valueMid,
    unit: v4.priceDaily.unit,
    currency: v4.priceDaily.currency,
    note: v4.priceDaily.note,
    status: v4.priceDaily.status,
    sourceId: v4.priceDaily.sourceId,
    sourceCode: v4.source.code,
    sourceName: v4.source.name,
    rawUrl: v4.priceDaily.rawUrl,
    capturedAt: v4.priceDaily.capturedAt,
  } as const;

  const baseQuery = () =>
    database
      .select(selectQuote)
      .from(v4.priceDaily)
      .innerJoin(v4.category, eq(v4.category.id, v4.priceDaily.categoryId))
      .leftJoin(v4.spec, eq(v4.spec.id, v4.priceDaily.specId))
      .innerJoin(v4.region, eq(v4.region.id, v4.priceDaily.regionId))
      .leftJoin(v4.source, eq(v4.source.id, v4.priceDaily.sourceId));

  const publishedQuoteRows = await baseQuery()
    .where(
      and(
        eq(v4.priceDaily.status, 'published'),
        eq(v4.priceDaily.priceDate, latestQuoteDate),
      ),
    )
    .orderBy(
      v4.category.sortOrder,
      v4.spec.name,
      v4.region.name,
      v4.priceDaily.priceType,
    );

  // 历史只用于算「较上一交易日」「较上周」；不渲染旧日整行。
  const historyRows = await baseQuery().where(eq(v4.priceDaily.status, 'published'));

  const historyByKey = new Map<string, Array<(typeof historyRows)[number]>>();
  for (const row of historyRows) {
    const key = [row.categoryId, row.specName ?? '', row.regionName, row.priceType].join('|');
    const list = historyByKey.get(key) ?? [];
    list.push(row);
    historyByKey.set(key, list);
  }

  const sources: BriefingSourceInfo[] = [];
  const sourceIds = [...new Set(publishedQuoteRows.map((row) => row.sourceId).filter((id): id is string => id !== null))];
  if (sourceIds.length > 0) {
    const sourceRows = await database
      .select({
        id: v4.source.id,
        code: v4.source.code,
        name: v4.source.name,
        baseUrl: v4.source.baseUrl,
      })
      .from(v4.source)
      .where(inArray(v4.source.id, sourceIds));

    const latestFetchBySource = new Map<string, { url: string | null; at: string }>();
    for (const row of publishedQuoteRows) {
      if (!row.sourceId) continue;
      const at = timestampToIso(row.capturedAt) ?? '';
      const current = latestFetchBySource.get(row.sourceId);
      if (!current || at > current.at) {
        latestFetchBySource.set(row.sourceId, { url: row.rawUrl, at });
      }
    }

    for (const source of sourceRows) {
      sources.push({
        code: source.code,
        name: source.name,
        baseUrl: source.baseUrl,
        tosUrl: null,
        latestFetchUrl: latestFetchBySource.get(source.id)?.url ?? null,
      });
    }
    sources.sort((a, b) => a.code.localeCompare(b.code));
  }

  let dataCutoffAt: string | null = null;
  for (const row of publishedQuoteRows) {
    const iso = timestampToIso(row.capturedAt);
    if (iso && (!dataCutoffAt || iso > dataCutoffAt)) dataCutoffAt = iso;
  }

  const quotes: BriefingQuote[] = publishedQuoteRows.map((quote) => {
    const specName = quote.specName ?? '品类级';
    const key = [quote.categoryId, quote.specName ?? '', quote.regionName, quote.priceType].join('|');
    const history = (historyByKey.get(key) ?? [])
      .filter((row) => row.quoteDate < quote.quoteDate)
      .sort((a, b) => (a.quoteDate < b.quoteDate ? 1 : -1));
    const previous = history[0] ?? null;
    const weekAgoDate = addDays(quote.quoteDate, -7);
    const weekAgo = history.find((row) => row.quoteDate === weekAgoDate) ?? null;
    const currentMid = numericToNumber(quote.valueMid) ?? 0;
    const previousMid = previous ? numericToNumber(previous.valueMid) : null;
    const weekAgoMid = weekAgo ? numericToNumber(weekAgo.valueMid) : null;

    const fetchedAt = timestampToIso(quote.capturedAt);
    const sourceList: SourceRef[] = quote.sourceCode
      ? [{ code: quote.sourceCode, name: quote.sourceName ?? quote.sourceCode, trustWeight: 0, fetchedAt: fetchedAt ?? '' }]
      : [];

    return {
      id: quote.id,
      categoryId: quote.categoryId,
      categoryName: quote.categoryName,
      specName,
      regionName: quote.regionName,
      regionLevel: asRegionLevel(quote.regionLevel),
      quoteDate: quote.quoteDate,
      priceType: asPriceType(quote.priceType),
      valueLow: numericToNumber(quote.valueLow) ?? currentMid,
      valueHigh: numericToNumber(quote.valueHigh) ?? currentMid,
      valueMid: currentMid,
      // v4 是来源直发，没有多源定档与版本链；旧字段用明确默认值。
      method: '单源直取',
      methodVersion: 'v4',
      confidence: 'medium',
      coverageNote: quote.note,
      status: quote.status,
      fetchedFrom: fetchedAt,
      fetchedTo: fetchedAt,
      sources: sourceList,
      previousTradingDay:
        previous && previousMid !== null
          ? {
              quoteDate: previous.quoteDate,
              previousValue: previousMid,
              pct: changePct(currentMid, previousMid),
            }
          : null,
      weekAgo:
        weekAgo && weekAgoMid !== null
          ? {
              quoteDate: weekAgo.quoteDate,
              previousValue: weekAgoMid,
              pct: changePct(currentMid, weekAgoMid),
            }
          : null,
    };
  });

  const categoriesView: BriefingCategory[] = categories.map((category) => {
    const categoryQuotes = quotes.filter((quote) => quote.categoryId === category.id);
    const sources = new Set(categoryQuotes.flatMap((quote) => quote.sources.map((source) => source.code)));
    const regions = new Set(categoryQuotes.map((quote) => quote.regionName));
    const specs = new Set(categoryQuotes.map((quote) => quote.specName));
    const gaps: string[] = [];
    if (categoryQuotes.length === 0) gaps.push('今日无已发布报价');
    if (categoryQuotes.some((quote) => quote.confidence === 'low')) gaps.push('存在低置信度报价');
    if (categoryQuotes.some((quote) => quote.sources.length === 0)) gaps.push('存在无来源报价');
    return {
      id: category.id,
      code: category.code,
      name: category.nameCn,
      quotes: categoryQuotes,
      indicators: [],
      coverage: {
        regions: regions.size,
        sources: sources.size,
        specs: specs.size,
        quoteCount: categoryQuotes.length,
      },
      gaps,
    };
  });

  const allSources = new Set(quotes.flatMap((quote) => quote.sources.map((source) => source.code)));
  const categoriesWithQuotes = categoriesView.filter((category) => category.quotes.length > 0).length;
  const globalGaps: string[] = [];
  for (const category of categoriesView) {
    if (category.quotes.length === 0) globalGaps.push(`${category.name}：今日无已发布报价`);
  }
  if (quotes.length === 0) globalGaps.push('今日没有任何已发布定档报价');
  if (quotes.some((quote) => quote.coverageNote?.includes('区域分档暂缺'))) {
    globalGaps.push('区域分档暂缺：全国参考锚点不能替代各地分档现货价');
  }

  return {
    generatedAt,
    latestQuoteDate,
    dataCutoffAt,
    categories: categoriesView,
    sources,
    stats: {
      categoryCount: categories.length,
      categoriesWithQuotes,
      quoteCount: quotes.length,
      sourceCount: allSources.size,
      // 异常队列在 v4 已删除；失败落在 job_run.error。
      openExceptions: 0,
      highPriorityExceptions: 0,
    },
    globalGaps,
  };
}