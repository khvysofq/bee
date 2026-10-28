import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { config as loadDotenv } from 'dotenv';
import { findRepoRoot } from '../store-root';

/**
 * 正文对象存储（Garage S3 兼容）。
 *
 * 库里只存 body_md_key / body_sha256；正文一直是 Markdown 对象。
 * key 里带 category_code 与日期，便于按品类/时间浏览与生命周期清理。
 */

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const CONTENT_KINDS = new Set(['news_item', 'news_digest', 'analysis', 'forecast']);

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}（检查仓库根 .env）`);
  return value;
}

/** 仓库根 .env 只加载一次；已存在的环境变量优先，不覆盖。 */
let envLoaded = false;
function loadRepoEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const candidate = path.join(findRepoRoot(), '.env');
  if (existsSync(candidate)) loadDotenv({ path: candidate });
}

export function resolveS3Config(): S3Config {
  loadRepoEnv();
  return {
    endpoint: requireEnv('S3_ENDPOINT'),
    region: process.env.S3_REGION?.trim() || 'garage',
    bucket: requireEnv('S3_BUCKET'),
    accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
  };
}

/** 简单冒烟：缺任一 S3_* 变量时返回 false，不抛错。 */
export function isS3Configured(): boolean {
  try {
    resolveS3Config();
    return true;
  } catch {
    return false;
  }
}

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * content/<kind>/<categoryCode>/<yyyy>/<mm>/<dd>/<id>.md
 *
 * date 必须是 YYYY-MM-DD；非法值直接报错，避免写出畸形 key。
 */
export function keyFor(kind: string, categoryCode: string, date: string, id: string): string {
  if (!CONTENT_KINDS.has(kind)) throw new Error(`未知内容类型：${kind}`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`日期格式不合法：${date}`);
  if (!/^[a-zA-Z0-9_-]+$/.test(categoryCode)) {
    throw new Error(`品类编码不合法：${categoryCode}`);
  }
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`内容 id 不合法：${id}`);
  return `content/${kind}/${categoryCode}/${match[1]}/${match[2]}/${match[3]}/${id}.md`;
}

export interface PutMarkdownResult {
  key: string;
  size: number;
  sha256: string;
  etag: string | null;
}

export interface HeadObjectResult {
  exists: boolean;
  size?: number;
  contentType?: string;
  etag?: string;
}

export class MarkdownStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async putMarkdown(key: string, markdown: string): Promise<PutMarkdownResult> {
    const body = Buffer.from(markdown, 'utf8');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'text/markdown; charset=utf-8',
        Metadata: { sha256 },
      }),
    );
    return {
      key,
      size: body.byteLength,
      sha256,
      etag: result.ETag?.replaceAll('"', '') ?? null,
    };
  }

  async headObject(key: string): Promise<HeadObjectResult> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        exists: true,
        size: result.ContentLength,
        contentType: result.ContentType,
        etag: result.ETag?.replaceAll('"', ''),
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === 'NotFound') {
        return { exists: false };
      }
      throw error;
    }
  }

  async getText(key: string): Promise<string> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = result.Body as { transformToString?: () => Promise<string> } | undefined;
    if (!body?.transformToString) throw new Error(`无法读取对象正文：${key}`);
    return body.transformToString();
  }

  /** 仅用于失败清理 / 测试；正常幂等重跑会覆盖同 key。 */
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  close(): void {
    this.client.destroy();
  }
}

/** CLI 入口使用的默认存储（配置缺失时抛出带指引的错误）。 */
export function createMarkdownStorage(): MarkdownStorage {
  const config = resolveS3Config();
  return new MarkdownStorage(createS3Client(config), config.bucket);
}