/**
 * 采集作业 → 业务写入的唯一契约（ADR-0010）。
 *
 * worker/agent 只把「原文里读到的行」POST 给 /internal/ingest；业务表由 API 侧校验后写。
 * 这里只放类型，不放实现 —— 两侧（packages/jobs、apps/web）共用同一份字段定义。
 */

/** 内容寻址存档的引用：worker 已把原文写进 RAW_STORE_DIR，API 侧据此登记 raw_content/raw_fetch。 */
export interface IngestEvidenceRaw {
  sha256: string;
  /** 存储根内的相对路径（raw/YYYY/MM/DD/<sha>.bin）。 */
  ref: string;
  url: string;
  fetched_at: string;
  http_status: number;
  content_type?: string | null;
  bytes?: number | null;
}

/** 一行报价候选。字段名刻意贴原文（raw_*），数字由确定性解析得到，不含推断。 */
export interface IngestQuoteRow {
  dedupe_key: string;
  /** 不含日期的主键族，用于同 key 上一期值跳变比较。 */
  jump_key: string;
  source_row_index: number;
  raw_text: string;
  raw_category_text: string;
  raw_spec_text: string | null;
  raw_region_text: string | null;
  raw_province_text?: string | null;
  raw_price_type_text: string | null;
  raw_unit: string;
  price_low: number;
  price_high: number;
  quote_date: string;
  observed_at: string | null;
  change_text?: string | null;
}

export interface IngestPayload {
  job_run_id: string | null;
  kind: 'quote';
  source_code: string;
  rows: IngestQuoteRow[];
  evidence: {
    raw: IngestEvidenceRaw;
    adapter?: string;
    selector?: string;
  };
  /** 人工确认过的跳变例外；P0 默认 false。 */
  allow_jump?: boolean;
}

export const JOBS_EXTRACT_VERSION = 'jobs@1.0.0';