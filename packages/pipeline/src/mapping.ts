import { and, eq, isNull } from 'drizzle-orm';
import { dbSchema } from '@bee/db';
import type { BeeDbOrTx } from './ledger';
import type { PriceType } from './types';
import { sha256Hex } from './store';

const PRICE_TYPE_MAP: Record<string, PriceType> = {
  采购价: 'purchase',
  收购价: 'purchase',
  回收价: 'purchase',
  销售价: 'sale',
  出货价: 'sale',
  出厂价: 'ex_works',
  到厂价: 'ex_works',
  挂牌价: 'indicative',
  参考价: 'indicative',
  本期价格: 'indicative',
};

export const UNIT_TEXT_TO_CODE: Record<string, string> = {
  '元/吨': 'CNY_per_ton',
  吨: 'CNY_per_ton',
  '元/公斤': 'CNY_per_kg',
  '元/千克': 'CNY_per_kg',
  千克: 'CNY_per_kg',
  '元/斤': 'CNY_per_jin',
  '万元/吨': 'CNY_wan_per_ton',
};

export function resolvePriceType(raw: string | null): PriceType | null {
  if (!raw) return null;
  return PRICE_TYPE_MAP[raw.trim()] ?? null;
}

export function resolveUnitCode(raw: string | null): string | null {
  if (!raw) return null;
  return UNIT_TEXT_TO_CODE[raw.trim()] ?? null;
}

export interface TermResolution {
  categoryId: string;
  specId: string | null;
}

/**
 * 品名映射查询契约（docs/data-model.md §3）：source 专属 active 行优先于 global active 行。
 * 只认 status=active；proposed/draft 不得参与规范化（机器只能提议，人确认后才生效）。
 */
export async function resolveTermMapping(
  db: BeeDbOrTx,
  args: { sourceId: string; rawCategoryText: string; rawSpecText: string | null },
): Promise<TermResolution | null> {
  const specClause = args.rawSpecText === null
    ? isNull(dbSchema.termMapping.rawSpecText)
    : eq(dbSchema.termMapping.rawSpecText, args.rawSpecText);
  const base = [
    eq(dbSchema.termMapping.status, 'active'),
    eq(dbSchema.termMapping.rawCategoryText, args.rawCategoryText),
    specClause,
  ];

  const [sourceSpecific] = await db
    .select({ categoryId: dbSchema.termMapping.categoryId, specId: dbSchema.termMapping.specId })
    .from(dbSchema.termMapping)
    .where(and(...base, eq(dbSchema.termMapping.scope, 'source'), eq(dbSchema.termMapping.sourceId, args.sourceId)))
    .limit(1);
  if (sourceSpecific) return sourceSpecific;

  const [globalRow] = await db
    .select({ categoryId: dbSchema.termMapping.categoryId, specId: dbSchema.termMapping.specId })
    .from(dbSchema.termMapping)
    .where(and(...base, eq(dbSchema.termMapping.scope, 'global')))
    .limit(1);
  return globalRow ?? null;
}

export async function resolveRegionMapping(
  db: BeeDbOrTx,
  args: { sourceId: string; rawRegionText: string },
): Promise<{ regionId: string } | null> {
  const base = [
    eq(dbSchema.regionMapping.status, 'active'),
    eq(dbSchema.regionMapping.rawRegionText, args.rawRegionText),
  ];
  const [sourceSpecific] = await db
    .select({ regionId: dbSchema.regionMapping.regionId })
    .from(dbSchema.regionMapping)
    .where(and(...base, eq(dbSchema.regionMapping.scope, 'source'), eq(dbSchema.regionMapping.sourceId, args.sourceId)))
    .limit(1);
  if (sourceSpecific) return sourceSpecific;

  const [globalRow] = await db
    .select({ regionId: dbSchema.regionMapping.regionId })
    .from(dbSchema.regionMapping)
    .where(and(...base, eq(dbSchema.regionMapping.scope, 'global')))
    .limit(1);
  return globalRow ?? null;
}

export async function getCanonicalUnitId(db: BeeDbOrTx): Promise<string> {
  const [unit] = await db
    .select({ id: dbSchema.unit.id })
    .from(dbSchema.unit)
    .where(eq(dbSchema.unit.isCanonical, 1))
    .limit(1);
  if (!unit) throw new Error('字典缺少 canonical 计价单位（元/吨），拒绝规范化');
  return unit.id;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 当次运行生效字典内容的 sha256。只纳入会影响口径判断的字段，不含 updated_at 等审计字段；
 * 回放时用它判断「字典环境是否还是同一个」。
 */
export async function computeDictionaryHash(db: BeeDbOrTx): Promise<string> {
  const categories = await db
    .select({ id: dbSchema.category.id, code: dbSchema.category.code, nameCn: dbSchema.category.nameCn })
    .from(dbSchema.category)
    .where(eq(dbSchema.category.status, 'active'));
  const specs = await db
    .select({
      id: dbSchema.specGrade.id,
      categoryId: dbSchema.specGrade.categoryId,
      code: dbSchema.specGrade.code,
      nameCn: dbSchema.specGrade.nameCn,
      definition: dbSchema.specGrade.definition,
      qualityTier: dbSchema.specGrade.qualityTier,
    })
    .from(dbSchema.specGrade)
    .where(eq(dbSchema.specGrade.status, 'active'));
  const regions = await db
    .select({ id: dbSchema.region.id, code: dbSchema.region.code, nameCn: dbSchema.region.nameCn, level: dbSchema.region.level, parentId: dbSchema.region.parentId })
    .from(dbSchema.region)
    .where(eq(dbSchema.region.status, 'active'));
  const units = await db
    .select({ id: dbSchema.unit.id, code: dbSchema.unit.code, nameCn: dbSchema.unit.nameCn, isCanonical: dbSchema.unit.isCanonical })
    .from(dbSchema.unit);
  const conversions = await db
    .select({ fromUnitId: dbSchema.unitConversion.fromUnitId, toUnitId: dbSchema.unitConversion.toUnitId, factor: dbSchema.unitConversion.factor })
    .from(dbSchema.unitConversion);
  const terms = await db
    .select({
      id: dbSchema.termMapping.id,
      scope: dbSchema.termMapping.scope,
      sourceId: dbSchema.termMapping.sourceId,
      rawCategoryText: dbSchema.termMapping.rawCategoryText,
      rawSpecText: dbSchema.termMapping.rawSpecText,
      categoryId: dbSchema.termMapping.categoryId,
      specId: dbSchema.termMapping.specId,
    })
    .from(dbSchema.termMapping)
    .where(eq(dbSchema.termMapping.status, 'active'));
  const regionMappings = await db
    .select({ id: dbSchema.regionMapping.id, scope: dbSchema.regionMapping.scope, sourceId: dbSchema.regionMapping.sourceId, rawRegionText: dbSchema.regionMapping.rawRegionText, regionId: dbSchema.regionMapping.regionId })
    .from(dbSchema.regionMapping)
    .where(eq(dbSchema.regionMapping.status, 'active'));
  const impurity = await db
    .select({ id: dbSchema.impurityRule.id, categoryId: dbSchema.impurityRule.categoryId, specId: dbSchema.impurityRule.specId, ruleKind: dbSchema.impurityRule.ruleKind, paramJson: dbSchema.impurityRule.paramJson, version: dbSchema.impurityRule.version })
    .from(dbSchema.impurityRule)
    .where(eq(dbSchema.impurityRule.status, 'active'));

  const byId = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  const payload = {
    categories: byId(categories),
    specs: byId(specs),
    regions: byId(regions),
    units: byId(units),
    conversions: conversions.sort((a, b) => `${a.fromUnitId}:${a.toUnitId}`.localeCompare(`${b.fromUnitId}:${b.toUnitId}`)),
    terms: byId(terms),
    regionMappings: byId(regionMappings),
    impurityRules: byId(impurity),
  };
  return sha256Hex(stableStringify(payload));
}
