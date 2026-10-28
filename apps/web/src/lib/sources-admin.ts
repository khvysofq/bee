import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { v4, type BeeDb } from '@bee/db';
import { AdminInputError, writeAudit, isoOrNull } from './admin-audit';

/** 来源管理（v4）：采集/转载口径与限速配置，code 创建后不可修改。 */

export const SOURCE_TYPES = ['price', 'news', 'analysis', 'mixed'] as const;
export const ROBOTS_STATUSES = ['allowed', 'disallowed', 'unknown'] as const;
export const REDISTRIBUTIONS = ['none', 'internal_only', 'attribution', 'licensed'] as const;

export const sourceInputSchema = z.object({
  id: z.string().uuid().optional(),
  code: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'code 只允许小写字母、数字、点、下划线、连字符'),
  name: z.string().trim().min(1, '名称不能为空').max(200),
  type: z.enum(SOURCE_TYPES),
  baseUrl: z.string().trim().max(500).nullable().optional(),
  robotsStatus: z.enum(ROBOTS_STATUSES).default('unknown'),
  redistribution: z.enum(REDISTRIBUTIONS).default('none'),
  rateLimitSeconds: z.number().int().min(1).max(86400).default(60),
  enabled: z.boolean().default(true),
});

export type SourceInput = z.infer<typeof sourceInputSchema>;

export interface SourceAdminRow {
  id: string;
  code: string;
  name: string;
  type: string;
  baseUrl: string | null;
  robotsStatus: string;
  redistribution: string;
  rateLimitSeconds: number;
  enabled: boolean;
  jobCount: number;
  updatedAt: string;
}

export interface SourceSavedRow {
  id: string;
  code: string;
  name: string;
  type: string;
  baseUrl: string | null;
  robotsStatus: string;
  redistribution: string;
  rateLimitSeconds: number;
  enabled: boolean;
  updatedAt: string;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function snapshot(row: typeof v4.source.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    baseUrl: row.baseUrl,
    robotsStatus: row.robotsStatus,
    redistribution: row.redistribution,
    rateLimitSeconds: row.rateLimitSeconds,
    enabled: row.enabled,
    updatedAt: isoOrNull(row.updatedAt),
  };
}

function toSaved(row: typeof v4.source.$inferSelect): SourceSavedRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    baseUrl: row.baseUrl,
    robotsStatus: row.robotsStatus,
    redistribution: row.redistribution,
    rateLimitSeconds: row.rateLimitSeconds,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 来源列表 + 关联任务数。 */
export async function listSources(db: BeeDb): Promise<SourceAdminRow[]> {
  const [sources, jobCounts] = await Promise.all([
    db.select().from(v4.source).orderBy(asc(v4.source.code)),
    db
      .select({ sourceId: v4.job.sourceId, count: sql<number>`count(*)::int` })
      .from(v4.job)
      .groupBy(v4.job.sourceId),
  ]);

  const jobMap = new Map(
    jobCounts
      .filter((row): row is { sourceId: string; count: number } => row.sourceId !== null)
      .map((row) => [row.sourceId, row.count]),
  );

  return sources.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    baseUrl: row.baseUrl,
    robotsStatus: row.robotsStatus,
    redistribution: row.redistribution,
    rateLimitSeconds: row.rateLimitSeconds,
    enabled: row.enabled,
    jobCount: jobMap.get(row.id) ?? 0,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * 新建 / 更新来源。带 id 即更新；更新时 code 不可改。
 * 业务写入与 admin_audit 在同一事务内完成。
 */
export async function upsertSource(db: BeeDb, input: SourceInput): Promise<SourceSavedRow> {
  const values = {
    code: input.code,
    name: input.name,
    type: input.type,
    baseUrl: emptyToNull(input.baseUrl),
    robotsStatus: input.robotsStatus,
    redistribution: input.redistribution,
    rateLimitSeconds: input.rateLimitSeconds,
    enabled: input.enabled,
    updatedAt: new Date(),
  };

  return db.transaction(async (tx) => {
    if (input.id) {
      const [existing] = await tx
        .select()
        .from(v4.source)
        .where(eq(v4.source.id, input.id))
        .limit(1);
      if (!existing) throw new AdminInputError('not_found', `来源不存在：${input.id}`, 404);
      if (existing.code !== input.code) {
        throw new AdminInputError('code_immutable', '来源 code 创建后不可修改', 422);
      }

      const [row] = await tx
        .update(v4.source)
        .set(values)
        .where(eq(v4.source.id, input.id))
        .returning();
      if (!row) throw new AdminInputError('not_found', `来源不存在：${input.id}`, 404);

      await writeAudit(tx, {
        action: 'source.update',
        subjectType: 'source',
        subjectId: row.id,
        before: snapshot(existing),
        after: snapshot(row),
      });
      return toSaved(row);
    }

    const [duplicate] = await tx
      .select({ id: v4.source.id })
      .from(v4.source)
      .where(eq(v4.source.code, input.code))
      .limit(1);
    if (duplicate) {
      throw new AdminInputError('duplicate_code', `来源 code 已存在：${input.code}`, 422);
    }

    const [row] = await tx.insert(v4.source).values(values).returning();
    if (!row) throw new AdminInputError('create_failed', '来源创建失败', 500);

    await writeAudit(tx, {
      action: 'source.create',
      subjectType: 'source',
      subjectId: row.id,
      before: null,
      after: snapshot(row),
    });
    return toSaved(row);
  });
}