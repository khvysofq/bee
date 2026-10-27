import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { createdAt, pk } from './dictionary';

/**
 * 作业系统（ADR-0010）：任务即数据。
 *
 * 四张表的职责边界：
 *  - job_def：任务定义。新增同类任务 = 插一行；上下线 = 改 enabled；调频率 = 改 cron。
 *  - job_run：每次执行台账。(job_code, scheduled_for) 唯一 —— 一个时间窗只跑一次；
 *    scheduled_for 为空 = 手动触发，允许同任务多次（Postgres 唯一约束 NULL 互不冲突）。
 *  - ingest_candidate：worker/agent 的落库缓冲。只写候选，不写业务表；
 *    dedupe_key 唯一 —— 同一份数据重复投递只留一条。
 *  - source_policy：合规前置。抓取前先查；login_wall 或 redistribution=none 直接拒绝。
 *
 * 状态取值用 CHECK 钉死（不用 pgEnum：新增状态只改约束，不锁死迁移成本）。
 */

export const jobDef = pgTable(
  'job_def',
  {
    id: pk(),
    code: text('code').notNull().unique(),
    /** fetch_table | fetch_article | render_page | extract_news | analyze | healthcheck（P0 只实现 fetch_table）。 */
    type: text('type').notNull(),
    /** deterministic | render | agent */
    tier: text('tier').notNull().default('deterministic'),
    /** {url, urls[], method, headers, rps} */
    target: jsonb('target').notNull(),
    /** 自然语言任务目标（人读；worker 不据此推断数字）。 */
    goal: text('goal').notNull(),
    /** 确定性解析器 key；null = 交给 agent（P1+）。 */
    adapter: text('adapter'),
    outputSchema: jsonb('output_schema'),
    /** {table, data_class, keys:{...}} —— 候选 → 业务字段的映射声明。 */
    mapping: jsonb('mapping').notNull(),
    /** {cron, tz, enabled} */
    schedule: jsonb('schedule').notNull(),
    /** {timeout_s, max_attempts, backoff_s:[...]} */
    limits: jsonb('limits').notNull(),
    /** profile/skills/model；P0 留位不用。 */
    agent: jsonb('agent'),
    /** source_code、redistribution —— 合规判决输入。 */
    policy: jsonb('policy'),
    priority: integer('priority').notNull().default(5),
    enabled: boolean('enabled').notNull().default(true),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_def_enabled_idx').on(t.enabled),
    index('job_def_type_idx').on(t.type),
    check(
      'job_def_type_domain',
      sql`${t.type} IN ('fetch_table', 'fetch_article', 'render_page', 'extract_news', 'analyze', 'healthcheck')`,
    ),
    check('job_def_tier_domain', sql`${t.tier} IN ('deterministic', 'render', 'agent')`),
    check('job_def_priority_range', sql`${t.priority} BETWEEN 1 AND 9`),
  ],
);

export const jobRun = pgTable(
  'job_run',
  {
    id: pk(),
    /** 不建外键到 job_def.code：任务删除后运行台账仍须保留。 */
    jobCode: text('job_code').notNull(),
    /** cron 窗口；null = 手动触发。 */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** queued | running | succeeded | failed | dead | skipped | policy_blocked */
    status: text('status').notNull(),
    attempt: integer('attempt').notNull().default(1),
    workerId: text('worker_id'),
    tierUsed: text('tier_used'),
    costMs: integer('cost_ms'),
    costTokens: integer('cost_tokens'),
    fetchedBytes: integer('fetched_bytes'),
    httpStatus: integer('http_status'),
    rawFetchId: uuid('raw_fetch_id'),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    /** 一个时间窗只跑一次；scheduled_for IS NULL 的手动触发不受此约束（NULL 互不相等）。 */
    unique('job_run_code_scheduled_uq').on(t.jobCode, t.scheduledFor),
    index('job_run_job_idx').on(t.jobCode, t.startedAt),
    index('job_run_status_idx').on(t.status, t.startedAt),
    check(
      'job_run_status_domain',
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'skipped', 'policy_blocked')`,
    ),
    check('job_run_attempt_positive', sql`${t.attempt} >= 1`),
  ],
);

export const ingestCandidate = pgTable(
  'ingest_candidate',
  {
    id: pk(),
    jobRunId: uuid('job_run_id'),
    /** quote | series_point | news | analysis（P0 用 quote）。 */
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    schemaOk: boolean('schema_ok').notNull().default(false),
    dedupeKey: text('dedupe_key').notNull(),
    /** {raw_fetch: {sha256, ref, url, ...}, selector} —— 每行可追到存档。 */
    evidenceRef: jsonb('evidence_ref'),
    /** pending | accepted | rejected */
    status: text('status').notNull().default('pending'),
    rejectReason: text('reject_reason'),
    validatorVersion: text('validator_version'),
    acceptedRowId: uuid('accepted_row_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('ingest_candidate_dedupe_uq').on(t.dedupeKey),
    index('ingest_candidate_status_idx').on(t.status, t.createdAt),
    index('ingest_candidate_run_idx').on(t.jobRunId),
    check('ingest_candidate_kind_domain', sql`${t.kind} IN ('quote', 'series_point', 'news', 'analysis')`),
    check('ingest_candidate_status_domain', sql`${t.status} IN ('pending', 'accepted', 'rejected')`),
  ],
);

export const sourcePolicy = pgTable(
  'source_policy',
  {
    sourceCode: text('source_code').primaryKey(),
    domain: text('domain').notNull(),
    robotsStatus: text('robots_status'),
    robotsCheckedAt: date('robots_checked_at', { mode: 'string' }),
    tosNote: text('tos_note'),
    loginWall: boolean('login_wall').default(false),
    /** none | internal_only | attribution | licensed */
    redistribution: text('redistribution').notNull().default('internal_only'),
    /** 单域每秒请求数上限；worker 侧强制。 */
    rpsLimit: numeric('rps_limit'),
    notes: text('notes'),
  },
  (t) => [
    check(
      'source_policy_redistribution_domain',
      sql`${t.redistribution} IN ('none', 'internal_only', 'attribution', 'licensed')`,
    ),
    check('source_policy_rps_positive', sql`${t.rpsLimit} IS NULL OR ${t.rpsLimit} > 0`),
  ],
);