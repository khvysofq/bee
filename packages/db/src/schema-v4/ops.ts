import { desc, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { category } from './catalog';

/** 来源配置。redistribution 决定其内容能否对外展示。 */
export const source = pgTable(
  'source',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    baseUrl: text('base_url'),
    robotsStatus: text('robots_status').notNull().default('unknown'),
    redistribution: text('redistribution').notNull().default('none'),
    rateLimitSeconds: integer('rate_limit_seconds').notNull().default(60),
    enabled: boolean('enabled').notNull().default(true),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('source_type_chk', sql`${t.type} IN ('price', 'news', 'analysis', 'mixed')`),
    check(
      'source_robots_status_chk',
      sql`${t.robotsStatus} IN ('allowed', 'disallowed', 'unknown')`,
    ),
    check(
      'source_redistribution_chk',
      sql`${t.redistribution} IN ('none', 'internal_only', 'attribution', 'licensed')`,
    ),
    check('source_rate_limit_chk', sql`${t.rateLimitSeconds} >= 0`),
  ],
);

/** 任务定义：一个来源 × 一个品类 × 一种采集/生成动作。 */
export const job = pgTable(
  'job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    categoryId: uuid('category_id').references(() => category.id),
    sourceId: uuid('source_id').references(() => source.id),
    kind: text('kind').notNull(),
    schedule: jsonb('schedule').notNull().default(sql`'{}'::jsonb`),
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'job_kind_chk',
      sql`${t.kind} IN ('fetch_price', 'fetch_news', 'digest', 'analysis', 'forecast')`,
    ),
  ],
);

/** 运行记录：一次调度或一次手工触发。 */
export const jobRun = pgTable(
  'job_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => job.id),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(1),
    error: text('error'),
    stats: jsonb('stats').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_run_scheduled_uq')
      .on(t.jobId, t.scheduledFor)
      .where(sql`${t.scheduledFor} IS NOT NULL`),
    index('job_run_job_started_idx').on(t.jobId, desc(t.startedAt)),
    index('job_run_status_idx').on(t.status),
    check(
      'job_run_status_chk',
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'skipped')`,
    ),
    check('job_run_attempt_chk', sql`${t.attempt} >= 1`),
  ],
);

/** 管理审计：只追加。 */
export const adminAudit = pgTable('admin_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});