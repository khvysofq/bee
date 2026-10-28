import { and, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { v4, type BeeDb } from '@bee/db';
import { AdminInputError, writeAudit, isoOrNull } from './admin-audit';

/**
 * 内容审核（v4）：四种 kind 共表。
 * news_item 是内部原料，visibility 恒为 internal，只能改 status。
 */

export const CONTENT_KINDS = ['news_item', 'news_digest', 'analysis', 'forecast'] as const;
export const CONTENT_STATUSES = ['draft', 'published', 'hidden'] as const;
export const CONTENT_ACTION_STATUSES = ['published', 'hidden'] as const;

export const contentStatusSchema = z.object({
  status: z.enum(CONTENT_ACTION_STATUSES),
});

export interface ContentAdminRow {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  categoryCode: string;
  categoryName: string;
  regionName: string | null;
  sourceName: string | null;
  contentDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  visibility: string;
  status: string;
  bodyMdKey: string | null;
  url: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface ContentFilters {
  kind?: string;
  status?: string;
  limit?: number;
}

function snapshot(row: typeof v4.content.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    visibility: row.visibility,
    status: row.status,
    bodyMdKey: row.bodyMdKey,
    publishedAt: isoOrNull(row.publishedAt),
    updatedAt: isoOrNull(row.updatedAt),
  };
}

/** 按 content_date desc、created_at desc 列出内容，带品类/地域/来源名称。 */
export async function listContents(db: BeeDb, filters: ContentFilters = {}): Promise<ContentAdminRow[]> {
  const conditions: SQL[] = [];
  if (filters.kind) conditions.push(eq(v4.content.kind, filters.kind));
  if (filters.status) conditions.push(eq(v4.content.status, filters.status));

  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const query = db
    .select({
      id: v4.content.id,
      kind: v4.content.kind,
      title: v4.content.title,
      summary: v4.content.summary,
      categoryCode: v4.category.code,
      categoryName: v4.category.nameCn,
      regionName: v4.region.name,
      sourceName: v4.source.name,
      contentDate: v4.content.contentDate,
      periodStart: v4.content.periodStart,
      periodEnd: v4.content.periodEnd,
      visibility: v4.content.visibility,
      status: v4.content.status,
      bodyMdKey: v4.content.bodyMdKey,
      url: v4.content.url,
      publishedAt: v4.content.publishedAt,
      updatedAt: v4.content.updatedAt,
    })
    .from(v4.content)
    .innerJoin(v4.category, eq(v4.category.id, v4.content.categoryId))
    .leftJoin(v4.region, eq(v4.region.id, v4.content.regionId))
    .leftJoin(v4.source, eq(v4.source.id, v4.content.sourceId));

  const rows = await (conditions.length > 0 ? query.where(and(...conditions)) : query)
    .orderBy(desc(v4.content.contentDate), desc(v4.content.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    publishedAt: isoOrNull(row.publishedAt),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * 发布 / 隐藏内容。
 *  - 只接受 published | hidden；
 *  - visibility=public 的内容必须有 body_md_key 才能发布；
 *  - news_item 永远是 internal。
 */
export async function setContentStatus(
  db: BeeDb,
  id: string,
  status: (typeof CONTENT_ACTION_STATUSES)[number],
): Promise<ContentAdminRow | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(v4.content).where(eq(v4.content.id, id)).limit(1);
    if (!existing) throw new AdminInputError('not_found', `内容不存在：${id}`, 404);

    if (status === 'published' && existing.visibility === 'public' && !existing.bodyMdKey?.trim()) {
      throw new AdminInputError('missing_body', '公开内容缺少正文对象键（body_md_key），不能发布', 422);
    }

    const [row] = await tx
      .update(v4.content)
      .set({
        status,
        visibility: existing.kind === 'news_item' ? 'internal' : existing.visibility,
        publishedAt: status === 'published' ? new Date() : existing.publishedAt,
        updatedAt: new Date(),
      })
      .where(eq(v4.content.id, id))
      .returning();
    if (!row) throw new AdminInputError('not_found', `内容不存在：${id}`, 404);

    await writeAudit(tx, {
      action: status === 'published' ? 'content.publish' : 'content.hide',
      subjectType: 'content',
      subjectId: row.id,
      before: snapshot(existing),
      after: snapshot(row),
    });

    // 审核页需要品类/地域/来源名称；更新后重新组装同一行视图。
    const [view] = await tx
      .select({
        categoryCode: v4.category.code,
        categoryName: v4.category.nameCn,
        regionName: v4.region.name,
        sourceName: v4.source.name,
      })
      .from(v4.content)
      .innerJoin(v4.category, eq(v4.category.id, v4.content.categoryId))
      .leftJoin(v4.region, eq(v4.region.id, v4.content.regionId))
      .leftJoin(v4.source, eq(v4.source.id, v4.content.sourceId))
      .where(eq(v4.content.id, row.id))
      .limit(1);

    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      categoryCode: view?.categoryCode ?? '',
      categoryName: view?.categoryName ?? '',
      regionName: view?.regionName ?? null,
      sourceName: view?.sourceName ?? null,
      contentDate: row.contentDate,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      visibility: row.visibility,
      status: row.status,
      bodyMdKey: row.bodyMdKey,
      url: row.url,
      publishedAt: isoOrNull(row.publishedAt),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}