import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { dictStatusEnum, mappingStatusEnum } from './_enums';

/** 主键列：全库统一 uuid v4（gen_random_uuid，Postgres 16 原生）。 */
export const pk = () => uuid('id').primaryKey().defaultRandom();

/** 创建时间：默认 now()。 */
export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * 品类字典（口径字典 · 一）。code 全局唯一（如 scrap-steel）。
 * 任何来源文本里的品类，最终都必须落到这里的一行；落不进去的进异常队列。
 */
export const category = pgTable(
  'category',
  {
    id: pk(),
    code: text('code').notNull().unique(),
    nameCn: text('name_cn').notNull(),
    nameEn: text('name_en'),
    description: text('description'),
    status: dictStatusEnum('status').notNull().default('draft'),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    sortOrder: integer('sort_order').notNull().default(0),
    /** 谁定下的口径：'seed' | 'human:<id>' | 'agent:<id>' | 'caliber_decision:<id>' */
    decidedBy: text('decided_by'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('category_code_shape', sql`${t.code} ~ '^[a-z0-9-]+$'`)],
);

/**
 * 规格/等级字典（口径字典 · 二）。挂在品类下，kind 区分「规格」与「等级」；
 * qualityTier 给同品类内品质档位排序（越大品质越高，可空）。is_core = v1 核心规格。
 */
export const specGrade = pgTable(
  'spec_grade',
  {
    id: pk(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    code: text('code').notNull(),
    nameCn: text('name_cn').notNull(),
    kind: text('kind').notNull().default('grade'),
    qualityTier: integer('quality_tier'),
    /** 口径定义：什么算这个等级（质量标准摘要，人可读可校对）。 */
    definition: text('definition'),
    isCore: integer('is_core').notNull().default(0),
    status: dictStatusEnum('status').notNull().default('draft'),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    sortOrder: integer('sort_order').notNull().default(0),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('spec_grade_category_code_uq').on(t.categoryId, t.code),
    /** (category_id, id) 唯一 —— 供各业务表做「spec 必须挂在该 category 下」的复合外键引用。 */
    unique('spec_grade_category_id_uq').on(t.categoryId, t.id),
    check('spec_grade_kind_domain', sql`${t.kind} IN ('spec', 'grade')`),
    index('spec_grade_category_idx').on(t.categoryId),
  ],
);

/**
 * 品名/规格文本映射（口径字典 · 二之通道）。把来源原文的品类与规格文本映射到规范 id。
 * scope=global 的行是全局同义词；scope=source 的行是来源专属口径（同一句「干净料」在不同站含义不同）。
 * 映射是规范化的关键留痕：观测上冻结的是映射结果，本表保留全部历史映射版本（修正=新行+旧行 rejected/proposed→active 迁移）。
 */
export const termMapping = pgTable(
  'term_mapping',
  {
    id: pk(),
    scope: text('scope').notNull().default('global'),
    sourceId: uuid('source_id'),
    rawCategoryText: text('raw_category_text').notNull(),
    rawSpecText: text('raw_spec_text'),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id),
    specId: uuid('spec_id').references(() => specGrade.id),
    confidence: numeric('confidence', { precision: 3, scale: 2 }),
    status: mappingStatusEnum('status').notNull().default('proposed'),
    note: text('note'),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'term_mapping_scope_source',
      sql`(${t.scope} = 'global' AND ${t.sourceId} IS NULL) OR (${t.scope} = 'source' AND ${t.sourceId} IS NOT NULL)`,
    ),
    foreignKey({
      name: 'term_mapping_category_spec_fk',
      columns: [t.categoryId, t.specId],
      foreignColumns: [specGrade.categoryId, specGrade.id],
    }),
    index('term_mapping_lookup_idx').on(t.sourceId, t.rawCategoryText, t.rawSpecText),
    index('term_mapping_status_idx').on(t.status),
  ],
);

/**
 * 地域文本映射（口径字典 · 四之通道）。来源原文的「华东/鲁南/临沂兰山」→ 规范地域 id。
 * 与品名映射分表而非混用一张多态表：两套语义、两套索引，显式优于聪明。
 *
 * 表定义在 region.ts（依赖 region 表；dictionary 与 region 之间避免循环引用）。
 */

/**
 * 杂质扣减规则（口径字典 · 三）。
 * 口径原则：观测值永不被扣减规则偷改。规则只在校验比较与可比口径换算时应用，应用记录落在 validation_result.detail。
 * 匹配优先级：spec 精确 > category > 全局（两列皆空）。
 */
export const impurityRule = pgTable(
  'impurity_rule',
  {
    id: pk(),
    categoryId: uuid('category_id').references(() => category.id),
    specId: uuid('spec_id').references(() => specGrade.id),
    /** weight_percent 按比例扣重；price_per_ton 按元/吨扣价；grade_downgrade 降档处理。 */
    ruleKind: text('rule_kind').notNull(),
    /** 参数，如 {"percent": 3} / {"yuanPerTon": 50}。 */
    paramJson: jsonb('param_json').notNull(),
    /** 适用条件的人可读说明（如「含水率>5% 的统料」）。 */
    conditionText: text('condition_text'),
    status: dictStatusEnum('status').notNull().default('draft'),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    effectiveTo: date('effective_to', { mode: 'string' }),
    version: integer('version').notNull().default(1),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'impurity_rule_scope_valid',
      sql`${t.specId} IS NULL OR ${t.categoryId} IS NOT NULL`,
    ),
    check(
      'impurity_rule_kind_domain',
      sql`${t.ruleKind} IN ('weight_percent', 'price_per_ton', 'grade_downgrade')`,
    ),
    check(
      'impurity_rule_period_valid',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveFrom} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    foreignKey({
      name: 'impurity_rule_category_spec_fk',
      columns: [t.categoryId, t.specId],
      foreignColumns: [specGrade.categoryId, specGrade.id],
    }),
    index('impurity_rule_scope_idx').on(t.categoryId, t.specId),
  ],
);

/** 计价单位（口径字典 · 四）。v1 规范单位固定为 元/吨（CNY_per_ton，is_canonical）。 */
export const unit = pgTable('unit', {
  id: pk(),
  code: text('code').notNull().unique(),
  nameCn: text('name_cn').notNull(),
  isCanonical: integer('is_canonical').notNull().default(0),
  createdAt: createdAt(),
});

/** 单位换算：from × factor = to。来源原文单位换算成规范单位的依据。 */
export const unitConversion = pgTable(
  'unit_conversion',
  {
    id: pk(),
    fromUnitId: uuid('from_unit_id')
      .notNull()
      .references(() => unit.id),
    toUnitId: uuid('to_unit_id')
      .notNull()
      .references(() => unit.id),
    factor: numeric('factor', { precision: 18, scale: 8 }).notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('unit_conversion_from_to_uq').on(t.fromUnitId, t.toUnitId),
    check('unit_conversion_factor_positive', sql`${t.factor} > 0`),
  ],
);

/**
 * 口径决策台账（append-only）。「人只出现在异常队列与口径决策点」——这一张表就是口径决策点的物理形态。
 * 每一行 = 一次人对口径的裁决：改了什么、为什么、何时生效。
 */
export const caliberDecision = pgTable(
  'caliber_decision',
  {
    id: pk(),
    /** category | spec | term_mapping | region_mapping | impurity_rule | region | unit */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id'),
    question: text('question').notNull(),
    decision: text('decision').notNull(),
    decidedBy: text('decided_by').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    createdAt: createdAt(),
  },
  (t) => [index('caliber_decision_subject_idx').on(t.subjectType, t.subjectId)],
);
