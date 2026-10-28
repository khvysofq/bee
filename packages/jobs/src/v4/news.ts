import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { v4, type BeeV4Db } from '@bee/db';
import { jobsFixtureRoot } from '../store-root';
import { dateInShanghai, isDateString } from './dates';
import {
  composeMarkdown,
  htmlToMarkdown,
  sha256Hex,
  truncateText,
  type ArticleExtraction,
} from './markdown';
import { keyFor, type MarkdownStorage } from './storage';

/**
 * 新闻入库：抓取/读取一篇文章 → Readability/Turndown → Markdown（含 frontmatter）
 * → 上传 S3 → 落 content(kind=news_item, visibility=internal)。
 *
 * 幂等：以 (source_id, url_hash) 去重；重复运行只增加 duplicate 计数，不新增行。
 */

const DEFAULT_UA = 'bee-monitor/0.1 (+news ingestion; contact: owner)';

export interface FetchNewsConfig {
  adapter?: string;
  target?: { url?: string; method?: string; headers?: Record<string, string> };
  content_date?: string;
  limits?: { timeout_s?: number };
}

export interface NewsStats {
  fetched: number;
  extracted: number;
  uploaded: number;
  inserted: number;
  duplicate: number;
  skipped: number;
  reasons: Record<string, number>;
}

export interface IngestNewsOptions {
  now: Date;
  storage: MarkdownStorage;
  fetchImpl?: typeof fetch;
}

export interface IngestNewsResult {
  stats: NewsStats;
  contentId: string | null;
  s3Key: string | null;
  title: string | null;
}

export function emptyNewsStats(): NewsStats {
  return {
    fetched: 0,
    extracted: 0,
    uploaded: 0,
    inserted: 0,
    duplicate: 0,
    skipped: 0,
    reasons: {},
  };
}

function bump(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

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
  config: FetchNewsConfig,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (url.startsWith('fixture://')) {
    return readFile(fixturePath(url.slice('fixture://'.length)), 'utf8');
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
  return body;
}

/** 去除 URL 片段；查询参数保持原样（当前来源无跟踪参数，暂不排序）。 */
export function canonicalUrl(url: string): string {
  return url.split('#')[0] ?? url;
}

/** 来源的再分发许可直接映射到 content.license（枚举值一致）。 */
function licenseFor(source: { redistribution: string }): string {
  const allowed = new Set(['none', 'internal_only', 'attribution', 'licensed']);
  return allowed.has(source.redistribution) ? source.redistribution : 'none';
}

function bodyWithTitle(extraction: ArticleExtraction): string {
  const titleLine = `# ${extraction.title}`;
  const markdown = extraction.markdown.trim();
  if (!markdown) throw new Error('正文为空：Readability 与 DOM 兜底都没有提取到内容');
  const firstLine = markdown.split('\n')[0]?.trim() ?? '';
  if (firstLine === titleLine) return markdown;
  return `${titleLine}\n\n${markdown}`;
}

export async function ingestNews(
  db: BeeV4Db,
  job: typeof v4.job.$inferSelect,
  runId: string,
  options: IngestNewsOptions,
): Promise<IngestNewsResult> {
  const stats = emptyNewsStats();

  if (!job.categoryId) throw new Error('新闻任务缺少品类：job.category_id 为空');
  if (!job.sourceId) throw new Error('新闻任务缺少来源：job.source_id 为空');

  const [category] = await db
    .select()
    .from(v4.category)
    .where(eq(v4.category.id, job.categoryId))
    .limit(1);
  if (!category) throw new Error(`品类不存在：${job.categoryId}`);

  const [source] = await db
    .select()
    .from(v4.source)
    .where(eq(v4.source.id, job.sourceId))
    .limit(1);
  if (!source) throw new Error(`来源不存在：${job.sourceId}`);

  const config = (job.config ?? {}) as FetchNewsConfig;
  const targetUrl = config.target?.url;
  if (!targetUrl) throw new Error('任务缺少抓取地址：config.target.url');
  if (config.content_date !== undefined && !isDateString(config.content_date)) {
    throw new Error(`config.content_date 不是 YYYY-MM-DD：${config.content_date}`);
  }

  const html = await readTarget(
    targetUrl,
    config,
    Math.max(1, Number(config.limits?.timeout_s ?? 60)) * 1000,
    options.fetchImpl ?? fetch,
  );
  stats.fetched = 1;

  const extraction = htmlToMarkdown(html, targetUrl);
  if (!extraction.textContent.trim()) throw new Error('提取结果没有正文文本');
  stats.extracted = 1;

  const contentDate = config.content_date ?? dateInShanghai(options.now);
  const url = canonicalUrl(targetUrl);
  const urlHash = sha256Hex(url);
  const license = licenseFor(source);
  const body = bodyWithTitle(extraction);
  const summary = truncateText(extraction.textContent || extraction.markdown, 160);

  // 先按业务唯一键检查：常见重跑不产生 S3 孤儿对象。
  const [existing] = await db
    .select({ id: v4.content.id })
    .from(v4.content)
    .where(
      and(
        eq(v4.content.kind, 'news_item'),
        eq(v4.content.sourceId, source.id),
        eq(v4.content.urlHash, urlHash),
      ),
    )
    .limit(1);
  if (existing) {
    stats.duplicate += 1;
    bump(stats.reasons, 'duplicate_url');
    return { stats, contentId: existing.id, s3Key: null, title: extraction.title };
  }

  const id = randomUUID();
  const s3Key = keyFor('news_item', category.code, contentDate, id);
  const markdown = composeMarkdown(
    {
      id,
      kind: 'news_item',
      category: category.nameCn,
      categoryCode: category.code,
      region: '全国',
      date: contentDate,
      sources: [source.code],
      license,
      generatedAt: options.now.toISOString(),
    },
    body,
  );

  const uploaded = await options.storage.putMarkdown(s3Key, markdown);
  stats.uploaded += 1;

  const inserted = await db
    .insert(v4.content)
    .values({
      id,
      categoryId: category.id,
      regionId: null,
      kind: 'news_item',
      title: extraction.title,
      summary,
      bodyMdKey: uploaded.key,
      bodySha256: uploaded.sha256,
      assets: [],
      meta: { extractor: extraction.extractor },
      contentDate,
      sourceId: source.id,
      url,
      urlHash,
      license,
      visibility: 'internal',
      status: 'published',
      publishedAt: options.now,
      runId,
    })
    .onConflictDoNothing()
    .returning({ id: v4.content.id });

  if (inserted.length === 0) {
    // 并发/竞态：另一条运行已插入同一 (source_id, url_hash)，删掉本次多余对象。
    await options.storage.delete(s3Key);
    stats.duplicate += 1;
    bump(stats.reasons, 'duplicate_url_race');
    return { stats, contentId: null, s3Key: null, title: extraction.title };
  }

  stats.inserted += 1;
  return { stats, contentId: id, s3Key, title: extraction.title };
}