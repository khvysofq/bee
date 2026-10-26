/**
 * 管线 step 契约（P0-3 实现采集/规范化/校验/聚合/发布步骤时实现本接口）。
 *
 * 设计要点：step 是确定性的、版本化的、台账化的。每个 step：
 *  - 声明 kind 与版本（版本进 pipeline_run 的三 pin 体系）；
 *  - 输入输出一律用 id 引用（raw_fetch_ids / observation_ids / ...），不内联大对象；
 *  - 执行结果经 ledger 写入 pipeline_step（input_refs/output_refs/status/error）；
 *  - LLM 判断必须走 agent_invocation 留痕 + validation_result 落判断依据。
 */
export type StepKind =
  | 'fetch'
  | 'extract'
  | 'normalize'
  | 'validate'
  | 'aggregate'
  | 'publish'
  | 'notify';

/** 引用集：步骤间只传 id。 */
export interface StepRefs {
  rawFetchIds?: string[];
  observationIds?: string[];
  quoteIds?: string[];
  indicatorIds?: string[];
  exceptionIds?: string[];
  reportRef?: string;
  [key: string]: unknown;
}

export interface StepContext {
  runId: string;
  /** 本次运行的代码/规则/字典版本 pin。 */
  gitSha: string;
  rulesVersion: string;
  dictionaryHash: string;
}

export interface StepResult {
  status: 'succeeded' | 'failed' | 'skipped';
  outputRefs: StepRefs;
  logExcerpt?: string;
  error?: string;
}

export interface PipelineStep {
  kind: StepKind;
  version: string;
  execute(ctx: StepContext, input: StepRefs): Promise<StepResult>;
}
