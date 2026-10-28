import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/** 主键统一：uuid + gen_random_uuid()。 */
const pk = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * 品类（v4 唯一主轴）。新增品类 = 插一行，不建表、不分区。
 * code 使用内部品类编号（如 1110105），也是 OSS 路径中的 category_code。
 */
export const category = pgTable(
  'category',
  {
    id: pk(),
    code: text('code').notNull().unique(),
    nameCn: text('name_cn').notNull(),
    nameEn: text('name_en'),
    description: text('description'),
    status: text('status').notNull().default('active'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** 品类级扩展配置（采集口径、展示偏好等），不轻易加列。 */
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('category_status_chk', sql`${t.status} IN ('draft', 'active', 'archived')`)],
);

/** 规格（挂在品类下）。code 为小写英文/拼音；aliases 存来源原文别名。 */
export const spec = pgTable(
  'spec',
  {
    id: pk(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    tier: integer('tier'),
    status: text('status').notNull().default('active'),
  },
  (t) => [
    unique('spec_category_code_uq').on(t.categoryId, t.code),
    check('spec_status_chk', sql`${t.status} IN ('active', 'retired')`),
  ],
);

/**
 * 地域：global → country → province → city（market 为最具体的交易市场）。
 * parent_id 自引用；aliases 存来源原文别名。
 */
export const region = pgTable(
  'region',
  {
    id: pk(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    level: text('level').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => region.id),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status').notNull().default('active'),
  },
  (t) => [
    index('region_parent_idx').on(t.parentId),
    index('region_level_idx').on(t.level),
    check(
      'region_level_chk',
      sql`${t.level} IN ('global', 'country', 'province', 'city', 'market')`,
    ),
  ],
);