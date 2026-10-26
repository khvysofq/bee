import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { checkKindEnum, verdictEnum } from './_enums';
import { createdAt, pk } from './dictionary';
import { priceObservation } from './observation';
import { agentInvocation, pipelineRun } from './pipeline';

/**
 * 校验留痕（交付物六 · 校验半层）：append-only。
 *
 * 每一次校验动作（无论结论）都是一行。观测的 validation_status 只是「最新结论」，
 * 全部过程在这里——「可回溯 Agent 的判断依据」的物理形态。
 *
 * performed_by_ref 的格式约定：
 *   rule:<规则名>@<规则版本>         确定性规则，如 rule:cross_source@v1
 *   llm:<模型>+<prompt 版本>          Agent 判断，如 llm:glm-5.3+prompt@v3
 *   human:<Paperclip 用户 id>        人工覆盖（异常队列里的人）
 *
 * detail 必须包含判断依据：比较了哪些观测（id 列表）、阈值、统计量（环比/偏离度）、Agent 的理由摘要。
 */
export const validationResult = pgTable(
  'validation_result',
  {
    id: pk(),
    observationId: uuid('observation_id')
      .notNull()
      .references(() => priceObservation.id),
    checkKind: checkKindEnum('check_kind').notNull(),
    verdict: verdictEnum('verdict').notNull(),
    /** 判断依据：比较对象、阈值、统计量、理由摘要。 */
    detail: jsonb('detail').notNull(),
    /** rule | agent(llm) | human | system */
    performedByKind: text('performed_by_kind').notNull(),
    performedByRef: text('performed_by_ref').notNull(),
    runId: uuid('run_id').references(() => pipelineRun.id),
    /** Agent 调用留痕（llm_judgment 时关联，含模型/输入/输出全文）。 */
    agentInvocationId: uuid('agent_invocation_id').references(() => agentInvocation.id),
    /** 校验时使用的规则集版本（回放依据）。 */
    rulesVersion: text('rules_version'),
    createdAt: createdAt(),
  },
  (t) => [
    index('validation_result_observation_idx').on(t.observationId, t.createdAt),
    index('validation_result_verdict_idx').on(t.verdict),
  ],
);
