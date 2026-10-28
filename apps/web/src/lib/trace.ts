import { eq } from 'drizzle-orm';
import { v4, type BeeDb } from '@bee/db';
import {
  numericToNumber,
  timestampToIso,
  traceQuoteResponseSchema,
  type TraceIndicatorResponse,
  type TraceQuoteResponse,
} from '@bee/core';
import { db as defaultDb } from '../db';

/**
 * 溯源数据层（v4）。
 *
 * v4 没有观测/校验/归档表：一条 price_daily 就是一次来源直发的价格记录。
 * loadQuoteTrace 按 price_daily.id 返回「这条价格本身 + 品类/规格/地域 + 来源 + raw_url」，
 * 旧 observation/validation 字段用空值/中性默认值填，绝不伪造观测 id 或校验结论。
 *
 * 指标与期货序列在 v4 中不存在，对应 loader 返回 null（调用方按 404 处理）。
 */

function regionLevelForTrace(level: string): 'market' | 'city' {
  return level === 'city' ? 'city' : 'market';
}

/**
 * 定档报价溯源：price_daily → 品类 / 规格 / 地域 / 来源 / 原文链接。
 * 返回值仍通过 @bee/core 契约解析，字段漂移会在这里 fail-loud。
 */
export async function loadQuoteTrace(
  quoteId: string,
  database: BeeDb = defaultDb,
): Promise<TraceQuoteResponse | null> {
  const [row] = await database
    .select({
      id: v4.priceDaily.id,
      categoryName: v4.category.nameCn,
      specName: v4.spec.name,
      regionName: v4.region.name,
      regionLevel: v4.region.level,
      priceDate: v4.priceDaily.priceDate,
      priceType: v4.priceDaily.priceType,
      valueLow: v4.priceDaily.valueLow,
      valueHigh: v4.priceDaily.valueHigh,
      valueMid: v4.priceDaily.valueMid,
      unit: v4.priceDaily.unit,
      note: v4.priceDaily.note,
      status: v4.priceDaily.status,
      rawUrl: v4.priceDaily.rawUrl,
      capturedAt: v4.priceDaily.capturedAt,
      sourceCode: v4.source.code,
      sourceName: v4.source.name,
      sourceBaseUrl: v4.source.baseUrl,
    })
    .from(v4.priceDaily)
    .innerJoin(v4.category, eq(v4.category.id, v4.priceDaily.categoryId))
    .leftJoin(v4.spec, eq(v4.spec.id, v4.priceDaily.specId))
    .innerJoin(v4.region, eq(v4.region.id, v4.priceDaily.regionId))
    .leftJoin(v4.source, eq(v4.source.id, v4.priceDaily.sourceId))
    .where(eq(v4.priceDaily.id, quoteId));

  if (!row) return null;

  const valueMid = numericToNumber(row.valueMid);
  if (valueMid === null) return null;

  const url = row.rawUrl ?? row.sourceBaseUrl ?? '';
  const fetchedAt = timestampToIso(row.capturedAt) ?? '';
  const observations =
    row.sourceCode || url.length > 0
      ? [
          {
            // v4 没有独立观测 id；价格行本身就是最短证据链，这里复用行 id。
            observationId: row.id,
            source: {
              code: row.sourceCode ?? 'unknown',
              name: row.sourceName ?? '未登记来源',
              trustWeight: 0,
              type: url ? ('webpage' as const) : ('api' as const),
            },
            url,
            fetchedAt,
            contentSha256: '',
            rawText: row.note ?? '',
            rawValueLow: numericToNumber(row.valueLow),
            rawValueHigh: numericToNumber(row.valueHigh),
            rawUnit: row.unit,
            normValueLow: numericToNumber(row.valueLow),
            normValueHigh: numericToNumber(row.valueHigh),
            quoteDate: row.priceDate,
            validationStatus: 'unvalidated',
            validationTrail: [],
            archiveViewerUrl: url,
          },
        ]
      : [];

  const trace = {
    kind: 'daily_quote' as const,
    quote: {
      id: row.id,
      categoryName: row.categoryName,
      specName: row.specName ?? '品类级',
      regionName: row.regionName,
      regionLevel: regionLevelForTrace(row.regionLevel),
      quoteDate: row.priceDate,
      priceType: row.priceType,
      valueLow: numericToNumber(row.valueLow) ?? valueMid,
      valueHigh: numericToNumber(row.valueHigh) ?? valueMid,
      valueMid,
      method: 'single_source' as const,
      methodVersion: 'v4',
      confidence: 'medium' as const,
      coverageNote: row.note,
      status: row.status,
    },
    observations,
  };

  return traceQuoteResponseSchema.parse(trace);
}

function downloadedUrl(url: string): boolean {
  return url.length > 0;
}

/** 加工指标在 v4 已删除；调用方按 404 处理。 */
export async function loadIndicatorTrace(
  _indicatorId: string,
  _database: BeeDb = defaultDb,
): Promise<TraceIndicatorResponse | null> {
  return null;
}

export interface SeriesPointTrace {
  kind: 'series_point';
  point: {
    id: string;
    seriesCode: string;
    seriesName: string;
    venue: string | null;
    instrumentCode: string;
    obsDate: string;
    revision: number;
    value: number;
    unit: string | null;
    currency: string;
  };
  source: {
    code: string;
    name: string;
    type: string;
    trustWeight: number;
  };
  url: string;
  fetchedAt: string;
  contentSha256: string;
  sourceRowIndex: number;
  archiveViewerUrl: string;
}

/** 期货/指数序列在 v4 已删除；调用方按 404 处理。 */
export async function loadSeriesPointTrace(
  _pointId: string,
  _database: BeeDb = defaultDb,
): Promise<SeriesPointTrace | null> {
  return null;
}