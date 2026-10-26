import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { observationStatusEnum, priceTypeEnum } from './_enums';
import { createdAt, pk, specGrade, category, unit } from './dictionary';
import { region } from './region';
import { source } from './source';
import { rawFetch } from './fetch';
import { pipelineRun } from './pipeline';

/**
 * 报价观测层（交付物二 · 观测半层）：一次抓取中抽出的一条报价，一源一价一记录。
 *
 * 这是「同一品类同城不同价」的物理载体：
 *  - 不同来源对同一 key 给出不同价 → 多行共存（来源是普通属性，不在唯一键里）；
 *  - 同城不同市场 → region 粒度到 market；
 *  - 采购/销售/到厂 → price_type 不同行。
 *
 * 字段分三段：
 *  raw_*（原文怎么说的，永不改）→ 归一维度 id（category/spec/region/price_type，由映射解析后冻结）→ norm_*（规范值，元/吨）。
 *
 * 不变量（DB 层强制）：
 *  - (fetch_id, source_row_index) 唯一：同一次抓取里的行天然去重。
 *  - validation_status='validated' ⇒ 归一维度与规范值必须齐全（校验通过的东西必须可定档）。
 *  - 修改保护：值字段（raw_*、norm_*、维度 id、quote_date）UPDATE 一律禁止，仅允许
 *    validation_status / superseded_by_id / 状态流转——迁移 SQL 中的触发器强制（bee_price_observation_guard）。
 *    修正 = 落新观测 + supersede 链，旧值永远可查。
 */
export const priceObservation = pgTable(
  'price_observation',
  {
    id: pk(),
    fetchId: uuid('fetch_id')
      .notNull()
      .references(() => rawFetch.id),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => source.id),
    /** 冗余抓取时间（源自 raw_fetch.fetched_at），满足「每条记录必带抓取时间」的直接可查性。 */
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    /** 同一次抓取内的行序号（一个页面往往是一张价目表）。 */
    sourceRowIndex: integer('source_row_index').notNull(),

    // —— 原文层（as-published，永不修改）——
    /** 原文价格表述，如 "2350-2400" 或 "华东废钢稳中个跌"。 */
    rawText: text('raw_text').notNull(),
    rawValueLow: numeric('raw_value_low', { precision: 12, scale: 2 }),
    rawValueHigh: numeric('raw_value_high', { precision: 12, scale: 2 }),
    rawUnit: text('raw_unit'),
    rawCategoryText: text('raw_category_text').notNull(),
    rawSpecText: text('raw_spec_text'),
    rawRegionText: text('raw_region_text'),
    rawPriceTypeText: text('raw_price_type_text'),

    // —— 归一层（映射解析后冻结在此；映射表保留过程）——
    categoryId: uuid('category_id').references(() => category.id),
    specId: uuid('spec_id').references(() => specGrade.id),
    regionId: uuid('region_id').references(() => region.id),
    priceType: priceTypeEnum('price_type'),

    // —— 规范层（canonical：元/吨）——
    normValueLow: numeric('norm_value_low', { precision: 12, scale: 2 }),
    normValueHigh: numeric('norm_value_high', { precision: 12, scale: 2 }),
    unitId: uuid('unit_id').references(() => unit.id),
    /** 实际应用的换算，如 {"from":"元/斤","factor":2000}。无换算则 {"from":"元/吨","factor":1}。 */
    conversionApplied: jsonb('conversion_applied'),

    /** 报价适用日期（来源标注的行情日；「10月26日价」→ 2026-10-26）。 */
    quoteDate: date('quote_date', { mode: 'string' }),
    /** 来源标注的行情时点（可空）。 */
    observedAt: timestamp('observed_at', { withTimezone: true }),

    validationStatus: observationStatusEnum('validation_status').notNull().default('pending_mapping'),
    /** 被哪条新观测替代（重放/修正场景）。 */
    supersededById: uuid('superseded_by_id').references((): AnyPgColumn => priceObservation.id),

    /** 抽取器/规范化器版本 pin（回放的版本依据）。 */
    extractVersion: text('extract_version'),
    normalizerVersion: text('normalizer_version'),
    runId: uuid('run_id').references(() => pipelineRun.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('price_observation_fetch_row_uq').on(t.fetchId, t.sourceRowIndex),
    index('price_observation_key_idx').on(t.categoryId, t.regionId, t.quoteDate),
    index('price_observation_status_idx').on(t.validationStatus),
    index('price_observation_source_date_idx').on(t.sourceId, t.quoteDate),
    check(
      'price_observation_raw_range',
      sql`${t.rawValueLow} IS NULL OR ${t.rawValueHigh} IS NULL OR ${t.rawValueLow} <= ${t.rawValueHigh}`,
    ),
    check(
      'price_observation_norm_range',
      sql`${t.normValueLow} IS NULL OR ${t.normValueHigh} IS NULL OR ${t.normValueLow} <= ${t.normValueHigh}`,
    ),
    check(
      'price_observation_validated_completeness',
      sql`${t.validationStatus} <> 'validated' OR (
        ${t.categoryId} IS NOT NULL AND ${t.specId} IS NOT NULL AND ${t.regionId} IS NOT NULL
        AND ${t.priceType} IS NOT NULL AND ${t.quoteDate} IS NOT NULL
        AND ${t.normValueLow} IS NOT NULL AND ${t.normValueHigh} IS NOT NULL AND ${t.unitId} IS NOT NULL
      )`,
    ),
  ],
);
