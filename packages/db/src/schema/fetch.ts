import { char, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk } from './dictionary';
import { source } from './source';
import { pipelineRun } from './pipeline';

/**
 * 原始抓取存档（交付物六 · 底座）：不可变（WORM）。
 *
 * - 内容寻址：content_sha256 = 抓取内容的 sha256，同 URL 同内容天然去重，同 URL 新内容 = 新行。
 * - 内容本体落内容寻址文件存储（RAW_STORE_DIR，v1 本地文件系统，接口化，后续可换 S3 兼容对象存储），
 *   contentRef 即存储键：raw/2026/10/26/<sha256>.bin。
 * - 数据库层用触发器硬禁 UPDATE/DELETE（迁移 SQL 中定义 bee_raw_fetch_worm 等）——「不可变存档」是硬约束，不靠自觉。
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
    /** 内容 sha256（hex，64 字符），内容寻址主键。 */
    contentSha256: char('content_sha256', { length: 64 }).notNull().unique(),
    /** 内容寻址存储键 raw/YYYY/MM/DD/<sha>.bin */
    contentRef: text('content_ref').notNull(),
    contentType: text('content_type'),
    contentSizeBytes: integer('content_size_bytes'),
    /** 页面自标注的发布/更新时间（页面可见才填）。 */
    pagePublishedAt: timestamp('page_published_at', { withTimezone: true }),
    /** 抓取上下文：响应头子集、重定向链、使用的适配器与参数指纹。 */
    fetchMeta: jsonb('fetch_meta'),
    createdAt: createdAt(),
  },
  (t) => [
    index('raw_fetch_source_time_idx').on(t.sourceId, t.fetchedAt),
    index('raw_fetch_run_idx').on(t.runId),
  ],
);
