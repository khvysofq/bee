import type { dbSchema } from '@bee/db';
import type { StepRefs } from '@bee/core';

export type SourceRow = typeof dbSchema.source.$inferSelect;
export type DailyQuoteRow = typeof dbSchema.dailyQuote.$inferSelect;
export type DerivedIndicatorRow = typeof dbSchema.derivedIndicator.$inferSelect;

export type PriceType = 'purchase' | 'sale' | 'ex_works' | 'indicative';

/** 适配器抓回的一份原始文档（尚未归档）。 */
export interface SourceDocument {
  sourceCode: string;
  /** 精确请求 URL（fixture 为 fixture:// 伪 URL，真实源为页面 URL）。 */
  url: string;
  fetchedAt: Date;
  httpStatus: number;
  contentType: string;
  /** 原文完整内容；管线负责写内容寻址存档，适配器不得直接写生产表。 */
  body: string;
  pagePublishedAt?: Date;
  fetchMeta?: Record<string, unknown>;
}

/** 来源适配器契约：真实源接入 = 新增实现并在 registry 注册，不改管线主干。 */
export interface SourceAdapter {
  code: string;
  name: string;
  fetcherKind: string;
  license: { id: string; note: string };
  fetch(input: { source: SourceRow; date?: string }): Promise<SourceDocument[]>;
  extract(document: SourceDocument): ExtractedRow[];
}

/** 抽取后的原文行：只带 as-published 文本与确定性解析出的数字，不做映射/换算。 */
export interface ExtractedRow {
  sourceRowIndex: number;
  rawText: string;
  rawValueLow: number | null;
  rawValueHigh: number | null;
  rawUnit: string | null;
  rawCategoryText: string;
  rawSpecText: string | null;
  rawRegionText: string | null;
  rawPriceTypeText: string | null;
  quoteDate: string;
  observedAt: Date | null;
  /** 来源原文的环比数字（as-published）；只进抽取工件，不参与规范化计算。 */
  rawChangeValue?: number | null;
  /** 来源原文的环比百分比（as-published，单位 %）。 */
  rawChangePct?: number | null;
  /** 来源原文的统计期文本，如「2026年10月中旬」。 */
  rawPeriodText?: string | null;
  /** 来源原文的分节文本，如「一、黑色金属」。 */
  rawSectionText?: string | null;
}

/** 抽取工件（content-addressed；extract → normalize 之间只传 ref）。 */
export interface ExtractArtifact {
  schemaVersion: 1;
  runId: string;
  extractVersion: string;
  documents: Array<{
    sourceId: string;
    sourceCode: string;
    fetchId: string;
    contentSha256: string;
    rows: ExtractedRow[];
  }>;
}

/** 规范化后、落库前的观测值。 */
export interface NormalizedObservation {
  observationId: string;
  sourceId: string;
  sourceCode: string;
  fetchId: string;
  sourceRowIndex: number;
  revision: number;
  row: ExtractedRow;
  categoryId: string | null;
  specId: string | null;
  regionId: string | null;
  priceType: PriceType | null;
  unitId: string | null;
  normValueLow: number | null;
  normValueHigh: number | null;
  conversionApplied: { from: string; factor: number } | null;
  status: 'normalized' | 'needs_human';
  issues: string[];
}

export interface ValidationThresholds {
  dayChangePct: number;
  weekChangePct: number;
  crossSourcePct: number;
}

export interface ValidationPlanItem {
  observationKey: string;
  observationId: string | null;
  sourceId: string;
  sourceName: string;
  categoryId: string | null;
  specId: string | null;
  regionId: string | null;
  priceType: PriceType | null;
  quoteDate: string | null;
  normValueLow: number | null;
  normValueHigh: number | null;
  status: 'validated' | 'isolated' | 'needs_human';
  missingDimensions: string[];
  checks: Array<{
    checkKind: 'cross_source' | 'time_series' | 'caliber_consistency' | 'dedupe' | 'threshold_rule';
    verdict: 'pass' | 'flag' | 'isolate' | 'needs_human' | 'reject';
    detail: Record<string, unknown>;
  }>;
  agentReview: {
    verdict: 'pass' | 'flag';
    rationale: string;
    input: Record<string, unknown>;
  };
}

export interface ValidationPlan {
  items: ValidationPlanItem[];
  thresholds: ValidationThresholds;
  counts: { validated: number; isolated: number; needsHuman: number };
}

export interface StepOutput {
  refs: StepRefs;
  log: string;
}

export const DEFAULT_THRESHOLDS: ValidationThresholds = {
  dayChangePct: 0.03,
  weekChangePct: 0.06,
  crossSourcePct: 0.04,
};
