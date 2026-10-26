import { char, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk } from './dictionary';
import { source } from './source';
import { pipelineRun } from './pipeline';

/**
 * 归档内容对象（DAW-33 评审修复）：内容身份与抓取登记分离。
 *
 * 内容寻址存储里「同一份文件」只有一个身份（sha256 主键）；raw_fetch 是「抓取事件登记」，
 * 同一内容被两次抓取 = raw_content 一行 + raw_fetch 两行（ADR-0004 的「一个文件两行登记」）。
 * 修正/重放场景因此不再被内容唯一键挡住 —— 抓取登记天然允许重复，去重只发生在内容层。
 *
 * 不可变（WORM）：本表禁 UPDATE/DELETE/TRUNCATE（迁移守卫触发器强制）。
 */
export const rawContent = pgTable('raw_content', {
  /** 内容 sha256（hex，64 字符）—— 内容对象主键。 */
  contentSha256: char('content_sha256', { length: 64 }).primaryKey(),
  /** 内容寻址存储键 raw/YYYY/MM/DD/<sha>.bin —— 首次归档时确定，同内容只存一份文件。 */
  contentRef: text('content_ref').notNull(),
  /** 首次归档时间。 */
  firstSeenAt: createdAt(),
});

/**
 * 原始抓取登记（交付物六 · 底座）：不可变（WORM）。
 *
 * - 每次抓取一行：同一 URL 同一内容再来一次 = 新的一行登记（指向同一 raw_content）。
 *   内容唯一性由 raw_content 承担，本表不再对 content_sha256 设唯一。
 * - 内容本体落内容寻址文件存储（RAW_STORE_DIR，v1 本地文件系统，接口化，后续可换 S3 兼容对象存储）。
 * - 数据库层用触发器硬禁 UPDATE/DELETE/TRUNCATE（迁移 SQL 中定义）——「不可变存档」是硬约束，不靠自觉。
 * - 留痕最小集：精确 URL、抓取时间、HTTP 状态、内容指纹。headers 子集与重定向链在 fetch_meta。
 */
export const rawFetch = pgTable(
  'raw_fetch',
  {
    id: pk(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => source.id),
    /** 触发本次抓取的管线运行（手工/种子抓取可空）。 */
    runId: uuid('run_id').references(() => pipelineRun.id),
    /** 抓取时请求的精确 URL（含查询参数）。溯源链的终点字段。 */
    url: text('url').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    httpStatus: integer('http_status').notNull(),
    /** 内容 sha256（hex，64 字符），指向 raw_content —— 内容对象与抓取登记分离。 */
    contentSha256: char('content_sha256', { length: 64 })
      .notNull()
      .references(() => rawContent.contentSha256),
    contentType: text('content_type'),
    contentSizeBytes: integer('content_size_bytes'),
    /** 页面自标注的发布/更新时间（页面可见才填）。 */
    pagePublishedAt: timestamp('page_published_at', { withTimezone: true }),
    /** 抓取上下文：响应头子集、重定向链、使用的适配器与参数指纹。 */
    fetchMeta: jsonb('fetch_meta'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('raw_fetch_id_source_uq').on(t.id, t.sourceId),
    unique('raw_fetch_id_fetched_at_uq').on(t.id, t.fetchedAt),
    index('raw_fetch_source_time_idx').on(t.sourceId, t.fetchedAt),
    index('raw_fetch_run_idx').on(t.runId),
    index('raw_fetch_content_idx').on(t.contentSha256),
  ],
);
