import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { dictStatusEnum, mappingStatusEnum, regionLevelEnum } from './_enums';
import { createdAt, pk } from './dictionary';

/**
 * 地域对齐模型（交付物四）：市场 / 城市 / 大区 三级 + 国家根节点。
 *
 * 不变量（DAW-33 评审后全部为 DB 层强制，见迁移守卫触发器与 docs/data-model.md §地域对齐）：
 *  1. 报价观测只允许挂靠 market 或 city 层级 —— 来源发了什么粒度就记什么粒度，绝不向上「升格」。
 *  2. 「全国」「大区」层级的数字只能以 derived_indicator（加工指标）形态存在，且 kind ↔ 层级绑定：
 *     national_* → country、region_aggregate → macro_region、city_aggregate → city。
 *  3. 链条：market → city → macro_region → country，逐级上行，触发器强制父层级匹配 → 物理无环。
 *  4. country 单根：全局唯一部分索引（region_single_country_uq）。
 *  5. 已被引用（observation/quote/indicator/mapping/coverage）的 region 禁改 level/parent ——
 *     维度一旦参与事实就冻结（触发器 bee_region_referenced_guard）。
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

/**
 * 地域文本映射（口径字典 · 四之通道）。来源原文的「华东/鲁南/临沂兰山」→ 规范地域 id。
 * 与品名映射分表而非混用一张多态表：两套语义、两套索引，显式优于聪明。
 * 本表定义在 region.ts：region_id 有真实外键（region 表），避免 dictionary ↔ region 循环引用。
 *
 * 确定性（DAW-33 评审修复）：同一 (scope, source, raw_region_text) 只允许一条 active
 * —— 部分唯一索引 region_mapping_active_uq（迁移 SQL），映射解析结果不再依赖查询顺序。
 * 查询契约：source 专属 active 行优先于 global active 行（P0-3 实现必须遵守，见 docs/data-model.md）。
 */
export const regionMapping = pgTable(
  'region_mapping',
  {
    id: pk(),
    scope: text('scope').notNull().default('global'),
    sourceId: uuid('source_id'),
    rawRegionText: text('raw_region_text').notNull(),
    regionId: uuid('region_id')
      .notNull()
      .references(() => region.id),
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
    status: mappingStatusEnum('status').notNull().default('proposed'),
    note: text('note'),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'region_mapping_scope_source',
      sql`(${t.scope} = 'global' AND ${t.sourceId} IS NULL) OR (${t.scope} = 'source' AND ${t.sourceId} IS NOT NULL)`,
    ),
    index('region_mapping_lookup_idx').on(t.sourceId, t.rawRegionText),
  ],
);
