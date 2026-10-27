import { conversionRecord, toCanonicalPerTon } from '@bee/core';
import { dbSchema } from '@bee/db';
import type { BeeDbOrTx } from './ledger';
import {
  getCanonicalUnitId,
  resolvePriceType,
  resolveRegionMapping,
  resolveTermMapping,
  resolveUnitCode,
} from './mapping';
import type { ExtractedRow, NormalizedObservation } from './types';

export const NORMALIZER_VERSION = 'normalize@1.0.0';

function numericString(value: number): string {
  return value.toFixed(2);
}

export interface NormalizeInputRow {
  sourceId: string;
  sourceCode: string;
  fetchId: string;
  fetchedAt: Date;
  /** 采集作业（packages/jobs）不建 pipeline_run，允许为空；观测仍完整落库。 */
  runId: string | null;
  extractVersion: string;
  rows: ExtractedRow[];
}

/**
 * 规范化：映射 + 单位换算，然后**一次性插入**完整观测。
 *
 * 为什么 extract 不直接落观测：price_observation 的 raw/norm/维度字段落库后不可 UPDATE
 * （DB 触发器红线），半成品观测没有第二次写入值的机会。因此 extract 只产内容寻址工件，
 * normalize 在同一事务里把「原文 + 维度 + 规范值」一次写全；校验只允许流转 validation_status。
 */
export async function normalizeRowsPreview(
  db: BeeDbOrTx,
  input: NormalizeInputRow,
): Promise<Array<Omit<NormalizedObservation, 'observationId'>>> {
  if (input.rows.length === 0) return [];
  const canonicalUnitId = await getCanonicalUnitId(db);
  const normalized: Array<Omit<NormalizedObservation, 'observationId'>> = [];

  for (const row of input.rows) {
    const issues: string[] = [];
    const term = await resolveTermMapping(db, {
      sourceId: input.sourceId,
      rawCategoryText: row.rawCategoryText,
      rawSpecText: row.rawSpecText,
    });
    if (!term) issues.push(`品名映射缺失：${row.rawCategoryText}${row.rawSpecText ? ` / ${row.rawSpecText}` : ''}`);

    const region = row.rawRegionText
      ? await resolveRegionMapping(db, { sourceId: input.sourceId, rawRegionText: row.rawRegionText })
      : null;
    if (!row.rawRegionText) issues.push('地域原文为空');
    else if (!region) issues.push(`地域映射缺失：${row.rawRegionText}`);

    const priceType = resolvePriceType(row.rawPriceTypeText);
    if (!priceType) issues.push(`价类型无法识别：${row.rawPriceTypeText ?? '空'}`);

    const unitCode = resolveUnitCode(row.rawUnit);
    if (!unitCode) issues.push(`计价单位不在换算表：${row.rawUnit ?? '空'}（禁止猜测换算）`);

    let normLow: number | null = null;
    let normHigh: number | null = null;
    let conversion: { from: string; factor: number } | null = null;
    if (unitCode) {
      if (row.rawValueLow === null || row.rawValueHigh === null) {
        issues.push('原文价格数字缺失');
      } else {
        normLow = toCanonicalPerTon(row.rawValueLow, unitCode);
        normHigh = toCanonicalPerTon(row.rawValueHigh, unitCode);
        if (normLow === null || normHigh === null) issues.push(`单位换算失败：${unitCode}`);
        else conversion = { ...conversionRecord(unitCode), from: row.rawUnit ?? unitCode };
      }
    }

    normalized.push({
      sourceId: input.sourceId,
      sourceCode: input.sourceCode,
      fetchId: input.fetchId,
      sourceRowIndex: row.sourceRowIndex,
      revision: 1,
      row,
      categoryId: term?.categoryId ?? null,
      specId: term?.specId ?? null,
      regionId: region?.regionId ?? null,
      priceType,
      unitId: canonicalUnitId,
      normValueLow: normLow,
      normValueHigh: normHigh,
      conversionApplied: conversion,
      status: issues.length === 0 ? 'normalized' : 'needs_human',
      issues,
    });
  }

  return normalized;
}

export async function normalizeRows(
  db: BeeDbOrTx,
  input: NormalizeInputRow,
): Promise<NormalizedObservation[]> {
  const normalized = await normalizeRowsPreview(db, input);
  if (normalized.length === 0) return [];
  const inserted = await db
    .insert(dbSchema.priceObservation)
    .values(
      normalized.map((item) => ({
        fetchId: item.fetchId,
        sourceId: item.sourceId,
        fetchedAt: input.fetchedAt,
        sourceRowIndex: item.sourceRowIndex,
        revision: item.revision,
        rawText: item.row.rawText,
        rawValueLow: item.row.rawValueLow === null ? null : numericString(item.row.rawValueLow),
        rawValueHigh: item.row.rawValueHigh === null ? null : numericString(item.row.rawValueHigh),
        rawUnit: item.row.rawUnit,
        rawCategoryText: item.row.rawCategoryText,
        rawSpecText: item.row.rawSpecText,
        rawRegionText: item.row.rawRegionText,
        rawPriceTypeText: item.row.rawPriceTypeText,
        categoryId: item.categoryId,
        specId: item.specId,
        regionId: item.regionId,
        priceType: item.priceType,
        normValueLow: item.normValueLow === null ? null : numericString(item.normValueLow),
        normValueHigh: item.normValueHigh === null ? null : numericString(item.normValueHigh),
        unitId: item.unitId,
        conversionApplied: item.conversionApplied,
        quoteDate: item.row.quoteDate,
        observedAt: item.row.observedAt,
        validationStatus: item.status,
        extractVersion: input.extractVersion,
        normalizerVersion: NORMALIZER_VERSION,
        runId: input.runId,
      })),
    )
    .returning({ id: dbSchema.priceObservation.id });

  return normalized.map((item, index) => ({
    ...item,
    observationId: inserted[index]!.id,
  }));
}
