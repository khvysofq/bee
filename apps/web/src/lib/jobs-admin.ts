import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';

/** 管理 API 的任务定义校验与 upsert。字段语义与 packages/db/src/schema/jobs.ts 一一对应。 */

export const jobDefinitionSchema = z.object({
  code: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'code 只允许小写字母、数字、点、下划线、连字符'),
  type: z.enum(['fetch_table', 'fetch_article', 'render_page', 'extract_news', 'analyze', 'healthcheck']),
  tier: z.enum(['deterministic', 'render', 'agent']).default('deterministic'),
  target: z.object({
    url: z.string().min(1),
    urls: z.array(z.string().min(1)).optional(),
    method: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    rps: z.number().positive().optional(),
  }),
  goal: z.string().min(1),
  adapter: z.string().nullable().optional(),
  output_schema: z.unknown().optional(),
  mapping: z
    .object({
      table: z.string().min(1),
      data_class: z.string().optional(),
      keys: z.record(z.string(), z.string()).optional(),
    })
    .default({ table: 'price_observation' }),
  // 两种排期形态（ADR-0010 补充）：
  //  - cron：固定时刻；
  //  - random_window：每天在窗口里按 (code, 日期) 哈希挑一个整分钟，避免固定时刻被识别成爬虫。
  schedule: z.union([
    z.object({
      mode: z.literal('random_window').optional(),
      cron: z.string().min(1),
      tz: z.string().default('Asia/Shanghai'),
      enabled: z.boolean().default(true),
    }),
    z.object({
      mode: z.literal('random_window'),
      windowStart: z.string().regex(/^\d{1,2}:\d{2}$/),
      windowEnd: z.string().regex(/^\d{1,2}:\d{2}$/),
      tz: z.string().default('Asia/Shanghai'),
      enabled: z.boolean().default(true),
    }),
  ]),
  limits: z
    .object({
      timeout_s: z.number().int().positive().default(120),
      max_attempts: z.number().int().min(1).default(1),
      backoff_s: z.array(z.number().int().min(0)).default([]),
    })
    .default({ timeout_s: 120, max_attempts: 1, backoff_s: [] }),
  agent: z.unknown().optional(),
  policy: z
    .object({ source_code: z.string().min(1), redistribution: z.string().optional() })
    .nullable()
    .optional(),
  priority: z.number().int().min(1).max(9).default(5),
  enabled: z.boolean().default(true),
  notes: z.string().max(2000).nullable().optional(),
});

export type JobDefinitionInput = z.infer<typeof jobDefinitionSchema>;

export async function registerJob(db: BeeDb, job: JobDefinitionInput): Promise<typeof dbSchema.jobDef.$inferSelect> {
  const enabled = job.enabled;
  const schedule = { ...job.schedule, enabled: job.schedule.enabled && enabled };
  const values = {
    code: job.code,
    type: job.type,
    tier: job.tier,
    target: job.target,
    goal: job.goal,
    adapter: job.adapter ?? null,
    outputSchema: job.output_schema ?? null,
    mapping: job.mapping,
    schedule,
    limits: job.limits,
    agent: job.agent ?? null,
    policy: job.policy ?? null,
    priority: job.priority,
    enabled,
    notes: job.notes ?? null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(dbSchema.jobDef)
    .values(values)
    .onConflictDoUpdate({ target: dbSchema.jobDef.code, set: values })
    .returning();
  return row!;
}

export async function toggleJob(db: BeeDb, code: string, enabled: boolean): Promise<typeof dbSchema.jobDef.$inferSelect | null> {
  const [existing] = await db.select().from(dbSchema.jobDef).where(eq(dbSchema.jobDef.code, code)).limit(1);
  if (!existing) return null;
  const schedule = { ...(existing.schedule as Record<string, unknown>), enabled };
  const [row] = await db
    .update(dbSchema.jobDef)
    .set({ enabled, schedule, updatedAt: new Date() })
    .where(eq(dbSchema.jobDef.code, code))
    .returning();
  return row ?? null;
}

export function exampleJobDefinition(): Record<string, unknown> {
  return {
    code: 'example.table.daily',
    type: 'fetch_table',
    tier: 'deterministic',
    target: { url: 'fixture://fengj-copper.html', method: 'GET', rps: 0.5 },
    goal: '抓取表格中的品类/城市/价格/单位/日期',
    adapter: 'fengj-copper-v1',
    mapping: {
      table: 'price_observation',
      data_class: 'spot_quote',
      keys: { observed_at: 'date', region: 'city', value: 'price' },
    },
    schedule: { cron: '20 7 * * *', tz: 'Asia/Shanghai', enabled: true },
    limits: { timeout_s: 120, max_attempts: 3, backoff_s: [60, 300, 900] },
    policy: { source_code: 'demo-fixture', redistribution: 'licensed' },
    priority: 5,
    enabled: true,
  };
}