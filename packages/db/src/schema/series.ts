import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
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
import { dataLayerEnum, dictStatusEnum, seriesFrequencyEnum, seriesKindEnum } from './_enums';
import { category, createdAt, pk, unit } from './dictionary';
import { region } from './region';
import { source } from './source';
import { rawFetch } from './fetch';
import { pipelineRun } from './pipeline';

/**
 * 时序序列（期货 / 指数 / 库存 / 宏观）—— 三层数据的统一载体。
 *
 * 为什么不复用 price_observation：
 *  1. price_observation 的语义是「来源页面上的**一行价目**」（raw_text、区间、单位换算、映射），
 *     期货合约是「一个标的在某交易日的**一个结算价**」，没有 raw_text 区间，也不该进规格字典
 *     （rb2601/rb2605 是合约，不是规格；逐合约建 spec_grade 会让字典随换月无限膨胀）。
 *  2. 现货报价与期货结算价是两种东西：一个是成交，一个是预期。混在一张表里，
 *     「全国均价」的聚合迟早会把两者算到一起——这是产品可信度上的自杀。
 *
 * 所以纪律是：**现货/统计报价走 price_observation，期货/指数/库存/宏观走 market_series + series_point。**
 * 两条链共用同一套不可变存档（raw_fetch）与台账（pipeline_run），溯源能力一致。
 */
export const marketSeries = pgTable(
  'market_series',
  {
    id: pk(),
    /** 稳定业务键，如 shfe.rb.settle / fred.PCOPPUSDM / wb.steel_index。 */
    code: text('code').notNull().unique(),
    nameCn: text('name_cn').notNull(),
    /** 展示层级：国际 / 国内全国 / 区域。 */
    layer: dataLayerEnum('layer').notNull(),
    kind: seriesKindEnum('kind').notNull(),
    frequency: seriesFrequencyEnum('frequency').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => source.id),
    /** 关联品类（铜/铝/废钢…）。国际基准与宏观量可空。 */
    categoryId: uuid('category_id').references(() => category.id),
    /** 区域层必填；国际层必须为空（国际基准不属于任何中国行政区）；全国层可空。 */
    regionId: uuid('region_id').references(() => region.id),
    /** 品种/序列代码：rb、cu、i、PCOPPUSDM、CMO.STEEL。 */
    instrumentCode: text('instrument_code').notNull(),
    /** 场所：SHFE / INE / CZCE / DCE / GFEX / FRED / WORLD_BANK / WORLDSTEEL。 */
    venue: text('venue'),
    unitId: uuid('unit_id').references(() => unit.id),
    /** 计价币种；国际序列多为 USD。 */
    currency: text('currency').notNull().default('CNY'),
    /** 来源端点的稳定引用（URL 模板或序列 id），采集器据此取数。 */
    externalRef: text('external_ref'),
    /** 是否允许对外展示。false = 仅内部校验用（如未取得再发布权的序列）。 */
    displayAllowed: boolean('display_allowed').notNull().default(true),
    summary: text('summary'),
    status: dictStatusEnum('status').notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** 复合外键目标：series_point 不能声称属于别的来源。 */
    unique('market_series_id_source_uq').on(t.id, t.sourceId),
    index('market_series_layer_idx').on(t.layer, t.kind),
    index('market_series_source_idx').on(t.sourceId),
    check(
      'market_series_international_region',
      sql`${t.layer} <> 'international' OR ${t.regionId} IS NULL`,
    ),
    check('market_series_regional_region', sql`${t.layer} <> 'regional' OR ${t.regionId} IS NOT NULL`),
    check('market_series_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * 时序数据点：一条序列在某日的取值。
 *
 * 不可变纪律与 price_observation 一致（迁移守卫触发器强制）：
 *  - 值写入后禁 UPDATE / DELETE；修正 = 新 revision（同 series 同日期，revision+1），旧点永远可查。
 *  - 幂等重跑：唯一键 (series_id, obs_date, revision) 上的 ON CONFLICT DO NOTHING，
 *    同一交易日重复采集不会产生第二行。
 *  - 溯源：每条点必挂 fetch_id（原始页面/接口响应在 raw_fetch + 内容寻址存档里），
 *    并带 source_row_index（该响应内的行号），可逐条点回原文。
 */
export const seriesPoint = pgTable(
  'series_point',
  {
    id: pk(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => marketSeries.id),
    /** 冗余来源（复合外键强制与序列登记的来源一致）。 */
    sourceId: uuid('source_id').notNull(),
    /** 观测日期。日线 = 交易日；月线 = 当月 1 日。 */
    obsDate: date('obs_date', { mode: 'string' }).notNull(),
    /** 同序列同日期的版本号：首版 1，修正 revision+1。 */
    revision: integer('revision').notNull().default(1),
    /** 主值：期货结算价 / 指数值 / 库存量 / 产量。 */
    value: numeric('value', { precision: 18, scale: 4 }).notNull(),

    // —— 期货 OHLCV（非期货序列留空）——
    openPrice: numeric('open_price', { precision: 18, scale: 4 }),
    highPrice: numeric('high_price', { precision: 18, scale: 4 }),
    lowPrice: numeric('low_price', { precision: 18, scale: 4 }),
    closePrice: numeric('close_price', { precision: 18, scale: 4 }),
    settlePrice: numeric('settle_price', { precision: 18, scale: 4 }),
    volume: numeric('volume', { precision: 20, scale: 2 }),
    openInterest: numeric('open_interest', { precision: 20, scale: 2 }),
    turnover: numeric('turnover', { precision: 20, scale: 2 }),

    /** 原始记录其余字段（合约月份、中文名、单位原文、页面标注等），审计用。 */
    detail: jsonb('detail'),

    // —— 溯源 ——
    fetchId: uuid('fetch_id')
      .notNull()
      .references(() => rawFetch.id),
    sourceRowIndex: integer('source_row_index').notNull().default(0),
    runId: uuid('run_id').references(() => pipelineRun.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('series_point_key_uq').on(t.seriesId, t.obsDate, t.revision),
    foreignKey({
      name: 'series_point_series_source_fk',
      columns: [t.seriesId, t.sourceId],
      foreignColumns: [marketSeries.id, marketSeries.sourceId],
    }),
    foreignKey({
      name: 'series_point_fetch_source_fk',
      columns: [t.fetchId, t.sourceId],
      foreignColumns: [rawFetch.id, rawFetch.sourceId],
    }),
    index('series_point_date_idx').on(t.obsDate),
    index('series_point_series_date_idx').on(t.seriesId, t.obsDate),
    check('series_point_revision_positive', sql`${t.revision} >= 1`),
    check('series_point_obs_date_shape', sql`${t.obsDate} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    check(
      'series_point_high_low',
      sql`${t.highPrice} IS NULL OR ${t.lowPrice} IS NULL OR ${t.highPrice} >= ${t.lowPrice}`,
    ),
  ],
);