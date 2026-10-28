import { desc, sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { category, region, spec } from './catalog';
import { source } from './ops';

/**
 * 每日价格：v4 唯一的数字表。
 *
 * 来源直发的全球价/全国价/省价都直接落行，不做聚合表；
 * 单位/币种是文本列，不建单位字典。
 * spec_id 为空 = 品类级口径。
 */
export const priceDaily = pgTable(
  'price_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    specId: uuid('spec_id').references(() => spec.id),
    regionId: uuid('region_id')
      .notNull()
      .references(() => region.id),
    priceDate: date('price_date', { mode: 'string' }).notNull(),
    priceType: text('price_type').notNull().default('market'),
    valueLow: numeric('value_low', { precision: 14, scale: 2 }),
    valueHigh: numeric('value_high', { precision: 14, scale: 2 }),
    valueMid: numeric('value_mid', { precision: 14, scale: 2 }).notNull(),
    unit: text('unit').notNull().default('元/吨'),
    currency: text('currency').notNull().default('CNY'),
    sourceId: uuid('source_id').references(() => source.id),
    rawUrl: text('raw_url'),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    status: text('status').notNull().default('published'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('price_daily_key_uq')
      .on(t.categoryId, t.specId, t.regionId, t.priceDate, t.priceType)
      .nullsNotDistinct(),
    check(
      'price_daily_type_chk',
      sql`${t.priceType} IN ('market', 'purchase', 'sale', 'ex_works', 'indicative')`,
    ),
    check(
      'price_daily_status_chk',
      sql`${t.status} IN ('draft', 'published', 'retracted')`,
    ),
    check(
      'price_daily_range_chk',
      sql`(${t.valueLow} IS NULL OR ${t.valueMid} >= ${t.valueLow}) AND (${t.valueHigh} IS NULL OR ${t.valueMid} <= ${t.valueHigh})`,
    ),
    index('price_daily_category_region_date_idx').on(
      t.categoryId,
      t.regionId,
      desc(t.priceDate),
    ),
    index('price_daily_category_date_idx').on(t.categoryId, desc(t.priceDate)),
    index('price_daily_spec_idx').on(t.specId),
  ],
);