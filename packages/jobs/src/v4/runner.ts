import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createV4Db, resolveV4DatabaseUrl, v4, type BeeV4Db } from '@bee/db';
import { getAdapter, SchemaMismatchError } from '../adapters';
import { jobsFixtureRoot } from '../store-root';
import {
  ingestPriceRows,
  type PriceJobConfig,
  type PriceRunStats,
} from './price-ingest';

/**
 * v4 价格采集执行器（CLI 先跑通，不接 pg-boss）。
 *
 * 读 job → 抓取（fixture:// 或 HTTP）→ 适配器解析 → 映射 category/spec/region
 * → 逐行 upsert price_daily → 写 job_run。
 */

const DEFAULT_UA = 'bee-monitor/0.1 (+price monitoring; contact: owner)';

export interface RunPriceJobOptions {
  jobCode: string;
  /** 测试用：固定运行时刻（started_at / captured_at / price 落库时间）。 */
  now?: Date;
  fetchImpl?: typeof fetch;
  db?: BeeV4Db;
}

export interface PriceRunResult {
  jobRunId: string;
  jobCode: string;
  status: 'succeeded' | 'failed';
  error: string | null;
  stats: PriceRunStats;
}

const EMPTY_STATS = (): PriceRunStats => ({
  fetched: 0,
  parsed: 0,
  upserted: 0,
  skipped: 0,
  reasons: {},
});

function fixturePath(name: string): string {
  const root = path.resolve(jobsFixtureRoot());
  const resolved = path.resolve(root, name);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`fixture 名称越界：${name}`);
  }
  return resolved;
}

async function readTarget(
  url: string,
  config: PriceJobConfig,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ body: string; httpStatus: number }> {
  if (url.startsWith('fixture://')) {
    const name = url.slice('fixture://'.length);
    return { body: await readFile(fixturePath(name), 'utf8'), httpStatus: 200 };
  }

  const response = await fetchImpl(url, {
    method: config.target?.method ?? 'GET',
    headers: {
      'user-agent': DEFAULT_UA,
      accept: 'text/html,application/xhtml+xml',
      ...(config.target?.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`抓取失败：HTTP ${response.status}（${url}）`);
  }
  return { body, httpStatus: response.status };
}

export async function runPriceJob(options: RunPriceJobOptions): Promise<PriceRunResult> {
  const now = options.now ?? new Date();
  const db = options.db ?? createV4Db(resolveV4DatabaseUrl());
  const ownsDb = !options.db;

  try {
    const [job] = await db
      .select()
      .from(v4.job)
      .where(eq(v4.job.code, options.jobCode))
      .limit(1);
    // 任务不存在时不建 job_run：没有 job_id 可挂，直接让 CLI 报错退出。
    if (!job) throw new Error(`任务不存在：${options.jobCode}`);

    const [run] = await db
      .insert(v4.jobRun)
      .values({
        jobId: job.id,
        scheduledFor: null,
        startedAt: now,
        status: 'running',
        attempt: 1,
        stats: EMPTY_STATS(),
      })
      .returning();
    if (!run) throw new Error('创建 job_run 失败');

    const config = (job.config ?? {}) as PriceJobConfig;
    let stats = EMPTY_STATS();
    let status: 'succeeded' | 'failed' = 'failed';
    let error: string | null = null;

    try {
      const categoryCode = config.category_code;
      let category: typeof v4.category.$inferSelect | undefined;
      if (categoryCode) {
        [category] = await db
          .select()
          .from(v4.category)
          .where(eq(v4.category.code, categoryCode))
          .limit(1);
        if (!category) throw new Error(`品类不存在：${categoryCode}`);
        if (job.categoryId && job.categoryId !== category.id) {
          throw new Error(`job.category_id 与 config.category_code（${categoryCode}）不一致`);
        }
      } else if (job.categoryId) {
        [category] = await db
          .select()
          .from(v4.category)
          .where(eq(v4.category.id, job.categoryId))
          .limit(1);
      }
      if (!category) throw new Error('任务缺少品类：config.category_code 与 category_id 均为空');

      let sourceId: string | null = null;
      if (job.sourceId) {
        const [source] = await db
          .select()
          .from(v4.source)
          .where(eq(v4.source.id, job.sourceId))
          .limit(1);
        if (!source) throw new Error(`来源不存在：${job.sourceId}`);
        sourceId = source.id;
      }

      const targetUrl = config.target?.url;
      if (!targetUrl) throw new Error('任务缺少抓取地址：config.target.url');
      if (!config.adapter) throw new Error('任务缺少适配器：config.adapter');

      const timeoutMs = Math.max(1, Number(config.limits?.timeout_s ?? 60)) * 1000;
      const document = await readTarget(
        targetUrl,
        config,
        timeoutMs,
        options.fetchImpl ?? fetch,
      );

      const rows = getAdapter(config.adapter).parse(document.body);

      const specs = await db
        .select()
        .from(v4.spec)
        .where(and(eq(v4.spec.categoryId, category.id), eq(v4.spec.status, 'active')));
      const regions = await db
        .select()
        .from(v4.region)
        .where(eq(v4.region.status, 'active'));

      const ingested = await ingestPriceRows(db, rows, {
        category,
        specs,
        regions,
        sourceId,
        rawUrl: targetUrl,
        now,
        config,
      });
      stats = ingested.stats;
      status = 'succeeded';
    } catch (caught) {
      error =
        caught instanceof SchemaMismatchError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : String(caught);
      const reasonKey = caught instanceof SchemaMismatchError ? 'schema_mismatch' : 'run_error';
      stats.reasons[reasonKey] = (stats.reasons[reasonKey] ?? 0) + 1;
    }

    const finishedAt = options.now ?? new Date();
    await db
      .update(v4.jobRun)
      .set({ status, finishedAt, error, stats })
      .where(eq(v4.jobRun.id, run.id));

    return { jobRunId: run.id, jobCode: job.code, status, error, stats };
  } finally {
    if (ownsDb) await db.$client.end();
  }
}