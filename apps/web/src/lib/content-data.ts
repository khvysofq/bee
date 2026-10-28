import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { v4, type BeeDb } from '@bee/db';

/**
 * 用户侧内容读取。
 *
 * 元数据在 content 表，正文是 Garage / S3 上的 Markdown 对象（body_md_key）。
 * S3 读取失败时返回 null，页面显示「正文暂不可用」，不抛 500。
 * 只暴露 visibility=public 且 status=published 的内容。
 */

export interface ContentSummary {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  contentDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  categoryCode: string;
  categoryName: string;
  regionName: string | null;
  meta: Record<string, unknown>;
}

export interface ContentDetail extends ContentSummary {
  bodyMdKey: string | null;
  bodySha256: string | null;
  url: string | null;
  publishedAt: string | null;
}

export interface ListContentOptions {
  categoryId?: string;
  kind?: string;
  limit?: number;
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

const summaryShape = {
  id: v4.content.id,
  kind: v4.content.kind,
  title: v4.content.title,
  summary: v4.content.summary,
  contentDate: v4.content.contentDate,
  periodStart: v4.content.periodStart,
  periodEnd: v4.content.periodEnd,
  categoryCode: v4.category.code,
  categoryName: v4.category.nameCn,
  regionName: v4.region.name,
  meta: v4.content.meta,
} as const;

function toSummary(row: {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  contentDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  categoryCode: string;
  categoryName: string;
  regionName: string | null;
  meta: unknown;
}): ContentSummary {
  return { ...row, meta: parseMeta(row.meta) };
}

export async function listContent(
  database: BeeDb,
  options: ListContentOptions = {},
): Promise<ContentSummary[]> {
  const conditions: SQL[] = [
    eq(v4.content.visibility, 'public'),
    eq(v4.content.status, 'published'),
  ];
  if (options.categoryId) conditions.push(eq(v4.content.categoryId, options.categoryId));
  if (options.kind) conditions.push(eq(v4.content.kind, options.kind));

  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const rows = await database
    .select(summaryShape)
    .from(v4.content)
    .innerJoin(v4.category, eq(v4.category.id, v4.content.categoryId))
    .leftJoin(v4.region, eq(v4.region.id, v4.content.regionId))
    .where(and(...conditions))
    .orderBy(desc(v4.content.contentDate), desc(v4.content.createdAt))
    .limit(limit);

  return rows.map(toSummary);
}

export interface CategoryRef {
  id: string;
  code: string;
  name: string;
  description: string | null;
}

/** 按品类编码读取 active 品类；不存在时返回 null（页面据此 404）。 */
export async function getCategoryByCode(
  database: BeeDb,
  code: string,
): Promise<CategoryRef | null> {
  const [row] = await database
    .select({
      id: v4.category.id,
      code: v4.category.code,
      name: v4.category.nameCn,
      description: v4.category.description,
    })
    .from(v4.category)
    .where(and(eq(v4.category.code, code), eq(v4.category.status, 'active')))
    .limit(1);
  return row ?? null;
}

/** 品类历史内容归档：只取公开已发布的单一种类，按日期倒序。 */
export async function listCategoryContents(
  database: BeeDb,
  categoryId: string,
  kind: string,
  limit = 200,
): Promise<ContentSummary[]> {
  const capped = Math.min(Math.max(limit, 1), 200);
  const rows = await database
    .select(summaryShape)
    .from(v4.content)
    .innerJoin(v4.category, eq(v4.category.id, v4.content.categoryId))
    .leftJoin(v4.region, eq(v4.region.id, v4.content.regionId))
    .where(
      and(
        eq(v4.content.categoryId, categoryId),
        eq(v4.content.kind, kind),
        eq(v4.content.visibility, 'public'),
        eq(v4.content.status, 'published'),
      ),
    )
    .orderBy(desc(v4.content.contentDate), desc(v4.content.createdAt))
    .limit(capped);

  return rows.map(toSummary);
}

/** 归档 tab 的总数：与列表同样只统计公开已发布内容。 */
export async function countCategoryContents(
  database: BeeDb,
  categoryId: string,
  kind: string,
): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(v4.content)
    .where(
      and(
        eq(v4.content.categoryId, categoryId),
        eq(v4.content.kind, kind),
        eq(v4.content.visibility, 'public'),
        eq(v4.content.status, 'published'),
      ),
    );
  return row?.count ?? 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getContent(database: BeeDb, id: string): Promise<ContentDetail | null> {
  // 先挡掉非 UUID 路径，避免 Postgres uuid 转换报错被当成 500。
  if (!UUID_RE.test(id)) return null;
  const [row] = await database
    .select({
      ...summaryShape,
      bodyMdKey: v4.content.bodyMdKey,
      bodySha256: v4.content.bodySha256,
      url: v4.content.url,
      publishedAt: v4.content.publishedAt,
    })
    .from(v4.content)
    .innerJoin(v4.category, eq(v4.category.id, v4.content.categoryId))
    .leftJoin(v4.region, eq(v4.region.id, v4.content.regionId))
    .where(
      and(
        eq(v4.content.id, id),
        eq(v4.content.visibility, 'public'),
        eq(v4.content.status, 'published'),
      ),
    )
    .limit(1);
  if (!row) return null;

  return {
    ...toSummary(row),
    bodyMdKey: row.bodyMdKey,
    bodySha256: row.bodySha256,
    url: row.url,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

/* ------------------------------------------------------------------ */
/* S3 / Garage 正文读取                                                 */
/* ------------------------------------------------------------------ */

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

let envLoaded = false;

/** 仓库根 .env：Next 只自动加载 apps/web 下的 .env，这里补齐 monorepo 根配置。 */
function loadRepoEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  let current = path.resolve(process.cwd());
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      const candidate = path.join(current, '.env');
      if (!existsSync(candidate)) return;
      for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const text = line.trim();
        if (!text || text.startsWith('#')) continue;
        const index = text.indexOf('=');
        if (index <= 0) continue;
        const key = text.slice(0, index).trim();
        const value = text.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[key]) process.env[key] = value;
      }
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function resolveS3Config(): S3Config | null {
  loadRepoEnv();
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.S3_REGION?.trim() || 'garage',
  };
}

const globalForS3 = globalThis as unknown as {
  __beeContentS3?: { client: S3Client; bucket: string } | null;
};

function s3(): { client: S3Client; bucket: string } | null {
  if (globalForS3.__beeContentS3 !== undefined) return globalForS3.__beeContentS3;
  const config = resolveS3Config();
  if (!config) {
    globalForS3.__beeContentS3 = null;
    return null;
  }
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  globalForS3.__beeContentS3 = { client, bucket: config.bucket };
  return globalForS3.__beeContentS3;
}

/** 读取 Markdown 正文；任何失败（未配置 / 404 / 网络）都返回 null。 */
export async function readMarkdown(key: string | null | undefined): Promise<string | null> {
  if (!key?.trim()) return null;
  const store = s3();
  if (!store) return null;
  try {
    const result = await store.client.send(
      new GetObjectCommand({ Bucket: store.bucket, Key: key }),
    );
    const body = result.Body as { transformToString?: () => Promise<string> } | undefined;
    if (!body?.transformToString) return null;
    return await body.transformToString();
  } catch (error) {
    console.error('[content] readMarkdown failed', { key, error });
    return null;
  }
}

export const CONTENT_KINDS = ['news_digest', 'analysis', 'forecast'] as const;

export function contentKindLabel(kind: string): string {
  if (kind === 'news_digest') return '重大新闻';
  if (kind === 'analysis') return '行业分析';
  if (kind === 'forecast') return '预测研报';
  if (kind === 'news_item') return '新闻原料';
  return kind;
}

/** 渲染前去掉开头 YAML frontmatter（生成时写入，正文页不展示）。 */
export function stripFrontmatter(markdown: string): string {
  const match = /^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}