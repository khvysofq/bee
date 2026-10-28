/**
 * 行情台共享类型与展示常量（无数据库依赖）。
 * 客户端组件只从这里取类型/常量，避免把 @bee/db 拖进浏览器包。
 */

export type MarketScope = 'international' | 'domestic' | 'regional';

export type TrustMark = 'normal' | 'review' | 'gap' | 'reference';

export interface MarketSparkPoint {
  date: string;
  value: number;
}

export interface MarketChange {
  /** 对比的基准日。 */
  date: string;
  previousValue: number;
  /** 真实计算的百分比变化；不来自模型。 */
  pct: number;
}

/**
 * 报价单品页 slug（v4 稳定键，不含每天变化的行 id）。
 * 形如 `p-<categoryCode>-<regionCode>-<specCode|all>-<priceType>`。
 *
 * 约定：category/region code 不含连字符（品类为内部数字码，地域为 WORLD/CN/GB 码）；
 * spec code 允许连字符，因此解析时以「第一个连字符」切品类、以「最后一个连字符」切价类型。
 */
export function quoteSlug(parts: {
  categoryCode: string;
  regionCode: string;
  specCode: string | null;
  priceType: string;
}): string {
  return ['p', parts.categoryCode, parts.regionCode, parts.specCode ?? 'all', parts.priceType].join('-');
}

export interface ParsedQuoteSlug {
  categoryCode: string;
  regionCode: string;
  specCode: string | null;
  priceType: string;
}

export function parseQuoteSlug(slug: string): ParsedQuoteSlug | null {
  if (!slug.startsWith('p-')) return null;
  const rest = slug.slice(2);
  const firstDash = rest.indexOf('-');
  if (firstDash <= 0) return null;
  const categoryCode = rest.slice(0, firstDash);
  const afterCategory = rest.slice(firstDash + 1);
  const lastDash = afterCategory.lastIndexOf('-');
  if (lastDash <= 0) return null;
  const priceType = afterCategory.slice(lastDash + 1);
  const middle = afterCategory.slice(0, lastDash);
  const secondDash = middle.indexOf('-');
  if (secondDash <= 0) return null;
  const regionCode = middle.slice(0, secondDash);
  const specCode = middle.slice(secondDash + 1);
  if (!categoryCode || !regionCode || !priceType) return null;
  return { categoryCode, regionCode, specCode: specCode === 'all' ? null : specCode, priceType };
}

export interface MarketRow {
  key: string;
  /** 单品页 slug：p-<categoryCode>-<regionCode>-<specCode|all>-<priceType>。 */
  slug: string;
  kind: 'series' | 'quote';
  scope: MarketScope;
  categoryCode: string | null;
  categoryName: string | null;
  /** 品类（无品类映射的国际基准用序列名）。 */
  instrument: string;
  /** 规格 / 合约 / 报价口径。 */
  spec: string;
  /** 市场或来源，例如 SHFE · 期货、国家统计局 · 旬价。 */
  market: string;
  marketKind: string;
  unit: string;
  currency: string;
  frequency: 'daily' | 'monthly' | 'weekly' | 'irregular';
  frequencyLabel: string;
  latestValue: number | null;
  latestDate: string | null;
  dayChange: MarketChange | null;
  weekChange: MarketChange | null;
  pointCount: number;
  /** 数据日期（不是抓取时间）；页面列名「更新」。 */
  updatedAt: string | null;
  trust: TrustMark;
  trustLabel: string;
  /** 最近 30 个真实点，升序。 */
  spark: MarketSparkPoint[];
  /** 口径 / 缺口说明，来自库内字段。 */
  note: string | null;
  quoteId?: string;
  seriesId?: string;
}

export interface MarketCategoryFacet {
  code: string;
  name: string;
  count: number;
}

export interface MarketRegionFacet {
  code: string;
  name: string;
  rowCount: number;
}

export interface MarketOverview {
  generatedAt: string;
  /** 全库最新观测日（用于说明各行的时效）。 */
  globalLatest: string | null;
  rows: MarketRow[];
  categories: MarketCategoryFacet[];
  regions: MarketRegionFacet[];
  counts: {
    series: number;
    points: number;
    quotes: number;
    international: number;
    domestic: number;
    regional: number;
  };
  /** 页脚合规署名所需的来源事实（来自 briefing 查询，不是手写）。 */
  dataCutoffAt: string | null;
  hasStatsSource: boolean;
  statsSourceUrl: string | null;
  hasFixtureSource: boolean;
}

/** 轻量搜索索引：给全站头部搜索框做纯前端过滤用，不查询点位。 */
export interface SearchItem {
  href: string;
  label: string;
  meta: string;
  keywords: string;
}

export const SCOPE_LABEL: Record<MarketScope, string> = {
  international: '国际',
  domestic: '国内',
  regional: '区域',
};