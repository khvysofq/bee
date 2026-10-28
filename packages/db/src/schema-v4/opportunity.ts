import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { category, region } from './catalog';

/** 主键统一：uuid + gen_random_uuid()。 */
const pk = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * 地区典型企业：按品类 × 地域挂在品类轴下。
 *
 * 演示数据统一 is_demo=true；contact_phone 一律脱敏，不存真实联系方式。
 */
export const company = pgTable(
  'company',
  {
    id: pk(),
    name: text('name').notNull(),
    shortName: text('short_name'),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    regionId: uuid('region_id')
      .notNull()
      .references(() => region.id),
    /** recycler 回收加工 / smelter 冶炼 / trader 贸易 / end_user 终端 / supplier 供应商 */
    type: text('type').notNull(),
    scale: text('scale'),
    mainProducts: text('main_products'),
    description: text('description'),
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    verified: boolean('verified').notNull().default(false),
    isDemo: boolean('is_demo').notNull().default(true),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('company_name_region_uq').on(t.name, t.regionId),
    index('company_category_region_idx').on(t.categoryId, t.regionId),
    index('company_region_idx').on(t.regionId),
    check(
      'company_type_chk',
      sql`${t.type} IN ('recycler', 'smelter', 'trader', 'end_user', 'supplier')`,
    ),
    check('company_status_chk', sql`${t.status} IN ('active', 'archived')`),
  ],
);

/**
 * 商机：采购 / 供应 / 合作。company 是发布方，品类与地域冗余存一份，
 * 便于按「品类 × 地区 × 类型」直接过滤，不依赖 join 推导。
 */
export const opportunity = pgTable(
  'opportunity',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => company.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    regionId: uuid('region_id')
      .notNull()
      .references(() => region.id),
    /** purchase 采购 / supply 供应 / cooperation 合作 */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    quantity: numeric('quantity', { precision: 14, scale: 2 }),
    unit: text('unit'),
    priceMin: numeric('price_min', { precision: 14, scale: 2 }),
    priceMax: numeric('price_max', { precision: 14, scale: 2 }),
    currency: text('currency').notNull().default('CNY'),
    deadline: date('deadline', { mode: 'string' }),
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    status: text('status').notNull().default('open'),
    isDemo: boolean('is_demo').notNull().default(true),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('opportunity_category_region_kind_published_idx').on(
      t.categoryId,
      t.regionId,
      t.kind,
      sql`${t.publishedAt} DESC`,
    ),
    index('opportunity_company_idx').on(t.companyId),
    index('opportunity_status_published_idx').on(t.status, sql`${t.publishedAt} DESC`),
    check(
      'opportunity_kind_chk',
      sql`${t.kind} IN ('purchase', 'supply', 'cooperation')`,
    ),
    check('opportunity_status_chk', sql`${t.status} IN ('open', 'closed')`),
    check(
      'opportunity_price_range_chk',
      sql`${t.priceMin} IS NULL OR ${t.priceMax} IS NULL OR ${t.priceMin} <= ${t.priceMax}`,
    ),
  ],
);