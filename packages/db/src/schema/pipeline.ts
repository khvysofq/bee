import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { runKindEnum, runStatusEnum, stepKindEnum, stepStatusEnum } from './_enums';
import { createdAt, pk } from './dictionary';

/**
 * 管线运行台账（交付物六 · 回放骨架）：一次「采集→抽取→规范化→校验→聚合→发布」或「回放」的运行。
 *
 * 版本三 pin：git_sha（代码）+ rules_version（校验/定档规则）+ dictionary_hash（当时生效的口径字典内容哈希）。
 * 任何一个 pin 变了，产出就不可直接比较——回放必须显式选择版本组合。
 */
export const pipelineRun = pgTable(
  'pipeline_run',
  {
    id: pk(),
    kind: runKindEnum('kind').notNull(),
    status: runStatusEnum('status').notNull().default('pending'),
    /** schedule | manual | retry | replay */
    triggeredBy: text('triggered_by').notNull(),
    /** 运行参数快照（错峰窗口、来源子集、阈值覆盖等）。 */
    configJson: jsonb('config_json'),
    /** 运行时代码版本（git sha）。 */
    gitSha: text('git_sha'),
    rulesVersion: text('rules_version'),
    /** 当时 active 字典内容的 sha256 —— 回放时精确还原口径环境。 */
    dictionaryHash: text('dictionary_hash'),
    /** 回放运行指向被回放的原始运行。 */
    replayOfRunId: uuid('replay_of_run_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pipeline_run_kind_idx').on(t.kind, t.createdAt),
    index('pipeline_run_status_idx').on(t.status),
  ],
);

/**
 * 步骤台账：run 内每一步的输入输出引用与结果。
 * input_refs/output_refs 结构约定：{ "raw_fetch_ids": [...] } / { "observation_ids": [...] } / { "report_ref": "..." }
 * —— 回放与差异定位的基本单位。
 */
export const pipelineStep = pgTable(
  'pipeline_step',
  {
    id: pk(),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRun.id),
    stepKind: stepKindEnum('step_kind').notNull(),
    /** run 内顺序号。 */
    seq: integer('seq').notNull(),
    status: stepStatusEnum('status').notNull().default('pending'),
    inputRefs: jsonb('input_refs'),
    outputRefs: jsonb('output_refs'),
    logExcerpt: text('log_excerpt'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('pipeline_step_run_idx').on(t.runId, t.seq)],
);

/**
 * Agent 调用留痕（append-only）：管线里每一次 LLM 调用（校验判断/叙事草稿/异常分诊/映射建议）
 * 的模型、prompt 版本、输入输出与耗时。「数字必须来自可追溯来源」之外，Agent 的判断本身也全部可追溯。
 * 约束：输出可以是叙事草稿，但任何价格数字不允许以 Agent 输出为来源进入报价表（管线层强制，P0-3 实现规则）。
 */
export const agentInvocation = pgTable(
  'agent_invocation',
  {
    id: pk(),
    runId: uuid('run_id').references(() => pipelineRun.id),
    stepId: uuid('step_id').references(() => pipelineStep.id),
    /** validation_judgment | narrative_draft | exception_triage | mapping_suggestion */
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    promptSha: text('prompt_sha'),
    inputJson: jsonb('input_json').notNull(),
    outputJson: jsonb('output_json').notNull(),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('agent_invocation_run_idx').on(t.runId, t.createdAt)],
);
