import { eq } from 'drizzle-orm';
import { createV4Db, resolveV4DatabaseUrl, v4, type BeeV4Db } from '@bee/db';
import { ingestNews, emptyNewsStats, type NewsStats } from './news';
import { generateContent, emptyGenerateStats, type GenerateStats } from './generate';
import { createMarkdownStorage, type MarkdownStorage } from './storage';

/**
 * v4 内容任务执行器：按 job.kind 分派 news / digest / analysis / forecast。
 *
 * 与价格 runner 一样：先建 job_run(running)，结束后写 status/stats/error/finished_at。
 * 不接 pg-boss / scheduler，仅由 CLI 手工触发。
 */

export type ContentStats = NewsStats | GenerateStats;

export interface RunContentJobOptions {
  jobCode: string;
  /** 测试用：固定运行时刻。 */
  now?: Date;
  fetchImpl?: typeof fetch;
  db?: BeeV4Db;
  storage?: MarkdownStorage;
}

export interface ContentRunResult {
  jobRunId: string;
  jobCode: string;
  jobKind: string;
  status: 'succeeded' | 'failed';
  error: string | null;
  stats: ContentStats;
  contentId: string | null;
  s3Key: string | null;
  title: string | null;
}

function emptyStats(): ContentStats {
  return emptyNewsStats();
}

export async function runContentJob(options: RunContentJobOptions): Promise<ContentRunResult> {
  const now = options.now ?? new Date();
  const db = options.db ?? createV4Db(resolveV4DatabaseUrl());
  const ownsDb = !options.db;
  const storage = options.storage ?? createMarkdownStorage();
  const ownsStorage = !options.storage;

  try {
    const [job] = await db.select().from(v4.job).where(eq(v4.job.code, options.jobCode)).limit(1);
    // 任务不存在时不建 job_run：没有 job_id 可挂。
    if (!job) throw new Error(`任务不存在：${options.jobCode}`);

    if (job.kind === 'fetch_price') {
      throw new Error(`任务 ${job.code} 是 fetch_price，请使用 pnpm --filter @bee/jobs run:price`);
    }

    const [run] = await db
      .insert(v4.jobRun)
      .values({
        jobId: job.id,
        scheduledFor: null,
        startedAt: now,
        status: 'running',
        attempt: 1,
        stats: emptyStats(),
      })
      .returning();
    if (!run) throw new Error('创建 job_run 失败');

    let stats: ContentStats = emptyStats();
    let status: 'succeeded' | 'failed' = 'failed';
    let error: string | null = null;
    let contentId: string | null = null;
    let s3Key: string | null = null;
    let title: string | null = null;

    try {
      if (job.kind === 'fetch_news') {
        const result = await ingestNews(db, job, run.id, {
          now,
          storage,
          fetchImpl: options.fetchImpl,
        });
        stats = result.stats;
        contentId = result.contentId;
        s3Key = result.s3Key;
        title = result.title;
      } else if (job.kind === 'digest' || job.kind === 'analysis' || job.kind === 'forecast') {
        const result = await generateContent(db, job, run.id, { now, storage });
        stats = result.stats;
        contentId = result.contentId;
        s3Key = result.s3Key;
        title = result.title;
      } else {
        throw new Error(`未知任务类型：${job.kind}`);
      }
      status = 'succeeded';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      const reasons = stats.reasons;
      reasons.run_error = (reasons.run_error ?? 0) + 1;
    }

    const finishedAt = options.now ?? new Date();
    await db
      .update(v4.jobRun)
      .set({ status, finishedAt, error, stats })
      .where(eq(v4.jobRun.id, run.id));

    return {
      jobRunId: run.id,
      jobCode: job.code,
      jobKind: job.kind,
      status,
      error,
      stats,
      contentId,
      s3Key,
      title,
    };
  } finally {
    if (ownsStorage) storage.close();
    if (ownsDb) await db.$client.end();
  }
}