import { z } from 'zod';

/**
 * 溯源契约（交付物六的对外 API 形态，验收 2「简报数字点回原始来源」的实现依据）。
 *
 * 每一个在简报上渲染的数字，都必须携带 quoteId 或 indicatorId；
 * GET /api/trace/quote/{quoteId} / GET /api/trace/indicator/{indicatorId} 返回本结构，
 * 前端渲染「点开数字 → 溯源面板」，一路点到原始抓取的 URL + 抓取时间 + 内容指纹 + 存档原文。
 */
export const traceSourceSchema = z.object({
  code: z.string(),
  name: z.string(),
  /** 来源注册表里的可信权重（0–100），面板必须展示。 */
  trustWeight: z.number(),
  type: z.enum(['webpage', 'rss', 'api']),
});

export const traceValidationSchema = z.object({
  checkKind: z.enum([
    'cross_source',
    'time_series',
    'caliber_consistency',
    'dedupe',
    'threshold_rule',
    'llm_judgment',
    'human_override',
  ]),
  verdict: z.enum(['pass', 'flag', 'isolate', 'needs_human', 'reject']),
  /** rule:xxx@v1 | llm:model+prompt@v3 | human:<id> —— 判断主体与版本。 */
  performedByRef: z.string(),
  detail: z.unknown(),
  at: z.string(),
});

export const traceObservationSchema = z.object({
  observationId: z.string(),
  source: traceSourceSchema,
  /** 抓取的精确 URL —— 溯源链终点之一。 */
  url: z.string(),
  fetchedAt: z.string(),
  contentSha256: z.string(),
  /** 原文价格表述（as-published）。 */
  rawText: z.string(),
  rawValueLow: z.number().nullable(),
  rawValueHigh: z.number().nullable(),
  rawUnit: z.string().nullable(),
  /** 规范化值（元/吨）。 */
  normValueLow: z.number().nullable(),
  normValueHigh: z.number().nullable(),
  quoteDate: z.string().nullable(),
  validationStatus: z.string(),
  validationTrail: z.array(traceValidationSchema),
  /** 存档原文查看器链接：/raw/{fetchId} —— 点开能看到抓取当时的确切内容。 */
  archiveViewerUrl: z.string(),
});

export const traceQuoteResponseSchema = z.object({
  kind: z.literal('daily_quote'),
  quote: z.object({
    id: z.string(),
    categoryName: z.string(),
    specName: z.string(),
    regionName: z.string(),
    regionLevel: z.enum(['market', 'city']),
    quoteDate: z.string(),
    priceType: z.enum(['purchase', 'sale', 'ex_works', 'indicative']),
    valueLow: z.number(),
    valueHigh: z.number(),
    valueMid: z.number(),
    method: z.enum(['single_source', 'median_multi_source', 'weighted_multi_source']),
    methodVersion: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    coverageNote: z.string().nullable(),
    status: z.string(),
  }),
  /** 定档的溯源 = 全部参与观测的溯源。 */
  observations: z.array(traceObservationSchema),
});

export const traceIndicatorResponseSchema = z.object({
  kind: z.literal('derived_indicator'),
  /** 加工指标必须自带「这是加工出来的」语义 —— 前端据此强制渲染加工指标标注与免责口径。 */
  indicator: z.object({
    id: z.string(),
    kind: z.enum(['national_weighted_avg', 'national_median', 'national_reference', 'region_aggregate', 'city_aggregate']),
    categoryName: z.string(),
    regionName: z.string(),
    basisDate: z.string(),
    value: z.number(),
    methodJson: z.unknown(),
    methodVersion: z.string(),
    /** 恒为 true —— 契约层禁止「全国价」以观测值形态出现。 */
    isAggregate: z.literal(true),
  }),
  /** 聚合的溯源 = 参与聚合的全部定档报价 → 再各自溯源到观测与原文。 */
  quotes: z.array(z.object({ quoteId: z.string(), valueAtAggregation: z.number() })),
});

export type TraceQuoteResponse = z.infer<typeof traceQuoteResponseSchema>;
export type TraceIndicatorResponse = z.infer<typeof traceIndicatorResponseSchema>;
export type TraceObservation = z.infer<typeof traceObservationSchema>;

/**
 * PG 行 → trace 契约的转换层（DAW-33 评审修复）。
 *
 * pg 的 numeric 落到 node 侧一律是 string，timestamp 是 Date，标志位是 integer 0/1 ——
 * 而上面的 zod 契约要 number / ISO 字符串 / boolean。本模块是**全库唯一**允许做
 * 这组类型转换的地方（@bee/db client 的纪律：金额精度优先，禁止隐式 Number()）；
 * 单元测试锁死两个方向：直接把 DB 行塞进 schema.parse 必须失败，过转换层必须通过。
 * 聚合与比较运算仍在 DB 的 numeric 里做，这里只为「渲染给前端的溯源面板」做显式转换。
 */

/**
 * numeric → number。null/undefined 透传为 null（契约的可空字段）；
 * 不可解析的值是上游 bug，直接抛 TypeError 而不是悄悄变成 NaN。
 */
export function numericToNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  // Number('') 与 Number('  ') 会得 0 而不是 NaN —— 空串不是合法的 numeric 值，显式拒绝。
  if (typeof value === 'string' && value.trim() === '') {
    throw new TypeError(`numeric 字段收到不可解析的值：${JSON.stringify(value)}`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`numeric 字段收到不可解析的值：${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * 标志位（PG integer 0/1 或 boolean）→ boolean。
 * 典型用途：derived_indicator.is_aggregate（1 → true，契约层 z.literal(true)）、
 * unit.is_canonical、spec_grade.is_core。null 视为 false —— 调用方应在有值场景使用本函数。
 */
export function flagToBoolean(value: 0 | 1 | boolean | null | undefined): boolean {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false || value === null || value === undefined) return false;
  throw new TypeError(`标志字段收到非法值：${JSON.stringify(value)}`);
}

/**
 * timestamp / ISO 字符串 → 契约要求的 ISO 字符串（fetchedAt、at、quoteDate、basisDate）。
 * null/undefined 透传为 null —— 契约里 quoteDate 本就可空（抓取时页面未标价期）；
 * 没有这层透传时 new Date(null) 会悄悄变成 epoch（1970-01-01），比缺数据更糟。
 * 其余无效输入直接抛。
 */
export function timestampToIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`时间字段收到不可解析的值：${JSON.stringify(value)}`);
  }
  return d.toISOString();
}
