import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { numericToNumber, timestampToIso } from '@bee/core';
import { db as defaultDb } from '../db';

export const MAX_ARCHIVE_VIEW_BYTES = 2 * 1024 * 1024;

function findWorkspaceRoot(start: string): string {
  let current = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(start);
}

export function resolveStoreRoot(): string {
  const configured = process.env.RAW_STORE_DIR ?? './data/raw-store';
  if (path.isAbsolute(configured)) return configured;
  return path.resolve(findWorkspaceRoot(process.cwd()), configured);
}

function assertSafeContentRef(contentRef: string): void {
  if (path.isAbsolute(contentRef) || contentRef.split(/[\\/]/).includes('..')) {
    throw new Error(`内容引用越界：${contentRef}`);
  }
}

function sha256Hex(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface ArchiveObservationView {
  id: string;
  sourceRowIndex: number;
  revision: number;
  rawText: string;
  rawValueLow: number | null;
  rawValueHigh: number | null;
  rawUnit: string | null;
  rawCategoryText: string;
  rawSpecText: string | null;
  rawRegionText: string | null;
  rawPriceTypeText: string | null;
  categoryName: string | null;
  specName: string | null;
  regionName: string | null;
  priceType: string | null;
  normValueLow: number | null;
  normValueHigh: number | null;
  conversionApplied: unknown;
  validationStatus: string;
  validationTrail: Array<{
    checkKind: string;
    verdict: string;
    performedByRef: string;
    detail: unknown;
    at: string;
  }>;
}

export interface ArchivePageData {
  fetch: {
    id: string;
    url: string;
    fetchedAt: string;
    httpStatus: number;
    contentType: string | null;
    contentSizeBytes: number | null;
    pagePublishedAt: string | null;
    contentSha256: string;
    contentRef: string;
    fetchMeta: unknown;
  };
  source: {
    code: string;
    name: string;
    type: string;
    baseUrl: string;
    tosUrl: string | null;
    robotsStatus: string;
    robotsNote: string | null;
    trustWeight: number;
    trustNote: string | null;
  };
  archive: {
    body: string;
    bytes: number;
    sha256Matches: boolean;
    truncated: boolean;
    storeRoot: string;
  };
  observations: ArchiveObservationView[];
}

export async function loadArchivePageData(
  fetchId: string,
  database: BeeDb = defaultDb,
): Promise<ArchivePageData | null> {
  const [row] = await database
    .select({
      id: dbSchema.rawFetch.id,
      url: dbSchema.rawFetch.url,
      fetchedAt: dbSchema.rawFetch.fetchedAt,
      httpStatus: dbSchema.rawFetch.httpStatus,
      contentType: dbSchema.rawFetch.contentType,
      contentSizeBytes: dbSchema.rawFetch.contentSizeBytes,
      pagePublishedAt: dbSchema.rawFetch.pagePublishedAt,
      contentSha256: dbSchema.rawFetch.contentSha256,
      fetchMeta: dbSchema.rawFetch.fetchMeta,
      contentRef: dbSchema.rawContent.contentRef,
      sourceCode: dbSchema.source.code,
      sourceName: dbSchema.source.name,
      sourceType: dbSchema.source.type,
      baseUrl: dbSchema.source.baseUrl,
      tosUrl: dbSchema.source.tosUrl,
      robotsStatus: dbSchema.source.robotsStatus,
      robotsNote: dbSchema.source.robotsNote,
      trustWeight: dbSchema.source.trustWeight,
      trustNote: dbSchema.source.trustNote,
    })
    .from(dbSchema.rawFetch)
    .innerJoin(dbSchema.rawContent, eq(dbSchema.rawFetch.contentSha256, dbSchema.rawContent.contentSha256))
    .innerJoin(dbSchema.source, eq(dbSchema.rawFetch.sourceId, dbSchema.source.id))
    .where(eq(dbSchema.rawFetch.id, fetchId));

  if (!row) return null;

  const storeRoot = resolveStoreRoot();
  assertSafeContentRef(row.contentRef);
  const file = path.resolve(storeRoot, row.contentRef);
  if (!file.startsWith(`${path.resolve(storeRoot)}${path.sep}`)) {
    throw new Error(`内容引用越界：${row.contentRef}`);
  }

  let buffer: Buffer | null = null;
  let readError: string | null = null;
  try {
    buffer = await readFile(file);
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }

  const body = buffer ? buffer.toString('utf8') : `[存档文件不可读] ${readError ?? '未知错误'}`;
  const bytes = buffer?.byteLength ?? 0;
  const truncated = Buffer.byteLength(body, 'utf8') > MAX_ARCHIVE_VIEW_BYTES;

  const observationRows = await database
    .select({
      id: dbSchema.priceObservation.id,
      sourceRowIndex: dbSchema.priceObservation.sourceRowIndex,
      revision: dbSchema.priceObservation.revision,
      rawText: dbSchema.priceObservation.rawText,
      rawValueLow: dbSchema.priceObservation.rawValueLow,
      rawValueHigh: dbSchema.priceObservation.rawValueHigh,
      rawUnit: dbSchema.priceObservation.rawUnit,
      rawCategoryText: dbSchema.priceObservation.rawCategoryText,
      rawSpecText: dbSchema.priceObservation.rawSpecText,
      rawRegionText: dbSchema.priceObservation.rawRegionText,
      rawPriceTypeText: dbSchema.priceObservation.rawPriceTypeText,
      categoryName: dbSchema.category.nameCn,
      specName: dbSchema.specGrade.nameCn,
      regionName: dbSchema.region.nameCn,
      priceType: dbSchema.priceObservation.priceType,
      normValueLow: dbSchema.priceObservation.normValueLow,
      normValueHigh: dbSchema.priceObservation.normValueHigh,
      conversionApplied: dbSchema.priceObservation.conversionApplied,
      validationStatus: dbSchema.priceObservation.validationStatus,
    })
    .from(dbSchema.priceObservation)
    .leftJoin(dbSchema.category, eq(dbSchema.priceObservation.categoryId, dbSchema.category.id))
    .leftJoin(dbSchema.specGrade, eq(dbSchema.priceObservation.specId, dbSchema.specGrade.id))
    .leftJoin(dbSchema.region, eq(dbSchema.priceObservation.regionId, dbSchema.region.id))
    .where(eq(dbSchema.priceObservation.fetchId, fetchId))
    .orderBy(asc(dbSchema.priceObservation.sourceRowIndex));

  const observationIds = observationRows.map((observation) => observation.id);
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
  for (const validation of validations) {
    const list = trailByObservation.get(validation.observationId) ?? [];
    list.push(validation);
    trailByObservation.set(validation.observationId, list);
  }

  return {
    fetch: {
      id: row.id,
      url: row.url,
      fetchedAt: timestampToIso(row.fetchedAt) ?? '',
      httpStatus: row.httpStatus,
      contentType: row.contentType,
      contentSizeBytes: row.contentSizeBytes,
      pagePublishedAt: timestampToIso(row.pagePublishedAt),
      contentSha256: row.contentSha256,
      contentRef: row.contentRef,
      fetchMeta: row.fetchMeta,
    },
    source: {
      code: row.sourceCode,
      name: row.sourceName,
      type: row.sourceType,
      baseUrl: row.baseUrl,
      tosUrl: row.tosUrl,
      robotsStatus: row.robotsStatus,
      robotsNote: row.robotsNote,
      trustWeight: numericToNumber(row.trustWeight) ?? 0,
      trustNote: row.trustNote,
    },
    archive: {
      body,
      bytes,
      sha256Matches: buffer ? sha256Hex(buffer) === row.contentSha256 : false,
      truncated,
      storeRoot,
    },
    observations: observationRows.map((observation) => ({
      id: observation.id,
      sourceRowIndex: observation.sourceRowIndex,
      revision: observation.revision,
      rawText: observation.rawText,
      rawValueLow: numericToNumber(observation.rawValueLow),
      rawValueHigh: numericToNumber(observation.rawValueHigh),
      rawUnit: observation.rawUnit,
      rawCategoryText: observation.rawCategoryText,
      rawSpecText: observation.rawSpecText,
      rawRegionText: observation.rawRegionText,
      rawPriceTypeText: observation.rawPriceTypeText,
      categoryName: observation.categoryName,
      specName: observation.specName,
      regionName: observation.regionName,
      priceType: observation.priceType,
      normValueLow: numericToNumber(observation.normValueLow),
      normValueHigh: numericToNumber(observation.normValueHigh),
      conversionApplied: observation.conversionApplied,
      validationStatus: observation.validationStatus,
      validationTrail: (trailByObservation.get(observation.id) ?? []).map((validation) => ({
        checkKind: validation.checkKind,
        verdict: validation.verdict,
        performedByRef: validation.performedByRef,
        detail: validation.detail,
        at: timestampToIso(validation.at) ?? '',
      })),
    })),
  };
}
