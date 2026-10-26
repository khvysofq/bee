import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { robotsStatusEnum, sourceStatusEnum, sourceTypeEnum } from './_enums';
import { category, createdAt, pk, specGrade } from './dictionary';
import { region } from './region';

/**
 * 来源注册表（交付物五）。每一个被采集的公开来源都必须先在这里登记：
 * 覆盖什么品类/地域、多久抓一次、可信权重多少、ToS/robots 状态 —— 缺任何一项都不允许进入采集。
 */
export const source = pgTable(
  'source',
  {
    id: pk(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    type: sourceTypeEnum('type').notNull(),
    baseUrl: text('base_url').notNull(),
    tosUrl: text('tos_url'),
    /** robots/ToS 核查结论。unknown 与 disallowed 一样：禁止抓取。 */
    robotsStatus: robotsStatusEnum('robots_status').notNull().default('unknown'),
    robotsCheckedAt: timestamp('robots_checked_at', { withTimezone: true }),
    robotsNote: text('robots_note'),
    /** 可信权重 0–100，一位小数。评分依据必须写在 trust_note（rubric 见 docs/data-model.md §来源注册表）。 */
    trustWeight: numeric('trust_weight', { precision: 4, scale: 1 }).notNull().default('50.0'),
    trustNote: text('trust_note'),
    /** 每天计划抓取次数（v1 按天采集，典型 1–2 次）。 */
    crawlFrequencyPerDay: integer('crawl_frequency_per_day').notNull().default(1),
    /** 对该来源两次请求之间的最小间隔秒数（错峰 + 礼貌抓取）。 */
    rateLimitSeconds: integer('rate_limit_seconds').notNull().default(60),
    /** 允许抓取时段，如 {"hours":[[8,20]]}；缺省视为全时段但受 rate_limit 约束。 */
    crawlWindowJson: jsonb('crawl_window_json'),
    /** 适配器类型：static_html | rss | json_api | browser（P0-3 实现适配器）。 */
    fetcherKind: text('fetcher_kind').notNull().default('static_html'),
    fetcherParams: jsonb('fetcher_params'),
    status: sourceStatusEnum('status').notNull().default('paused'),
    statusReason: text('status_reason'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('source_trust_range', sql`${t.trustWeight} BETWEEN 0 AND 100`),
    /** 采集前置条件进 DB 层：robots 未核查/禁止的来源物理上不能置 active。 */
    check(
      'source_active_requires_robots_allowed',
      sql`${t.status} <> 'active' OR ${t.robotsStatus} = 'allowed'`,
    ),
    index('source_status_idx').on(t.status),
  ],
);

/**
 * 来源覆盖范围。来源对「废钢在华北可信」不代表「废纸在华南可信」——覆盖与可信都按品类/规格/地域粒度登记，
 * trustWeightOverride 可在该粒度上覆盖来源默认权重。
 */
export const sourceCoverage = pgTable(
  'source_coverage',
  {
    id: pk(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => source.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    /** 空规格 = 该品类全规格。 */
    specId: uuid('spec_id').references(() => specGrade.id),
    /** 空地域 = 该品类全地域。 */
    regionId: uuid('region_id').references(() => region.id),
    trustWeightOverride: numeric('trust_weight_override', { precision: 4, scale: 1 }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('source_coverage_uq')
      .on(t.sourceId, t.categoryId, t.specId, t.regionId)
      .nullsNotDistinct(),
    foreignKey({
      name: 'source_coverage_category_spec_fk',
      columns: [t.categoryId, t.specId],
      foreignColumns: [specGrade.categoryId, specGrade.id],
    }),
    check(
      'source_coverage_trust_range',
      sql`${t.trustWeightOverride} IS NULL OR ${t.trustWeightOverride} BETWEEN 0 AND 100`,
    ),
    index('source_coverage_lookup_idx').on(t.categoryId, t.regionId),
  ],
);

/**
 * 来源事件流（append-only）：robots 复查结论、可信权重调整、暂停/恢复、异常记录。
 * 采集合规的审计基础：任何时候都能回答「这个来源什么时候被允许抓、依据什么」。
 */
export const sourceEvent = pgTable(
  'source_event',
  {
    id: pk(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => source.id),
    /** robots_recheck | trust_change | pause | resume | retire | fetch_anomaly | note */
    eventKind: text('event_kind').notNull(),
    detail: jsonb('detail').notNull(),
    actor: text('actor').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('source_event_source_idx').on(t.sourceId, t.createdAt)],
);
