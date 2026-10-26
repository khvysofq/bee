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
} from 'drizzle-orm/pg-core';
import { indicatorKindEnum, priceTypeEnum, quoteMethodEnum, quoteStatusEnum } from './_enums';
import { createdAt, pk, specGrade, category } from './dictionary';
import { region } from './region';
import { pipelineRun } from './pipeline';

/**
 * 当日定档报价（交付物二 · 定档半层）：简报直接消费的表。
 *
 * 主键语义（任务口径 + 一处明确扩展）：品类 × 规格/等级 × 地域 × 日期 × 价类型。
 * 相比任务原文多了 price_type：采购价与销售价同日同城必然不同，这是「同一品类同城不同价」
 * 的合法维度，不进键就表达不了（验收里要求能表达）。
 *
 * 派生与不可变分层（见 docs/data-model.md §分层不可变策略）：
 *  - 本表 = 当前态，可由 contributing_observation_ids + method + method_version 确定性重算；
 *  - 观测层 = 事实层，值永不改；
 *  - 简报快照（P0-4）固化发布时的渲染值，历史态不依赖本表。
 *
 * 只有 validation_status='validated' 的观测可参与定档；isolated/needs_human 的观测永远进不来（管线层强制）。
 */
export const dailyQuote = pgTable(
  'daily_quote',
  {
    id: pk(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    specId: uuid('spec_id')
      .notNull()
      .references(() => specGrade.id),
    /** 只允许 market/city 层级（应用层校验 + 集成测试）。 */
    regionId: uuid('region_id')
      .notNull()
      .references(() => region.id),
    quoteDate: date('quote_date', { mode: 'string' }).notNull(),
    priceType: priceTypeEnum('price_type').notNull(),

    valueLow: numeric('value_low', { precision: 12, scale: 2 }).notNull(),
    valueHigh: numeric('value_high', { precision: 12, scale: 2 }).notNull(),
    /** 区间中值或单点值；单点 = low = high。 */
    valueMid: numeric('value_mid', { precision: 12, scale: 2 }).notNull(),

    method: quoteMethodEnum('method').notNull(),
    /** 参与定档的观测 id 快照 —— 溯源链上游指针。 */
    contributingObservationIds: uuid('contributing_observation_ids').array().notNull(),
    sourceCount: integer('source_count').notNull(),
    /** 定档规则集版本 + 计算运行的版本 pin（回放依据）。 */
    methodVersion: text('method_version').notNull(),
    rulesVersion: text('rules_version'),
    computationRunId: uuid('computation_run_id').references(() => pipelineRun.id),

    /** high | medium | low —— 覆盖来源数与校验质量的综合提示，简报必须展示。 */
    confidence: text('confidence').notNull().default('medium'),
    /** 覆盖说明：几个来源、几个市场、有无数据缺口。 */
    coverageNote: text('coverage_note'),
    status: quoteStatusEnum('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('daily_quote_key_uq').on(t.categoryId, t.specId, t.regionId, t.quoteDate, t.priceType),
    index('daily_quote_date_idx').on(t.quoteDate),
    index('daily_quote_lookup_idx').on(t.categoryId, t.regionId, t.quoteDate),
    check('daily_quote_range', sql`${t.valueLow} <= ${t.valueHigh} AND ${t.valueMid} BETWEEN ${t.valueLow} AND ${t.valueHigh}`),
    check('daily_quote_confidence_domain', sql`${t.confidence} IN ('high', 'medium', 'low')`),
  ],
);

/**
 * 加工指标（交付物四 · 「全国」的形态）：全国均价 / 全国中位 / 大区聚合 / 城市聚合。
 *
 * 硬规则：本表 is_aggregate 恒为 true —— 从物理上杜绝「全国价」被当成观测值。
 * UI 合同：凡渲染本表数值，必须同时渲染「加工指标」标注与口径说明（method_json 里的口径人话版）。
 *
 * method_json 结构：
 *   { "weights": {"<market region id>": <权重>}, "basis": "按各市场 validated 定档价加权",
 *     "note": "人可读口径说明", "formula": "加权平均" }
 * 权重快照固化在行内 —— 权重以后怎么改，这条指标怎么算出来的永远说得清。
 */
export const derivedIndicator = pgTable(
  'derived_indicator',
  {
    id: pk(),
    kind: indicatorKindEnum('kind').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    /** 空规格 = 品类级混合口径（必须说明）。 */
    specId: uuid('spec_id').references(() => specGrade.id),
    /** 只允许 country/macro_region/city 层级。 */
    regionId: uuid('region_id')
      .notNull()
      .references(() => region.id),
    priceType: priceTypeEnum('price_type'),
    basisDate: date('basis_date', { mode: 'string' }).notNull(),
    value: numeric('value', { precision: 12, scale: 2 }).notNull(),
    methodJson: jsonb('method_json').notNull(),
    methodVersion: text('method_version').notNull(),
    computationRunId: uuid('computation_run_id').references(() => pipelineRun.id),
    /** 参与聚合的定档报价 id 快照。 */
    contributingQuoteIds: uuid('contributing_quote_ids').array().notNull(),
    isAggregate: integer('is_aggregate').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    unique('derived_indicator_key_uq')
      .on(t.kind, t.categoryId, t.specId, t.regionId, t.priceType, t.basisDate)
      .nullsNotDistinct(),
    index('derived_indicator_date_idx').on(t.basisDate),
    check('derived_indicator_is_aggregate', sql`${t.isAggregate} = 1`),
  ],
);
