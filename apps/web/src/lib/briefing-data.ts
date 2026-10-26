import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { numericToNumber, timestampToIso } from '@bee/core';
import { db as defaultDb } from '../db';

export type PriceType = 'purchase' | 'sale' | 'ex_works' | 'indicative';

export const PRICE_TYPE_LABEL: Record<PriceType, string> = {
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

function asRegionLevel(level: string): 'market' | 'city' {
  if (level !== 'market' && level !== 'city') {
    throw new Error(`daily_quote 只能挂在 market/city 地域：收到 ${level}`);
  }
  return level;
}

function methodNote(methodJson: unknown): string {
  if (methodJson && typeof methodJson === 'object' && 'note' in methodJson) {
    const note = (methodJson as { note?: unknown }).note;
    if (typeof note === 'string' && note.length > 0) return note;
  }
  return '加工指标口径见 method_json（此条未提供人话版 note）。';
}

export async function loadBriefing(database: BeeDb = defaultDb): Promise<BriefingData> {
  const generatedAt = new Date().toISOString();
  const categories = await database
    .select()
    .from(dbSchema.category)
    .orderBy(dbSchema.category.sortOrder);

  const [latestRow] = await database
    .select({ latest: sql<string | null>`max(${dbSchema.dailyQuote.quoteDate})` })
    .from(dbSchema.dailyQuote)
    .where(eq(dbSchema.dailyQuote.status, 'published'));
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
      globalGaps: ['尚无已发布的定档报价：先运行 pnpm data:fixture 生成 P0-3 fixture 数据链'],
    };
  }

  // 旬报锚点是 10 天频，日频 fixture 是最新交易日；两者必须同页共存。
  // 日频只取全库最新日，锚点按「每个规格最新一期」取，避免旬价被日频日期挤掉。
  const publishedQuoteRows = await database
    .select({
      id: dbSchema.dailyQuote.id,
      categoryId: dbSchema.dailyQuote.categoryId,
      categoryName: dbSchema.category.nameCn,
      categorySort: dbSchema.category.sortOrder,
      specName: dbSchema.specGrade.nameCn,
      regionName: dbSchema.region.nameCn,
      regionLevel: dbSchema.region.level,
      regionCode: dbSchema.region.code,
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
      contributingObservationIds: dbSchema.dailyQuote.contributingObservationIds,
    })
    .from(dbSchema.dailyQuote)
    .innerJoin(dbSchema.category, eq(dbSchema.dailyQuote.categoryId, dbSchema.category.id))
    .innerJoin(dbSchema.specGrade, eq(dbSchema.dailyQuote.specId, dbSchema.specGrade.id))
    .innerJoin(dbSchema.region, eq(dbSchema.dailyQuote.regionId, dbSchema.region.id))
    .where(
      and(
        eq(dbSchema.dailyQuote.status, 'published'),
        or(
          eq(dbSchema.dailyQuote.quoteDate, latestQuoteDate),
          eq(dbSchema.region.code, 'stats-national-reference'),
        ),
      ),
    )
    .orderBy(
      dbSchema.dailyQuote.quoteDate,
      dbSchema.category.sortOrder,
      dbSchema.specGrade.sortOrder,
      dbSchema.region.nameCn,
    );

  const quoteRows: typeof publishedQuoteRows = [];
  const seenAnchorSpecs = new Set<string>();
  for (const row of [...publishedQuoteRows].reverse()) {
    if (row.regionCode !== 'stats-national-reference') {
      quoteRows.push(row);
      continue;
    }
    const anchorKey = [row.categoryId, row.specName, row.priceType].join('|');
    if (seenAnchorSpecs.has(anchorKey)) continue;
    seenAnchorSpecs.add(anchorKey);
    quoteRows.push(row);
  }
  quoteRows.sort((a, b) => {
    if (a.categorySort !== b.categorySort) return a.categorySort - b.categorySort;
    const specA = a.specName.localeCompare(b.specName);
    if (specA !== 0) return specA;
    return a.regionName.localeCompare(b.regionName);
  });

  const observationIds = quoteRows.flatMap((quote) => quote.contributingObservationIds);
  const observationRows =
    observationIds.length === 0
      ? []
      : await database
          .select({
            observationId: dbSchema.priceObservation.id,
            sourceId: dbSchema.priceObservation.sourceId,
            fetchId: dbSchema.priceObservation.fetchId,
            sourceCode: dbSchema.source.code,
            sourceName: dbSchema.source.name,
            trustWeight: dbSchema.source.trustWeight,
            fetchedAt: dbSchema.priceObservation.fetchedAt,
          })
          .from(dbSchema.priceObservation)
          .innerJoin(dbSchema.source, eq(dbSchema.priceObservation.sourceId, dbSchema.source.id))
          .where(inArray(dbSchema.priceObservation.id, observationIds));

  const usedSourceIds = [...new Set(observationRows.map((row) => row.sourceId))];
  const usedFetchIds = [...new Set(observationRows.map((row) => row.fetchId))];
  const sourceRows =
    usedSourceIds.length === 0
      ? []
      : await database
          .select({
            id: dbSchema.source.id,
            code: dbSchema.source.code,
            name: dbSchema.source.name,
            baseUrl: dbSchema.source.baseUrl,
            tosUrl: dbSchema.source.tosUrl,
          })
          .from(dbSchema.source)
          .where(inArray(dbSchema.source.id, usedSourceIds));
  const fetchRows =
    usedFetchIds.length === 0
      ? []
      : await database
          .select({
            id: dbSchema.rawFetch.id,
            sourceId: dbSchema.rawFetch.sourceId,
            url: dbSchema.rawFetch.url,
            fetchedAt: dbSchema.rawFetch.fetchedAt,
          })
          .from(dbSchema.rawFetch)
          .where(inArray(dbSchema.rawFetch.id, usedFetchIds));

  const latestFetchBySource = new Map<string, { url: string; fetchedAt: string }>();
  for (const row of fetchRows) {
    const fetchedAt = timestampToIso(row.fetchedAt);
    if (!fetchedAt) continue;
    const current = latestFetchBySource.get(row.sourceId);
    if (!current || fetchedAt > current.fetchedAt) {
      latestFetchBySource.set(row.sourceId, { url: row.url, fetchedAt });
    }
  }
  const sources: BriefingSourceInfo[] = sourceRows
    .map((row) => ({
      code: row.code,
      name: row.name,
      baseUrl: row.baseUrl,
      tosUrl: row.tosUrl,
      latestFetchUrl: latestFetchBySource.get(row.id)?.url ?? null,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const observationById = new Map(observationRows.map((row) => [row.observationId, row]));
  let dataCutoffAt: string | null = null;
  for (const row of observationRows) {
    const iso = timestampToIso(row.fetchedAt);
    if (iso && (!dataCutoffAt || iso > dataCutoffAt)) dataCutoffAt = iso;
  }

  // 历史定档只用于计算「较上一交易日」「较上周」；不渲染旧日整行，避免误导为今日报价。
  const historyRows = await database
    .select({
      id: dbSchema.dailyQuote.id,
      categoryId: dbSchema.dailyQuote.categoryId,
      specName: dbSchema.specGrade.nameCn,
      regionName: dbSchema.region.nameCn,
      quoteDate: dbSchema.dailyQuote.quoteDate,
      priceType: dbSchema.dailyQuote.priceType,
      valueMid: dbSchema.dailyQuote.valueMid,
    })
    .from(dbSchema.dailyQuote)
    .innerJoin(dbSchema.specGrade, eq(dbSchema.dailyQuote.specId, dbSchema.specGrade.id))
    .innerJoin(dbSchema.region, eq(dbSchema.dailyQuote.regionId, dbSchema.region.id))
    .where(eq(dbSchema.dailyQuote.status, 'published'));

  const historyByKey = new Map<string, typeof historyRows>();
  for (const row of historyRows) {
    const key = [row.categoryId, row.specName, row.regionName, row.priceType].join('|');
    const list = historyByKey.get(key) ?? [];
    list.push(row);
    historyByKey.set(key, list);
  }

  const quotes: BriefingQuote[] = quoteRows.map((quote) => {
    const key = [quote.categoryId, quote.specName, quote.regionName, quote.priceType].join('|');
    const history = (historyByKey.get(key) ?? [])
      .filter((row) => row.quoteDate < quote.quoteDate)
      .sort((a, b) => (a.quoteDate < b.quoteDate ? 1 : -1));
    const previous = history[0] ?? null;
    const weekAgoDate = addDays(quote.quoteDate, -7);
    const weekAgo = history.find((row) => row.quoteDate === weekAgoDate) ?? null;
    const currentMid = numericToNumber(quote.valueMid);
    if (currentMid === null) throw new Error(`daily_quote ${quote.id} value_mid 不可解析`);

    const sources = new Map<string, SourceRef>();
    for (const observationId of quote.contributingObservationIds) {
      const observation = observationById.get(observationId);
      if (!observation) throw new Error(`daily_quote ${quote.id} 引用了不存在的观测 ${observationId}`);
      const fetchedAt = timestampToIso(observation.fetchedAt);
      if (!fetchedAt) throw new Error(`观测 ${observationId} 缺少抓取时间`);
      const trustWeight = numericToNumber(observation.trustWeight);
      if (trustWeight === null) throw new Error(`来源 ${observation.sourceCode} 缺少可信权重`);
      sources.set(observation.sourceCode, {
        code: observation.sourceCode,
        name: observation.sourceName,
        trustWeight,
        fetchedAt,
      });
    }
    const sourceList = [...sources.values()].sort((a, b) => a.code.localeCompare(b.code));
    const fetchTimes = sourceList.map((source) => source.fetchedAt).sort();

    return {
      id: quote.id,
      categoryId: quote.categoryId,
      categoryName: quote.categoryName,
      specName: quote.specName,
      regionName: quote.regionName,
      regionLevel: asRegionLevel(quote.regionLevel),
      quoteDate: quote.quoteDate,
      priceType: quote.priceType,
      valueLow: numericToNumber(quote.valueLow) ?? 0,
      valueHigh: numericToNumber(quote.valueHigh) ?? 0,
      valueMid: currentMid,
      method: quote.method,
      methodVersion: quote.methodVersion,
      confidence: quote.confidence,
      coverageNote: quote.coverageNote,
      status: quote.status,
      fetchedFrom: fetchTimes[0] ?? null,
      fetchedTo: fetchTimes[fetchTimes.length - 1] ?? null,
      sources: sourceList,
      previousTradingDay: previous
        ? {
            quoteDate: previous.quoteDate,
            previousValue: numericToNumber(previous.valueMid) ?? 0,
            pct: changePct(currentMid, numericToNumber(previous.valueMid) ?? 0),
          }
        : null,
      weekAgo: weekAgo
        ? {
            quoteDate: weekAgo.quoteDate,
            previousValue: numericToNumber(weekAgo.valueMid) ?? 0,
            pct: changePct(currentMid, numericToNumber(weekAgo.valueMid) ?? 0),
          }
        : null,
    };
  });

  const quoteIds = quotes.map((quote) => quote.id);
  const basisDates = [...new Set(quoteRows.map((quote) => quote.quoteDate))];
  const indicatorRows = await database
    .select({
      id: dbSchema.derivedIndicator.id,
      kind: dbSchema.derivedIndicator.kind,
      categoryId: dbSchema.derivedIndicator.categoryId,
      categoryName: dbSchema.category.nameCn,
      regionName: dbSchema.region.nameCn,
      basisDate: dbSchema.derivedIndicator.basisDate,
      value: dbSchema.derivedIndicator.value,
      methodJson: dbSchema.derivedIndicator.methodJson,
      methodVersion: dbSchema.derivedIndicator.methodVersion,
    })
    .from(dbSchema.derivedIndicator)
    .innerJoin(dbSchema.category, eq(dbSchema.derivedIndicator.categoryId, dbSchema.category.id))
    .innerJoin(dbSchema.region, eq(dbSchema.derivedIndicator.regionId, dbSchema.region.id))
    .where(inArray(dbSchema.derivedIndicator.basisDate, basisDates))
    .orderBy(dbSchema.category.sortOrder);

  const indicatorIds = indicatorRows.map((row) => row.id);
  const contributionRows =
    indicatorIds.length === 0
      ? []
      : await database
          .select({
            indicatorId: dbSchema.indicatorContribution.indicatorId,
            quoteId: dbSchema.indicatorContribution.quoteId,
          })
          .from(dbSchema.indicatorContribution)
          .where(inArray(dbSchema.indicatorContribution.indicatorId, indicatorIds));

  const contributionsByIndicator = new Map<string, string[]>();
  for (const row of contributionRows) {
    const list = contributionsByIndicator.get(row.indicatorId) ?? [];
    list.push(row.quoteId);
    contributionsByIndicator.set(row.indicatorId, list);
  }

  const indicators: BriefingIndicator[] = indicatorRows.map((row) => {
    const quoteIdsForIndicator = contributionsByIndicator.get(row.id) ?? [];
    return {
      id: row.id,
      kind: row.kind,
      kindLabel: INDICATOR_KIND_LABEL[row.kind] ?? row.kind,
      categoryName: row.categoryName,
      regionName: row.regionName,
      basisDate: row.basisDate,
      value: numericToNumber(row.value) ?? 0,
      methodNote: methodNote(row.methodJson),
      methodVersion: row.methodVersion,
      contributionCount: quoteIdsForIndicator.length,
      contributingQuoteIds: quoteIdsForIndicator,
    };
  });

  const openExceptions = await database
    .select({ id: dbSchema.exceptionQueue.id, priority: dbSchema.exceptionQueue.priority })
    .from(dbSchema.exceptionQueue)
    .where(eq(dbSchema.exceptionQueue.status, 'open'));

  const categoriesView: BriefingCategory[] = categories.map((category) => {
    const categoryQuotes = quotes.filter((quote) => quote.categoryId === category.id);
    const categoryIndicators = indicators.filter((indicator) => {
      const row = indicatorRows.find((candidate) => candidate.id === indicator.id);
      return row?.categoryId === category.id;
    });
    const sources = new Set(categoryQuotes.flatMap((quote) => quote.sources.map((source) => source.code)));
    const regions = new Set(categoryQuotes.map((quote) => quote.regionName));
    const specs = new Set(categoryQuotes.map((quote) => quote.specName));
    const gaps: string[] = [];
    if (categoryQuotes.length === 0) gaps.push('今日无已发布报价');
    if (categoryQuotes.some((quote) => quote.confidence === 'low')) gaps.push('存在低置信度报价');
    if (categoryQuotes.some((quote) => quote.sources.length === 0)) gaps.push('存在无来源报价（不应发布）');
    return {
      id: category.id,
      code: category.code,
      name: category.nameCn,
      quotes: categoryQuotes,
      indicators: categoryIndicators,
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
  if (openExceptions.length > 0) globalGaps.push(`异常队列有 ${openExceptions.length} 条待处理（不进简报）`);
  if (quotes.some((quote) => quote.coverageNote?.includes('区域分档暂缺'))) {
    globalGaps.push('区域分档暂缺：统计局旬价是全国参考锚点，不能替代各地废料分档现货价');
  }

  void quoteIds;
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
      openExceptions: openExceptions.length,
      highPriorityExceptions: openExceptions.filter((row) => row.priority === 'high').length,
    },
    globalGaps,
  };
}
