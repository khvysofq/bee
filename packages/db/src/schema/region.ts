import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { dictStatusEnum, regionLevelEnum } from './_enums';
import { createdAt, pk } from './dictionary';

/**
 * 地域对齐模型（交付物四）：市场 / 城市 / 大区 三级 + 国家根节点。
 *
 * 不变量（应用层强制 + 集成测试覆盖，见 docs/data-model.md §地域对齐）：
 *  1. 报价观测只允许挂靠 market 或 city 层级 —— 来源发了什么粒度就记什么粒度，绝不向上「升格」。
 *  2. 「全国」「大区」层级的数字只能以 derived_indicator（加工指标）形态存在，必须渲染加工指标标注。
 *  3. 链条：market → city → macro_region → country，单向无环。
 */
export const region = pgTable(
  'region',
  {
    id: pk(),
    /** 层级。country 仅一行（中国）。 */
    level: regionLevelEnum('level').notNull(),
    code: text('code').notNull().unique(),
    nameCn: text('name_cn').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => region.id),
    status: dictStatusEnum('status').notNull().default('draft'),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    note: text('note'),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('region_level_idx').on(t.level),
    index('region_parent_idx').on(t.parentId),
    check('region_parent_self', sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
  ],
);
