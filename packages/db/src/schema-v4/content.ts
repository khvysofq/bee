import { desc, sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { category, region } from './catalog';
import { source } from './ops';

/**
 * 文档：四种 kind 共表。
 *
 *  - news_item   单条新闻原料，内部可见，按 source + url_hash 去重
 *  - news_digest 每日品类新闻聚合报告，日更
 *  - analysis    每日行业趋势分析，日更
 *  - forecast    预测未来价格趋势，周更/低频，period_* 指向未来区间
 *
 * 注意：digest / analysis / forecast 的三个 NULLS NOT DISTINCT 部分唯一索引
 * 由 baseline 迁移手工补写（drizzle-orm 的 uniqueIndex 暂不支持该选项）。
 */
export const content = pgTable(
  'content',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    regionId: uuid('region_id').references(() => region.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    /** OSS 对象键；正文不在库里。 */
    bodyMdKey: text('body_md_key'),
    bodySha256: char('body_sha256', { length: 64 }),
    assets: jsonb('assets').notNull().default(sql`'[]'::jsonb`),
    meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
    contentDate: date('content_date', { mode: 'string' }).notNull(),
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }),
    sourceId: uuid('source_id').references(() => source.id),
    url: text('url'),
    urlHash: char('url_hash', { length: 64 }),
    license: text('license').notNull().default('internal_only'),
    visibility: text('visibility').notNull().default('internal'),
    status: text('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** 生成它的 job_run；不设 FK，运行记录可独立归档。 */
    runId: uuid('run_id'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'content_kind_chk',
      sql`${t.kind} IN ('news_item', 'news_digest', 'analysis', 'forecast')`,
    ),
    check(
      'content_license_chk',
      sql`${t.license} IN ('none', 'internal_only', 'attribution', 'licensed')`,
    ),
    check('content_visibility_chk', sql`${t.visibility} IN ('internal', 'public')`),
    check('content_status_chk', sql`${t.status} IN ('draft', 'published', 'hidden')`),
    check(
      'content_forecast_period_chk',
      sql`(${t.kind} <> 'forecast') OR (${t.periodStart} IS NOT NULL AND ${t.periodEnd} IS NOT NULL AND ${t.periodEnd} >= ${t.periodStart})`,
    ),
    uniqueIndex('content_news_item_url_uq')
      .on(t.sourceId, t.urlHash)
      .where(sql`${t.kind} = 'news_item' AND ${t.urlHash} IS NOT NULL`),
    uniqueIndex('content_news_digest_uq')
      .on(t.categoryId, t.regionId, t.contentDate)
      .where(sql`${t.kind} = 'news_digest'`),
    uniqueIndex('content_analysis_uq')
      .on(t.categoryId, t.regionId, t.contentDate)
      .where(sql`${t.kind} = 'analysis'`),
    uniqueIndex('content_forecast_uq')
      .on(t.categoryId, t.regionId, t.contentDate, t.periodStart, t.periodEnd)
      .where(sql`${t.kind} = 'forecast'`),
    index('content_kind_category_date_idx').on(t.kind, t.categoryId, desc(t.contentDate)),
    index('content_category_region_kind_date_idx').on(
      t.categoryId,
      t.regionId,
      t.kind,
      desc(t.contentDate),
    ),
    index('content_status_published_idx').on(t.status, desc(t.publishedAt)),
  ],
);