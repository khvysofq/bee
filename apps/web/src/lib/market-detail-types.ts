import type { PriceType } from './briefing-data';
import type { MarketChange, MarketSparkPoint, TrustMark } from './market-types';

/**
 * 单品页视图类型（无数据库依赖，可被客户端组件安全引用）。
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