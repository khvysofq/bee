/** 作业系统内部类型（ADR-0010 §2）。表结构见 packages/db/src/schema/jobs.ts。 */

export type JobType =
  | 'fetch_table'
  | 'fetch_article'
  | 'render_page'
  | 'extract_news'
  | 'analyze'
  | 'healthcheck';

export type JobTier = 'deterministic' | 'render' | 'agent';

export type JobRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead'
  | 'skipped'
  | 'policy_blocked';

export interface JobTarget {
  url: string;
  urls?: string[];
  method?: string;
  headers?: Record<string, string>;
  /** 单域每秒请求数上限。 */
  rps?: number;
}

export interface JobSchedule {
  cron: string;
  tz?: string;
  enabled?: boolean;
}

export interface JobMapping {
  table: string;
  data_class?: string;
  keys?: Record<string, string>;
}

export interface JobLimits {
  timeout_s: number;
  max_attempts: number;
  backoff_s: number[];
}

export interface JobPolicy {
  source_code: string;
  redistribution?: string;
}

export interface JobDefinition {
  code: string;
  type: JobType;
  tier: JobTier;
  target: JobTarget;
  goal: string;
  adapter: string | null;
  output_schema?: unknown;
  mapping: JobMapping;
  schedule: JobSchedule;
  limits: JobLimits;
  agent?: unknown;
  policy?: JobPolicy | null;
  priority: number;
  enabled: boolean;
  notes?: string | null;
}

export interface WorkerOptions {
  db: import('@bee/db').BeeDb;
  jobCode: string;
  /** cron 窗口；null = 手动触发（可重复执行）。 */
  scheduledFor?: Date | null;
  now?: Date;
  ingestUrl: string;
  ingestToken: string;
  workerId?: string;
  storeRoot?: string;
  /** 单次运行最多等待抓取完成的秒数（缺省取 job_def.limits.timeout_s）。 */
  timeoutSeconds?: number;
  /** 测试注入：替换真实 HTTP ingest。 */
  ingest?: (payload: import('@bee/pipeline').IngestPayload) => Promise<IngestResponse>;
  /** 测试注入：替换 fetch（真实站点永不在测试里被访问）。 */
  fetchImpl?: typeof fetch;
  allowJump?: boolean;
}

export interface IngestResponse {
  accepted: number;
  rejected: number;
  skipped: number;
  ids: string[];
  raw_fetch_id?: string;
}

/** 队列 payload：调度与手动触发都只传任务 code，执行细节一律从 job_def 读。 */
export interface QueueJobData {
  jobCode: string;
  scheduledFor: string | null;
  trigger: 'cron' | 'manual';
}

/**
 * pg-boss v12 的队列名只允许字母/数字/下划线/连字符/点/斜杠，冒号会被拒绝；
 * ADR 里的概念名是 job:run，落地名用 job.run。
 */
export const QUEUE_NAME = 'job.run';
export const DEFAULT_TZ = 'Asia/Shanghai';
export const INGEST_TIMEOUT_MS = 20_000;