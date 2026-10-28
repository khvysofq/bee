import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { v4, type BeeDb } from '@bee/db';

/** 管理 API 的任务定义校验与 upsert（v4：job 表）。 */

export const JOB_KINDS = ['fetch_price', 'fetch_news', 'digest', 'analysis', 'forecast'] as const;

export const jobSchema = z.object({
  code: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'code 只允许小写字母、数字、点、下划线、连字符'),
  kind: z.enum(JOB_KINDS),
  categoryCode: z.string().min(1).optional(),
  sourceCode: z.string().min(1).optional(),
  /** cron / random_window 等排期参数，原样落 job.schedule。 */
  schedule: z.record(z.string(), z.unknown()).default({}),
  /** 采集口径、adapter、limits 等，原样落 job.config。 */
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

export type JobInput = z.infer<typeof jobSchema>;

async function resolveCategoryId(db: BeeDb, code: string | undefined): Promise<string | null> {
  if (!code) return null;
  const [row] = await db.select({ id: v4.category.id }).from(v4.category).where(eq(v4.category.code, code));
  if (!row) throw new Error(`品类不存在：${code}`);
  return row.id;
}

async function resolveSourceId(db: BeeDb, code: string | undefined): Promise<string | null> {
  if (!code) return null;
  const [row] = await db.select({ id: v4.source.id }).from(v4.source).where(eq(v4.source.code, code));
  if (!row) throw new Error(`来源不存在：${code}`);
  return row.id;
}

export async function registerJob(
  db: BeeDb,
  job: JobInput,
): Promise<typeof v4.job.$inferSelect> {
  const [categoryId, sourceId] = await Promise.all([
    resolveCategoryId(db, job.categoryCode),
    resolveSourceId(db, job.sourceCode),
  ]);
  const values = {
    code: job.code,
    kind: job.kind,
    categoryId,
    sourceId,
    schedule: job.schedule,
    config: job.config,
    enabled: job.enabled,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(v4.job)
    .values(values)
    .onConflictDoUpdate({ target: v4.job.code, set: values })
    .returning();
  return row!;
}

export async function toggleJob(
  db: BeeDb,
  code: string,
  enabled: boolean,
): Promise<typeof v4.job.$inferSelect | null> {
  const [existing] = await db.select().from(v4.job).where(eq(v4.job.code, code)).limit(1);
  if (!existing) return null;
  const [row] = await db
    .update(v4.job)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(v4.job.code, code))
    .returning();
  return row ?? null;
}

export function exampleJob(): Record<string, unknown> {
  return {
    code: 'example.price.daily',
    kind: 'fetch_price',
    categoryCode: '1110201',
    sourceCode: 'example-source',
    schedule: { cron: '20 7 * * *', tz: 'Asia/Shanghai', enabled: true },
    config: {
      adapter: 'example-price-v1',
      goal: '抓取表格中的品类/城市/价格/单位/日期',
      limits: { timeout_s: 120, max_attempts: 3, backoff_s: [60, 300, 900] },
    },
    enabled: true,
  };
}