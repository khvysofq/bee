import { dbSchema, type BeeDb } from '@bee/db';
import { db as defaultDb } from '../../db';
import {
  PRICE_TYPE_LABEL,
  loadBriefing,
  type BriefingCategory,
  type BriefingData,
  type BriefingIndicator,
  type BriefingQuote,
  type ChangeView,
} from '../briefing-data';
import { loadQuoteSeries, quoteSeriesKey, seriesCutoff } from '../landing-data';
import { arrowOf, confidenceLabel, directionOf, formatNumber, signedPct } from '../presentation';
import { STATIC_LEXICON, normalizeQuestion, type ParsedQuestion, type QaLexicon } from './retrieve';
import { hasNumber, type QaFactCard, type QaFactRow, type QaFigureOrigin, type QaScopeView } from './types';

/**
 * 事实层（GUA-35）。
 *
 * 唯一职责：把 `daily_quote` / `derived_indicator` 里**已经存在的数字**取出来，
 * 格式化成带出处的 `QaFactRow`。这里不做任何计算，除了：
 *  - 涨跌幅（沿用 loadBriefing 已经算好的真实变化，缺失就是 null，不当作持平）；
 *  - 覆盖计数（对当天已发布报价的地域数 / 规格数 / 条数计数）。
 *
 * 禁止事项：不写死任何价格、不外推、不插值、不用其他日期或其他地域顶替缺失。
 */

/** 一次回答最多渲染的事实卡片数（超出部分引导去行情数据页看全量）。 */
export const MAX_FACT_CARDS = 6;

export interface QaFactBundle {
  /** 事实层是否可用（数据库不可达或全库无已发布报价时为 false）。 */
  available: boolean;
  /** 数据库异常信息（不渲染给用户，仅日志/测试用）。 */
  error: string | null;
  latestQuoteDate: string | null;
  cards: QaFactCard[];
  scope: QaScopeView | null;
  /** 诚实的缺口说明：查不到就说没有，一律不含数字。 */
  missing: string[];
  /** 命中的品类真名（用于叙事模板）。 */
  matchedCategoryName: string | null;
  /** 是否有超出卡片上限的匹配被截断。 */
  truncated: boolean;
}

function row(label: string, text: string, origin: QaFigureOrigin): QaFactRow {
  return { label, text, origin, hasNumber: hasNumber(text) };
}

function priceText(value: number): string {
  return `${formatNumber(value)} 元/吨`;
}

/** 涨跌行：有可比报价才给数字；没有就写「无可比报价」，绝不写成持平。 */
function changeRow(label: string, change: ChangeView | null, quoteId: string, field: string): QaFactRow {
  const origin: QaFigureOrigin = { kind: 'daily_quote', id: quoteId, field };
  if (!change) return { label, text: '无可比报价', origin, hasNumber: false };
  const arrow = arrowOf(directionOf(change.pct));
  return row(label, `${arrow} ${signedPct(change.pct)}（对比 ${change.quoteDate}）`, origin);
}

function quoteCard(category: BriefingCategory, quote: BriefingQuote): QaFactCard {
  const origin = (field: string): QaFigureOrigin => ({ kind: 'daily_quote', id: quote.id, field });
  return {
    kind: 'quote',
    title: `${category.name} · ${quote.specName} · ${quote.regionName} · ${PRICE_TYPE_LABEL[quote.priceType]}`,
    refId: quote.id,
    refTable: 'daily_quote',
    rows: [
      row('报价日', quote.quoteDate, origin('quote_date')),
      row('最低价', priceText(quote.valueLow), origin('value_low')),
      row('最高价', priceText(quote.valueHigh), origin('value_high')),
      row('中值', priceText(quote.valueMid), origin('value_mid')),
      changeRow('较上一交易日', quote.previousTradingDay, quote.id, 'change_prev'),
      changeRow('较上周同期', quote.weekAgo, quote.id, 'change_week'),
      row('可信度', confidenceLabel(quote.confidence), origin('confidence')),
    ],
  };
}

function indicatorCard(category: BriefingCategory, indicator: BriefingIndicator): QaFactCard {
  const origin = (field: string): QaFigureOrigin => ({ kind: 'derived_indicator', id: indicator.id, field });
  return {
    kind: 'indicator',
    title: `${category.name} · ${indicator.regionName} · ${indicator.kindLabel}`,
    refId: indicator.id,
    refTable: 'derived_indicator',
    rows: [
      row('基准日', indicator.basisDate, origin('basis_date')),
      row('数值', priceText(indicator.value), origin('value')),
      row('参与报价条数', `${indicator.contributionCount} 条`, origin('contribution_count')),
    ],
  };
}

interface SeriesMeta {
  title: string;
  categoryName: string;
}

function seriesCard(meta: SeriesMeta, points: { date: string; value: number; quoteId: string }[]): QaFactCard {
  const last = points[points.length - 1];
  return {
    kind: 'series',
    title: meta.title,
    refId: last?.quoteId ?? '',
    refTable: 'daily_quote',
    rows: points.map((point) =>
      row(
        '报价日 → 中值',
        `${point.date} → ${priceText(point.value)}`,
        { kind: 'daily_quote', id: point.quoteId, field: 'series_point' },
      ),
    ),
  };
}

function scopeOf(categories: BriefingCategory[], latestQuoteDate: string | null): QaScopeView | null {
  if (!latestQuoteDate) return null;
  const scopeQuotes = categories.flatMap((category) =>
    category.quotes.filter((quote) => quote.quoteDate === latestQuoteDate),
  );
  const regions = new Set(scopeQuotes.map((quote) => quote.regionName));
  const specs = new Set(scopeQuotes.map((quote) => quote.specName));
  const available: string[] = [];
  const seen = new Set<string>();
  for (const category of categories) {
    for (const quote of category.quotes) {
      if (quote.quoteDate !== latestQuoteDate) continue;
      const line = `${category.name} · ${quote.specName} · ${quote.regionName} · ${PRICE_TYPE_LABEL[quote.priceType]}`;
      if (seen.has(line)) continue;
      seen.add(line);
      if (available.length < 8) available.push(line);
    }
  }
  const aggregate = (field: string): QaFigureOrigin => ({ kind: 'daily_quote_aggregate', field });
  return {
    latestQuoteDate,
    available,
    rows: [
      row('最新报价日', latestQuoteDate, aggregate('latest_quote_date')),
      row('当天覆盖地域', `${regions.size} 个`, aggregate('regions')),
      row('当天覆盖规格', `${specs.size} 个`, aggregate('specs')),
      row('当天报价条数', `${scopeQuotes.length} 条`, aggregate('quote_count')),
    ],
  };
}

function comboDescription(parsed: ParsedQuestion): string {
  const parts = [
    parsed.category?.name,
    parsed.spec?.name,
    parsed.region?.name,
    parsed.priceType ? PRICE_TYPE_LABEL[parsed.priceType.type] : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : '所问组合';
}

function emptyBundle(missing: string[], error: string | null = null): QaFactBundle {
  return {
    available: false,
    error,
    latestQuoteDate: null,
    cards: [],
    scope: null,
    missing,
    matchedCategoryName: null,
    truncated: false,
  };
}

/** 词表：数据库真名 + 静态口语别名。数据库不可用时退回静态词表。 */
export async function loadQaLexicon(database: BeeDb = defaultDb): Promise<QaLexicon> {
  const [categoryRows, specRows, regionRows] = await Promise.all([
    database
      .select({ id: dbSchema.category.id, code: dbSchema.category.code, nameCn: dbSchema.category.nameCn })
      .from(dbSchema.category),
    database
      .select({ categoryId: dbSchema.specGrade.categoryId, nameCn: dbSchema.specGrade.nameCn })
      .from(dbSchema.specGrade),
    database.select({ nameCn: dbSchema.region.nameCn }).from(dbSchema.region),
  ]);

  const codeById = new Map(categoryRows.map((item) => [item.id, item.code]));
  const staticAlias = (items: { name: string; aliases: string[] }[], name: string): string[] => {
    const hit = items.find((item) => normalizeQuestion(item.name) === normalizeQuestion(name));
    return hit ? hit.aliases : [];
  };

  const categories = categoryRows.map((item) => ({
    code: item.code,
    name: item.nameCn,
    aliases: [...new Set([item.nameCn, ...staticAlias(STATIC_LEXICON.categories, item.nameCn)])],
  }));
  const specs = specRows.map((item) => ({
    categoryCode: codeById.get(item.categoryId) ?? '',
    name: item.nameCn,
    aliases: [...new Set([item.nameCn, ...staticAlias(STATIC_LEXICON.specs, item.nameCn)])],
  }));
  const regions = regionRows.map((item) => ({
    name: item.nameCn,
    aliases: [...new Set([item.nameCn, ...staticAlias(STATIC_LEXICON.regions, item.nameCn)])],
  }));

  return {
    categories: categories.length > 0 ? categories : STATIC_LEXICON.categories,
    specs: specs.length > 0 ? specs : STATIC_LEXICON.specs,
    // 地域词表始终并入静态别名：「全国」这类问法不一定在 region 表里。
    regions: [...regions, ...STATIC_LEXICON.regions.filter((item) => item.name === '全国')],
    priceTypes: STATIC_LEXICON.priceTypes,
  };
}

/** 取事实：全部数字都带 daily_quote / derived_indicator 出处。 */
export async function loadQaFacts(
  parsed: ParsedQuestion,
  database: BeeDb = defaultDb,
): Promise<QaFactBundle> {
  let briefing: BriefingData;
  try {
    briefing = await loadBriefing(database);
  } catch (error) {
    return emptyBundle(
      ['报价数据暂时取不到，这次只能回答行业常识类问题。数字不会用估算值填充。'],
      error instanceof Error ? error.message : String(error),
    );
  }

  const latest = briefing.latestQuoteDate;
  if (!latest) {
    return emptyBundle(['报价库里还没有已发布的报价。数据上线后，这里会直接显示真实报价与变化。']);
  }

  const matchedCategories = parsed.category
    ? briefing.categories.filter((category) => category.code === parsed.category?.code)
    : briefing.categories;

  if (parsed.category && matchedCategories.length === 0) {
    return {
      available: true,
      error: null,
      latestQuoteDate: latest,
      cards: [],
      scope: scopeOf(briefing.categories, latest),
      missing: [
        `「${parsed.category.name}」不在当前报价范围内。`,
        '当前能看到什么，见下方数据范围；范围之外的品类我们不猜、不估。',
      ],
      matchedCategoryName: parsed.category.name,
      truncated: false,
    };
  }

  // 「全国」只能来自 derived_indicator：绝不拿某一地的 daily_quote 顶替。
  if (parsed.asksNational) {
    const indicators = matchedCategories.flatMap((category) =>
      category.indicators
        .filter((indicator) => !parsed.region || indicator.regionName === parsed.region.name)
        .map((indicator) => indicatorCard(category, indicator)),
    );
    const missing: string[] = [];
    if (indicators.length === 0) {
      missing.push(
        `当前没有「${comboDescription(parsed)}」的全国数字。`,
        '全国数字只能来自加工后的指标或来源直接发布的参考价，不会用某一地的报价顶替。',
      );
    }
    return {
      available: true,
      error: null,
      latestQuoteDate: latest,
      cards: indicators.slice(0, MAX_FACT_CARDS),
      scope: scopeOf(matchedCategories, latest),
      missing,
      matchedCategoryName: matchedCategories[0]?.name ?? parsed.category?.name ?? null,
      truncated: indicators.length > MAX_FACT_CARDS,
    };
  }

  const matches = matchedCategories.flatMap((category) =>
    category.quotes
      .filter((quote) => quote.quoteDate === latest)
      .filter((quote) => !parsed.spec || normalizeQuestion(quote.specName) === normalizeQuestion(parsed.spec!.name))
      .filter((quote) => !parsed.region || normalizeQuestion(quote.regionName) === normalizeQuestion(parsed.region!.name))
      .filter((quote) => !parsed.priceType || quote.priceType === parsed.priceType!.type)
      .map((quote) => ({ category, quote })),
  );

  const missing: string[] = [];
  const cards: QaFactCard[] = [];
  // 没指定品类时少放几张卡片，避免把整库当天报价糊在回答里。
  const cardCap = parsed.category ? MAX_FACT_CARDS : 3;

  if (matches.length === 0) {
    missing.push(
      `最新报价日没有「${comboDescription(parsed)}」这一组合的报价。`,
      '没有就是没有：不当作持平，不用估算值填充，也不拿其他日期或其他地域的数字顶替。',
    );
  }

  for (const match of matches.slice(0, cardCap)) {
    cards.push(quoteCard(match.category, match.quote));
  }

  // 序列：只连真实存在的报价日，缺失日期不补点。
  if (parsed.asksSeries && matches.length > 0) {
    try {
      const seriesMap = await loadQuoteSeries(database);
      const cutoff = seriesCutoff(latest);
      const usedKeys = new Set<string>();
      for (const match of matches) {
        if (usedKeys.size >= 2) break;
        const key = quoteSeriesKey({
          categoryCode: match.category.code,
          specName: match.quote.specName,
          regionName: match.quote.regionName,
          priceType: match.quote.priceType,
        });
        if (usedKeys.has(key)) continue;
        usedKeys.add(key);
        const points = (seriesMap.get(key) ?? [])
          .filter((point) => !cutoff || point.date >= cutoff)
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        if (points.length < 2) {
          missing.push(
            `「${match.category.name} · ${match.quote.specName} · ${match.quote.regionName}」的历史报价还在积累，不足两个报价日，给不出序列。`,
            '缺失的日期不补点、不插值。',
          );
          continue;
        }
        cards.push(
          seriesCard(
            {
              title: `${match.category.name} · ${match.quote.specName} · ${match.quote.regionName} · ${PRICE_TYPE_LABEL[match.quote.priceType]} · 近两周序列`,
              categoryName: match.category.name,
            },
            points,
          ),
        );
      }
    } catch (error) {
      missing.push('历史序列这次没取到，只展示最新报价日的数字。');
      return {
        available: true,
        error: error instanceof Error ? error.message : String(error),
        latestQuoteDate: latest,
        cards,
        scope: scopeOf(matchedCategories, latest),
        missing,
        matchedCategoryName: matchedCategories[0]?.name ?? null,
        truncated: matches.length > cardCap,
      };
    }
  }

  return {
    available: true,
    error: null,
    latestQuoteDate: latest,
    cards,
    scope: scopeOf(matchedCategories, latest),
    missing,
    matchedCategoryName: matchedCategories[0]?.name ?? parsed.category?.name ?? null,
    truncated: matches.length > cardCap,
  };
}
