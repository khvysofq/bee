import { asc, eq, inArray } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import {
  flagToBoolean,
  numericToNumber,
  timestampToIso,
  traceIndicatorResponseSchema,
  traceQuoteResponseSchema,
  type TraceIndicatorResponse,
  type TraceQuoteResponse,
} from '@bee/core';
import { db as defaultDb } from '../db';

function isoRequired(value: Date | string | null, label: string): string {
  const iso = timestampToIso(value);
  if (!iso) throw new Error(`${label} 缺少时间`);
  return iso;
}

function numberRequired(value: string | number | null, label: string): number {
  const n = numericToNumber(value);
  if (n === null) throw new Error(`${label} 缺少数值`);
  return n;
}

function regionLevel(level: string): 'market' | 'city' {
  if (level !== 'market' && level !== 'city') {
    throw new Error(`daily_quote 只能挂在 market/city 地域：收到 ${level}`);
  }
  return level;
}

/**
 * 定档报价溯源：quote → 全部参与观测 → 原始抓取（URL/时间/内容指纹）+ 校验留痕。
 * 返回值通过 @bee/core 的 traceQuoteResponseSchema 解析，任何字段漂移都会在这里 fail-loud。
 */
export async function loadQuoteTrace(
  quoteId: string,
  database: BeeDb = defaultDb,
): Promise<TraceQuoteResponse | null> {
  const [quote] = await database
    .select({
      id: dbSchema.dailyQuote.id,
      categoryName: dbSchema.category.nameCn,
      specName: dbSchema.specGrade.nameCn,
      regionName: dbSchema.region.nameCn,
      regionLevel: dbSchema.region.level,
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
    .where(eq(dbSchema.dailyQuote.id, quoteId));

  if (!quote) return null;

  const observationIds = quote.contributingObservationIds;
  const observations = await database
    .select({
      id: dbSchema.priceObservation.id,
      fetchId: dbSchema.priceObservation.fetchId,
      sourceCode: dbSchema.source.code,
      sourceName: dbSchema.source.name,
      sourceType: dbSchema.source.type,
      trustWeight: dbSchema.source.trustWeight,
      url: dbSchema.rawFetch.url,
      fetchedAt: dbSchema.rawFetch.fetchedAt,
      contentSha256: dbSchema.rawFetch.contentSha256,
      rawText: dbSchema.priceObservation.rawText,
      rawValueLow: dbSchema.priceObservation.rawValueLow,
      rawValueHigh: dbSchema.priceObservation.rawValueHigh,
      rawUnit: dbSchema.priceObservation.rawUnit,
      normValueLow: dbSchema.priceObservation.normValueLow,
      normValueHigh: dbSchema.priceObservation.normValueHigh,
      quoteDate: dbSchema.priceObservation.quoteDate,
      validationStatus: dbSchema.priceObservation.validationStatus,
    })
    .from(dbSchema.priceObservation)
    .innerJoin(dbSchema.source, eq(dbSchema.priceObservation.sourceId, dbSchema.source.id))
    .innerJoin(dbSchema.rawFetch, eq(dbSchema.priceObservation.fetchId, dbSchema.rawFetch.id))
    .where(inArray(dbSchema.priceObservation.id, observationIds));

  if (observations.length !== observationIds.length) {
    throw new Error(`定档 ${quoteId} 的贡献观测缺失：声明 ${observationIds.length}，实际 ${observations.length}`);
  }

  const validations =
    observationIds.length === 0
      ? []
      : await database
          .select({
            observationId: dbSchema.validationResult.observationId,
            checkKind: dbSchema.validationResult.checkKind,
            verdict: dbSchema.validationResult.verdict,
            performedByRef: dbSchema.validationResult.performedByRef,
            detail: dbSchema.validationResult.detail,
            at: dbSchema.validationResult.createdAt,
          })
          .from(dbSchema.validationResult)
          .where(inArray(dbSchema.validationResult.observationId, observationIds))
          .orderBy(asc(dbSchema.validationResult.createdAt));

  const trailByObservation = new Map<string, typeof validations>();
  for (const row of validations) {
    const list = trailByObservation.get(row.observationId) ?? [];
    list.push(row);
    trailByObservation.set(row.observationId, list);
  }

  const trace = {
    kind: 'daily_quote' as const,
    quote: {
      id: quote.id,
      categoryName: quote.categoryName,
      specName: quote.specName,
      regionName: quote.regionName,
      regionLevel: regionLevel(quote.regionLevel),
      quoteDate: quote.quoteDate,
      priceType: quote.priceType,
      valueLow: numberRequired(quote.valueLow, 'quote.value_low'),
      valueHigh: numberRequired(quote.valueHigh, 'quote.value_high'),
      valueMid: numberRequired(quote.valueMid, 'quote.value_mid'),
      method: quote.method,
      methodVersion: quote.methodVersion,
      confidence: quote.confidence,
      coverageNote: quote.coverageNote,
      status: quote.status,
    },
    observations: observations.map((observation) => ({
      observationId: observation.id,
      source: {
        code: observation.sourceCode,
        name: observation.sourceName,
        trustWeight: numberRequired(observation.trustWeight, 'source.trust_weight'),
        type: observation.sourceType,
      },
      url: observation.url,
      fetchedAt: isoRequired(observation.fetchedAt, 'raw_fetch.fetched_at'),
      contentSha256: observation.contentSha256,
      rawText: observation.rawText,
      rawValueLow: numericToNumber(observation.rawValueLow),
      rawValueHigh: numericToNumber(observation.rawValueHigh),
      rawUnit: observation.rawUnit,
      normValueLow: numericToNumber(observation.normValueLow),
      normValueHigh: numericToNumber(observation.normValueHigh),
      quoteDate: observation.quoteDate,
      validationStatus: observation.validationStatus,
      validationTrail: (trailByObservation.get(observation.id) ?? []).map((row) => ({
        checkKind: row.checkKind,
        verdict: row.verdict,
        performedByRef: row.performedByRef,
        detail: row.detail,
        at: isoRequired(row.at, 'validation_result.created_at'),
      })),
      archiveViewerUrl: `/internal/raw/${observation.fetchId}`,
    })),
  };

  return traceQuoteResponseSchema.parse(trace);
}

/**
 * 加工指标溯源：indicator → 贡献定档报价（含聚合时值快照）。
 * 每个 quoteId 可继续调用 /api/trace/quote/{quoteId} 追到观测与原文。
 */
export async function loadIndicatorTrace(
  indicatorId: string,
  database: BeeDb = defaultDb,
): Promise<TraceIndicatorResponse | null> {
  const [indicator] = await database
    .select({
      id: dbSchema.derivedIndicator.id,
      kind: dbSchema.derivedIndicator.kind,
      categoryName: dbSchema.category.nameCn,
      regionName: dbSchema.region.nameCn,
      basisDate: dbSchema.derivedIndicator.basisDate,
      value: dbSchema.derivedIndicator.value,
      methodJson: dbSchema.derivedIndicator.methodJson,
      methodVersion: dbSchema.derivedIndicator.methodVersion,
      isAggregate: dbSchema.derivedIndicator.isAggregate,
    })
    .from(dbSchema.derivedIndicator)
    .innerJoin(dbSchema.category, eq(dbSchema.derivedIndicator.categoryId, dbSchema.category.id))
    .innerJoin(dbSchema.region, eq(dbSchema.derivedIndicator.regionId, dbSchema.region.id))
    .where(eq(dbSchema.derivedIndicator.id, indicatorId));

  if (!indicator) return null;

  const contributions = await database
    .select({
      quoteId: dbSchema.indicatorContribution.quoteId,
      valueAtAggregation: dbSchema.indicatorContribution.valueAtAggregation,
    })
    .from(dbSchema.indicatorContribution)
    .where(eq(dbSchema.indicatorContribution.indicatorId, indicatorId));

  const trace = {
    kind: 'derived_indicator' as const,
    indicator: {
      id: indicator.id,
      kind: indicator.kind,
      categoryName: indicator.categoryName,
      regionName: indicator.regionName,
      basisDate: indicator.basisDate,
      value: numberRequired(indicator.value, 'indicator.value'),
      methodJson: indicator.methodJson,
      methodVersion: indicator.methodVersion,
      isAggregate: flagToBoolean(indicator.isAggregate as 0 | 1),
    },
    quotes: contributions.map((row) => ({
      quoteId: row.quoteId,
      valueAtAggregation: numberRequired(row.valueAtAggregation, 'indicator_contribution.value_at_aggregation'),
    })),
  };

  return traceIndicatorResponseSchema.parse(trace);
}
