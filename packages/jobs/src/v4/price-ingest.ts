import { v4, type BeeV4Db } from '@bee/db';
import type { FengjCopperRow } from '../adapters';

/**
 * v4 价格落库：适配器行 → v4.price_daily。
 *
 * 只做字典映射与逐行 upsert，不聚合、不补点。
 * 唯一键 (category_id, spec_id, region_id, price_date, price_type) 由迁移里的
 * NULLS NOT DISTINCT 唯一约束保证：spec_id 为 NULL 时同一品类/地域/日期/价类型
 * 仍然只有一行，drizzle 的 onConflictDoUpdate 直接按列推断该约束。
 */

export interface PriceJobConfig {
  adapter?: string;
  target?: { url?: string; method?: string; headers?: Record<string, string> };
  category_code?: string;
  price_type?: string;
  unit?: string;
  currency?: string;
  limits?: { timeout_s?: number };
}

export interface PriceRunStats {
  fetched: number;
  parsed: number;
  upserted: number;
  skipped: number;
  reasons: Record<string, number>;
}

export interface PriceIngestContext {
  category: typeof v4.category.$inferSelect;
  specs: (typeof v4.spec.$inferSelect)[];
  regions: (typeof v4.region.$inferSelect)[];
  sourceId: string | null;
  rawUrl: string;
  now: Date;
  config: PriceJobConfig;
}

export interface PriceIngestResult {
  stats: PriceRunStats;
}

const PRICE_TYPE_BY_TEXT: Record<string, string> = {
  参考价: 'indicative',
  采购价: 'purchase',
  销售价: 'sale',
  出厂价: 'ex_works',
};

function bump(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function textMatches(name: string, aliases: readonly string[], raw: string): boolean {
  return raw === name || aliases.includes(raw);
}

/**
 * 地域查找：先按城市/市场匹配 rawRegionText，再按省级匹配 rawRegionText
 * （天津这类「省=市」的行会直接命中省行），最后用 rawProvinceText 找省。
 */
function findRegion(
  regions: (typeof v4.region.$inferSelect)[],
  rawRegionText: string,
  rawProvinceText: string | null,
): typeof v4.region.$inferSelect | undefined {
  const cityLevels = new Set(['city', 'market']);
  const byCity = regions.find(
    (r) => cityLevels.has(r.level) && textMatches(r.name, r.aliases, rawRegionText),
  );
  if (byCity) return byCity;

  const byAny = regions.find((r) => textMatches(r.name, r.aliases, rawRegionText));
  if (byAny) return byAny;

  const provinceText = normalized(rawProvinceText);
  if (!provinceText) return undefined;
  return regions.find(
    (r) => r.level === 'province' && textMatches(r.name, r.aliases, provinceText),
  );
}

/** 把适配器的一行映射成 price_daily 插入值；返回 null 表示该行应被跳过。 */
export function mapPriceRow(
  row: FengjCopperRow,
  ctx: PriceIngestContext,
  reasons: Record<string, number>,
): { values: typeof v4.priceDaily.$inferInsert } | { skip: string } {
  const categoryConfig = (ctx.category.config ?? {}) as { aliases?: unknown };
  const categoryAliases = Array.isArray(categoryConfig.aliases)
    ? (categoryConfig.aliases as string[])
    : [];
  const rawCategoryText = normalized(row.rawCategoryText);
  if (!textMatches(ctx.category.nameCn, categoryAliases, rawCategoryText)) {
    return { skip: 'category_text_mismatch' };
  }

  const rawRegionText = normalized(row.rawRegionText);
  const region = findRegion(ctx.regions, rawRegionText, row.rawProvinceText);
  if (!region) return { skip: 'missing_region' };

  const rawSpecText = normalized(row.rawSpecText);
  const spec = rawSpecText
    ? ctx.specs.find((s) => textMatches(s.name, s.aliases, rawSpecText))
    : undefined;
  if (rawSpecText && !spec) bump(reasons, 'missing_spec');

  const mappedType = PRICE_TYPE_BY_TEXT[normalized(row.rawPriceTypeText)];
  const priceType = mappedType ?? ctx.config.price_type ?? 'market';

  const mid = (row.priceLow + row.priceHigh) / 2;
  return {
    values: {
      categoryId: ctx.category.id,
      specId: spec?.id ?? null,
      regionId: region.id,
      priceDate: row.quoteDate,
      priceType,
      valueLow: row.priceLow.toFixed(2),
      valueHigh: row.priceHigh.toFixed(2),
      valueMid: mid.toFixed(2),
      unit: ctx.config.unit ?? row.rawUnit ?? '元/吨',
      currency: ctx.config.currency ?? 'CNY',
      sourceId: ctx.sourceId,
      rawUrl: ctx.rawUrl,
      capturedAt: ctx.now,
      status: 'published',
    },
  };
}

/** 逐行 upsert；单行失败只记原因，不中断整批。 */
export async function ingestPriceRows(
  db: BeeV4Db,
  rows: FengjCopperRow[],
  ctx: PriceIngestContext,
): Promise<PriceIngestResult> {
  const stats: PriceRunStats = {
    fetched: rows.length,
    parsed: 0,
    upserted: 0,
    skipped: 0,
    reasons: {},
  };

  for (const row of rows) {
    const mapped = mapPriceRow(row, ctx, stats.reasons);
    if ('skip' in mapped) {
      stats.skipped += 1;
      bump(stats.reasons, mapped.skip);
      continue;
    }
    stats.parsed += 1;

    try {
      await db
        .insert(v4.priceDaily)
        .values(mapped.values)
        .onConflictDoUpdate({
          target: [
            v4.priceDaily.categoryId,
            v4.priceDaily.specId,
            v4.priceDaily.regionId,
            v4.priceDaily.priceDate,
            v4.priceDaily.priceType,
          ],
          set: {
            valueLow: mapped.values.valueLow,
            valueHigh: mapped.values.valueHigh,
            valueMid: mapped.values.valueMid,
            unit: mapped.values.unit,
            currency: mapped.values.currency,
            sourceId: mapped.values.sourceId,
            rawUrl: mapped.values.rawUrl,
            capturedAt: mapped.values.capturedAt,
            updatedAt: ctx.now,
          },
        });
      stats.upserted += 1;
    } catch {
      stats.skipped += 1;
      bump(stats.reasons, 'upsert_error');
    }
  }

  return { stats };
}