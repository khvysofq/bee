import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import {
  storeContent,
  type IngestPayload,
  type IngestQuoteRow,
} from '@bee/pipeline';
import { getAdapter, type FengjCopperRow } from '../adapters';
import { SchemaMismatchError } from '../adapters/fengj-copper';
import { jobsFixtureRoot, resolveJobsStoreRoot } from '../store-root';
import type { IngestResponse } from '../types';

export const FETCH_TABLE_VERSION = 'fetch-table@1.0.0';
/**
 * 诚实标识的 UA：写明程序名、用途与联系方式，方便对方识别与联系。
 *
 * 实测（2026-10-27）：zs.fengj.com 对 `curl/*` 与带 `bot` 字样的 UA 返回 567 拦截页，
 * 对 `bee-monitor/0.1 (...)` 与浏览器 UA 返回 200。这里**不伪装浏览器**，
 * 只用一个对方愿意放行的诚实标识；一旦对方开始拦截，任务会记 failed 并告警，不换 UA 硬闯。
 */
const DEFAULT_UA = 'bee-monitor/0.1 (+price monitoring; contact: owner)';

export interface FetchTableContext {
  db: BeeDb;
  jobCode: string;
  runId: string;
  job: typeof dbSchema.jobDef.$inferSelect;
  ingestUrl: string;
  ingestToken: string;
  storeRoot?: string;
  timeoutMs: number;
  allowJump?: boolean;
  fetchImpl?: typeof fetch;
  ingest?: (payload: IngestPayload) => Promise<IngestResponse>;
  now?: Date;
}

export interface FetchTableOutcome {
  status: 'succeeded' | 'skipped' | 'failed' | 'policy_blocked';
  errorCode?: string;
  errorDetail?: string;
  httpStatus?: number;
  fetchedBytes?: number;
  rawFetchId?: string;
  accepted: number;
  rejected: number;
  skipped: number;
  rowCount: number;
  log: string[];
}

interface TargetShape {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  rps?: number;
}

/** 单域限速：进程内按域名记录上次请求时间；worker 常驻，足够 P0 使用。 */
const lastRequestAt = new Map<string, number>();

export function resetRateLimiter(): void {
  lastRequestAt.clear();
}

async function acquireSlot(domain: string, rps: number | undefined): Promise<void> {
  if (!rps || rps <= 0) return;
  const interval = 1000 / rps;
  const last = lastRequestAt.get(domain) ?? 0;
  const wait = last + interval - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt.set(domain, Date.now());
}

function fixturePath(name: string): string {
  const fixturesRoot = jobsFixtureRoot();
  const resolved = path.resolve(fixturesRoot, name);
  if (!resolved.startsWith(path.resolve(fixturesRoot) + path.sep)) {
    throw new Error(`fixture 名称越界：${name}`);
  }
  return resolved;
}

async function readTarget(
  target: TargetShape,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ body: string; httpStatus: number; contentType: string }> {
  const url = target.url;
  if (url.startsWith('fixture://')) {
    const name = url.slice('fixture://'.length);
    const body = await readFile(fixturePath(name), 'utf8');
    return { body, httpStatus: 200, contentType: 'text/html; charset=utf-8' };
  }
  if (url.startsWith('file://')) {
    const body = await readFile(fileURLToPath(url), 'utf8');
    return { body, httpStatus: 200, contentType: 'text/html; charset=utf-8' };
  }
  const domain = new URL(url).hostname;
  await acquireSlot(domain, target.rps);
  const response = await fetchImpl(url, {
    method: target.method ?? 'GET',
    headers: { 'user-agent': DEFAULT_UA, accept: 'text/html,application/xhtml+xml', ...(target.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  return {
    body,
    httpStatus: response.status,
    contentType: response.headers.get('content-type') ?? 'text/html',
  };
}

function dedupeKeyFor(sourceCode: string, row: FengjCopperRow): string {
  return [
    'quote',
    sourceCode,
    row.rawProvinceText ?? '',
    row.rawRegionText,
    row.rawCategoryText,
    row.rawSpecText ?? '',
    row.rawPriceTypeText,
    row.quoteDate,
  ].join('|');
}

function jumpKeyFor(sourceCode: string, row: FengjCopperRow): string {
  return [
    'quote',
    sourceCode,
    row.rawProvinceText ?? '',
    row.rawRegionText,
    row.rawCategoryText,
    row.rawSpecText ?? '',
    row.rawPriceTypeText,
  ].join('|');
}

function toIngestRow(sourceCode: string, row: FengjCopperRow): IngestQuoteRow {
  return {
    dedupe_key: dedupeKeyFor(sourceCode, row),
    jump_key: jumpKeyFor(sourceCode, row),
    source_row_index: row.sourceRowIndex,
    raw_text: row.rawText,
    raw_category_text: row.rawCategoryText,
    raw_spec_text: row.rawSpecText,
    raw_region_text: row.rawRegionText,
    raw_province_text: row.rawProvinceText,
    raw_price_type_text: row.rawPriceTypeText,
    raw_unit: row.rawUnit,
    price_low: row.priceLow,
    price_high: row.priceHigh,
    quote_date: row.quoteDate,
    // 观测日就是报价日：adapter 只在页面给了独立观测时间时才填 observedAt，
    // 漏了这一步会把整批价格落成 observed_at=null，时间线上就查不到了。
    observed_at: row.observedAt ?? row.quoteDate,
    change_text: row.changeText,
  };
}

/**
 * T1 执行器：policy 检查 → 抓取 → 原文存档 → adapter 解析 → POST /internal/ingest。
 *
 * 红线：本函数不写任何业务表（price_observation / daily_quote / series_point / news_item）。
 * 它只写存档文件，并把候选交给 HTTP API。
 */
export async function executeFetchTable(ctx: FetchTableContext): Promise<FetchTableOutcome> {
  const log: string[] = [];
  const target = ctx.job.target as TargetShape;
  const policyCode = (ctx.job.policy as { source_code?: string } | null)?.source_code;
  if (!policyCode) {
    return {
      status: 'policy_blocked',
      errorCode: 'policy_missing',
      errorDetail: 'job_def.policy.source_code 缺失，拒绝抓取',
      accepted: 0,
      rejected: 0,
      skipped: 0,
      rowCount: 0,
      log,
    };
  }

  const [policy] = await ctx.db
    .select()
    .from(dbSchema.sourcePolicy)
    .where(eq(dbSchema.sourcePolicy.sourceCode, policyCode))
    .limit(1);
  if (!policy) {
    return {
      status: 'policy_blocked',
      errorCode: 'policy_missing',
      errorDetail: `source_policy 未登记 ${policyCode}，拒绝抓取`,
      accepted: 0,
      rejected: 0,
      skipped: 0,
      rowCount: 0,
      log,
    };
  }
  if (policy.loginWall === true || policy.redistribution === 'none') {
    return {
      status: 'policy_blocked',
      errorCode: 'policy_blocked',
      errorDetail: `login_wall=${policy.loginWall ?? false}, redistribution=${policy.redistribution}`,
      accepted: 0,
      rejected: 0,
      skipped: 0,
      rowCount: 0,
      log,
    };
  }

  const fetchImpl = ctx.fetchImpl ?? fetch;
  const fetchedAt = ctx.now ?? new Date();
  let document: { body: string; httpStatus: number; contentType: string };
  try {
    document = await readTarget(target, ctx.timeoutMs, fetchImpl);
  } catch (error) {
    return {
      status: 'skipped',
      errorCode: error instanceof Error && error.name === 'TimeoutError' ? 'fetch_timeout' : 'fetch_error',
      errorDetail: String(error),
      accepted: 0,
      rejected: 0,
      skipped: 0,
      rowCount: 0,
      log,
    };
  }
  log.push(`step=fetch url=${target.url} status=${document.httpStatus} bytes=${Buffer.byteLength(document.body, 'utf8')}`);
  if (document.httpStatus === 404) {
    return {
      status: 'skipped',
      errorCode: 'source_not_updated',
      errorDetail: '404：源未更新（正常空跑）',
      httpStatus: 404,
      fetchedBytes: 0,
      accepted: 0,
      rejected: 0,
      skipped: 0,
      rowCount: 0,
      log,
    };
  }
  if (document.httpStatus < 200 || document.httpStatus >= 300) {
    return {
      status: 'skipped',
      errorCode: 'http_error',
      errorDetail: `HTTP ${document.httpStatus}`,
      httpStatus: document.httpStatus,
      fetchedBytes: Buffer.byteLength(document.body, 'utf8'),
      accepted: 0,
      rejected: 0,
      skipped: 0,
      rowCount: 0,
      log,
    };
  }

  const storeRoot = resolveJobsStoreRoot(ctx.storeRoot);
  const stored = await storeContent(storeRoot, { namespace: 'raw', body: document.body, date: fetchedAt });
  const bytes = Buffer.byteLength(document.body, 'utf8');
  log.push(`step=archive sha=${stored.contentSha256.slice(0, 12)} ref=${stored.contentRef} bytes=${bytes}`);

  let rows: FengjCopperRow[];
  try {
    if (!ctx.job.adapter) throw new SchemaMismatchError('job_def.adapter 为空，T1 无法解析');
    rows = getAdapter(ctx.job.adapter).parse(document.body);
  } catch (error) {
    const code = error instanceof SchemaMismatchError ? 'schema_mismatch' : 'adapter_error';
    return {
      // 解析失败不是「今天没数据」，是可恢复的故障：要出现在运维页与失败率里，
      // 后续按 ADR-0010 的升级规则转 T3 或人工处理。skipped 只留给非交易日/源未更新。
      status: 'failed',
      errorCode: code,
      errorDetail: String(error),
      httpStatus: document.httpStatus,
      fetchedBytes: bytes,
      accepted: 0,
      rejected: 0,
      skipped: 0,
      rowCount: 0,
      log: [...log, `step=parse failed code=${code}`],
    };
  }
  log.push(`step=parse adapter=${ctx.job.adapter} rows=${rows.length}`);

  const sourceCode = policyCode;
  const payload: IngestPayload = {
    job_run_id: ctx.runId,
    kind: 'quote',
    source_code: sourceCode,
    rows: rows.map((row) => toIngestRow(sourceCode, row)),
    evidence: {
      raw: {
        sha256: stored.contentSha256,
        ref: stored.contentRef,
        url: target.url,
        fetched_at: fetchedAt.toISOString(),
        http_status: document.httpStatus,
        content_type: document.contentType,
        bytes,
      },
      adapter: ctx.job.adapter ?? undefined,
      selector: 'table',
    },
    allow_jump: ctx.allowJump ?? false,
  };

  let ingested: IngestResponse;
  try {
    if (ctx.ingest) {
      ingested = await ctx.ingest(payload);
    } else {
      const response = await fetchImpl(`${ctx.ingestUrl.replace(/\/$/, '')}/internal/ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ctx.ingestToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`ingest HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      ingested = JSON.parse(text) as IngestResponse;
    }
  } catch (error) {
    return {
      // ingest 失败 = 本地已抓到、存档也在，只是没写进库：必须记 failed，
      // 否则任务看起来「今天没事」，数据其实丢了。
      status: 'failed',
      errorCode: 'ingest_failed',
      errorDetail: String(error),
      httpStatus: document.httpStatus,
      fetchedBytes: bytes,
      accepted: 0,
      rejected: 0,
      skipped: 0,
      rowCount: rows.length,
      log: [...log, 'step=ingest failed'],
    };
  }
  log.push(
    `step=ingest accepted=${ingested.accepted} rejected=${ingested.rejected} skipped=${ingested.skipped ?? 0}`,
  );

  return {
    status: 'succeeded',
    httpStatus: document.httpStatus,
    fetchedBytes: bytes,
    rawFetchId: ingested.raw_fetch_id,
    accepted: ingested.accepted,
    rejected: ingested.rejected,
    skipped: ingested.skipped ?? 0,
    rowCount: rows.length,
    log,
  };
}