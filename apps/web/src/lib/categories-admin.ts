import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { v4, type BeeDb } from '@bee/db';
import { AdminInputError, writeAudit, isoOrNull } from './admin-audit';

/** 品类管理（v4）：category 为唯一主轴，code 创建后不可修改。 */

export const CATEGORY_STATUSES = ['draft', 'active', 'archived'] as const;

export const categoryInputSchema = z.object({
  id: z.string().uuid().optional(),
  code: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[0-9a-z][0-9a-z-]*$/, 'code 只允许小写字母、数字、连字符，且以字母或数字开头'),
  nameCn: z.string().trim().min(1, '中文名称不能为空').max(120),
  nameEn: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(CATEGORY_STATUSES).default('active'),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  /** 省略时：新建落默认 {}，更新保持原值。 */
  config: z.record(z.string(), z.unknown()).optional(),
});

export type CategoryInput = z.infer<typeof categoryInputSchema>;

export interface CategoryAdminRow {
  id: string;
  code: string;
  nameCn: string;
  nameEn: string | null;
  description: string | null;
  status: string;
  sortOrder: number;
  config: Record<string, unknown>;
  specCount: number;
  priceCount: number;
  contentCount: number;
  updatedAt: string;
}

export interface CategorySavedRow {
  id: string;
  code: string;
  nameCn: string;
  nameEn: string | null;
  description: string | null;
  status: string;
  sortOrder: number;
  config: unknown;
  updatedAt: string;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function snapshot(row: typeof v4.category.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    nameCn: row.nameCn,
    nameEn: row.nameEn,
    description: row.description,
    status: row.status,
    sortOrder: row.sortOrder,
    config: asConfig(row.config),
    updatedAt: isoOrNull(row.updatedAt),
  };
}

function toSaved(row: typeof v4.category.$inferSelect): CategorySavedRow {
  return {
    id: row.id,
    code: row.code,
    nameCn: row.nameCn,
    nameEn: row.nameEn,
    description: row.description,
    status: row.status,
    sortOrder: row.sortOrder,
    config: row.config,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 品类列表 + 规格 / 价格 / 内容行数。 */
export async function listCategories(db: BeeDb): Promise<CategoryAdminRow[]> {
  const [categories, specCounts, priceCounts, contentCounts] = await Promise.all([
    db.select().from(v4.category).orderBy(asc(v4.category.sortOrder), asc(v4.category.code)),
    db
      .select({ categoryId: v4.spec.categoryId, count: sql<number>`count(*)::int` })
      .from(v4.spec)
      .groupBy(v4.spec.categoryId),
    db
      .select({ categoryId: v4.priceDaily.categoryId, count: sql<number>`count(*)::int` })
      .from(v4.priceDaily)
      .groupBy(v4.priceDaily.categoryId),
    db
      .select({ categoryId: v4.content.categoryId, count: sql<number>`count(*)::int` })
      .from(v4.content)
      .groupBy(v4.content.categoryId),
  ]);

  const specMap = new Map(specCounts.map((row) => [row.categoryId, row.count]));
  const priceMap = new Map(priceCounts.map((row) => [row.categoryId, row.count]));
  const contentMap = new Map(contentCounts.map((row) => [row.categoryId, row.count]));

  return categories.map((row) => ({
    id: row.id,
    code: row.code,
    nameCn: row.nameCn,
    nameEn: row.nameEn,
    description: row.description,
    status: row.status,
    sortOrder: row.sortOrder,
    config: asConfig(row.config),
    specCount: specMap.get(row.id) ?? 0,
    priceCount: priceMap.get(row.id) ?? 0,
    contentCount: contentMap.get(row.id) ?? 0,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * 新建 / 更新品类。带 id 即更新；更新时 code 不可改。
 * 业务写入与 admin_audit 在同一事务内完成。
 */
export async function upsertCategory(db: BeeDb, input: CategoryInput): Promise<CategorySavedRow> {
  const values = {
    code: input.code,
    nameCn: input.nameCn,
    nameEn: emptyToNull(input.nameEn),
    description: emptyToNull(input.description),
    status: input.status,
    sortOrder: input.sortOrder,
    updatedAt: new Date(),
  };

  return db.transaction(async (tx) => {
    if (input.id) {
      const [existing] = await tx
        .select()
        .from(v4.category)
        .where(eq(v4.category.id, input.id))
        .limit(1);
      if (!existing) throw new AdminInputError('not_found', `品类不存在：${input.id}`, 404);
      if (existing.code !== input.code) {
        throw new AdminInputError('code_immutable', '品类 code 创建后不可修改', 422);
      }

      const [row] = await tx
        .update(v4.category)
        .set(input.config === undefined ? values : { ...values, config: input.config })
        .where(eq(v4.category.id, input.id))
        .returning();
      if (!row) throw new AdminInputError('not_found', `品类不存在：${input.id}`, 404);

      await writeAudit(tx, {
        action: 'category.update',
        subjectType: 'category',
        subjectId: row.id,
        before: snapshot(existing),
        after: snapshot(row),
      });
      return toSaved(row);
    }

    const [duplicate] = await tx
      .select({ id: v4.category.id })
      .from(v4.category)
      .where(eq(v4.category.code, input.code))
      .limit(1);
    if (duplicate) {
      throw new AdminInputError('duplicate_code', `品类 code 已存在：${input.code}`, 422);
    }

    const [row] = await tx
      .insert(v4.category)
      .values({ ...values, config: input.config ?? {} })
      .returning();
    if (!row) throw new AdminInputError('create_failed', '品类创建失败', 500);

    await writeAudit(tx, {
      action: 'category.create',
      subjectType: 'category',
      subjectId: row.id,
      before: null,
      after: snapshot(row),
    });
    return toSaved(row);
  });
}