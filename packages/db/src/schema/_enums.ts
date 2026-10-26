import { pgEnum } from 'drizzle-orm/pg-core';

/** 字典生命周期：草案 → 生效 → 退役。初始 seed 一律 draft，经口径决策确认后 active。 */
export const dictStatusEnum = pgEnum('dict_status', ['draft', 'active', 'retired']);

/** 品名/规格映射状态：agent 提案 → 口径决策确认后生效。 */
export const mappingStatusEnum = pgEnum('mapping_status', ['proposed', 'active', 'rejected']);

/** 来源类型：网页 / RSS / API（v1 不采购付费接口）。 */
export const sourceTypeEnum = pgEnum('source_type', ['webpage', 'rss', 'api']);

/** robots/ToS 核查状态。unknown 视为受限，禁止抓取，直到核查通过。 */
export const robotsStatusEnum = pgEnum('robots_status', ['allowed', 'disallowed', 'unknown']);

/** 来源运行状态。 */
export const sourceStatusEnum = pgEnum('source_status', ['active', 'paused', 'retired']);

/** 地域层级：市场（最具体，报价允许挂靠）/ 城市 / 大区（华东等）/ 国家（仅「中国」根节点）。 */
export const regionLevelEnum = pgEnum('region_level', [
  'market',
  'city',
  'macro_region',
  'country',
]);

/**
 * 价类型：采购（回收站收价）/ 销售（出价）/ 到厂（钢厂/冶炼厂到厂价）/ 挂牌参考。
 * 同一品类×规格×地域×日期下，不同价类型天然就是不同的行。
 */
export const priceTypeEnum = pgEnum('price_type', ['purchase', 'sale', 'ex_works', 'indicative']);

/**
 * 观测校验状态机：
 * pending_mapping（原文已抽，维度待映射）→ normalized（已映射+规范化，待校验）
 * → validated（通过，可进入定档）| isolated（异常隔离，禁入简报）| needs_human（进异常队列）
 * | rejected（口径不符/无效）；superseded（被重放/修正后的新观测替代，仅状态变化，值永不改）。
 */
export const observationStatusEnum = pgEnum('observation_status', [
  'pending_mapping',
  'normalized',
  'validated',
  'isolated',
  'needs_human',
  'rejected',
  'superseded',
]);

/** 校验结论。 */
export const verdictEnum = pgEnum('verdict', ['pass', 'flag', 'isolate', 'needs_human', 'reject']);

/** 校验手段：确定性规则 / LLM 判断 / 人工覆盖。 */
export const checkKindEnum = pgEnum('check_kind', [
  'cross_source',
  'time_series',
  'caliber_consistency',
  'dedupe',
  'threshold_rule',
  'llm_judgment',
  'human_override',
]);

/** 定档方法：单源直取 / 多源中位 / 多源加权。 */
export const quoteMethodEnum = pgEnum('quote_method', [
  'single_source',
  'median_multi_source',
  'weighted_multi_source',
]);

/** 定档报价状态：草稿 → 已发布 → 撤回/替代。 */
export const quoteStatusEnum = pgEnum('quote_status', [
  'draft',
  'published',
  'retracted',
  'superseded',
]);

/** 加工指标类型。「全国均价」只能以这些形态存在，且 UI 必须渲染「加工指标」标注。 */
export const indicatorKindEnum = pgEnum('indicator_kind', [
  'national_weighted_avg',
  'national_median',
  /** 来源直接发布的全国参考价（如国家统计局旬报），不是本系统按城市聚合所得。 */
  'national_reference',
  'region_aggregate',
  'city_aggregate',
]);

/** 管线运行类型。replay 专门承载回放运行。 */
export const runKindEnum = pgEnum('run_kind', [
  'daily_collect',
  'validate',
  'aggregate',
  'publish',
  'replay',
  'maintenance',
]);

export const runStatusEnum = pgEnum('run_status', ['pending', 'running', 'succeeded', 'failed', 'partial']);

export const stepKindEnum = pgEnum('step_kind', [
  'fetch',
  'extract',
  'normalize',
  'validate',
  'aggregate',
  'publish',
  'notify',
]);

export const stepStatusEnum = pgEnum('step_status', ['pending', 'running', 'succeeded', 'failed', 'skipped']);

/** 判断/操作主体：确定性规则 / Agent（LLM）/ 人 / 系统。 */
export const actorKindEnum = pgEnum('actor_kind', ['rule', 'agent', 'human', 'system']);

/** 异常队列种类与状态。人只出现在异常队列与口径决策点。 */
export const exceptionKindEnum = pgEnum('exception_kind', ['validation', 'caliber', 'source', 'pipeline']);
export const exceptionStatusEnum = pgEnum('exception_status', ['open', 'resolved', 'wont_fix']);
export const priorityEnum = pgEnum('priority', ['high', 'medium', 'low']);
