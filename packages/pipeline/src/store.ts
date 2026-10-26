import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function sha256Hex(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function resolveRawStoreRoot(explicit?: string): string {
  return path.resolve(explicit ?? process.env.RAW_STORE_DIR ?? './data/raw-store');
}

function assertSafeRef(ref: string): void {
  if (path.isAbsolute(ref) || ref.split(/[\\/]/).includes('..')) {
    throw new Error(`内容引用必须是存储根内的相对路径：${ref}`);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export interface StoredContent {
  contentSha256: string;
  contentRef: string;
  existed: boolean;
}

/**
 * 内容寻址写：同一 sha 在给定命名空间只落一份文件。
 * raw 内容按抓取日期分目录；抽取/回放工件按内容 sha 平铺。
 */
export async function storeContent(
  root: string,
  args: { namespace: 'raw' | 'work' | 'replay'; body: string; date?: Date },
): Promise<StoredContent> {
  const sha = sha256Hex(args.body);
  const suffix = args.namespace === 'raw' ? '.bin' : '.json';
  const day = args.date ?? new Date();
  const datePath = `${day.getUTCFullYear()}/${String(day.getUTCMonth() + 1).padStart(2, '0')}/${String(
    day.getUTCDate(),
  ).padStart(2, '0')}`;
  const contentRef =
    args.namespace === 'raw'
      ? path.posix.join('raw', datePath, `${sha}${suffix}`)
      : path.posix.join(args.namespace, `${sha}${suffix}`);
  const file = path.join(root, contentRef);
  await mkdir(path.dirname(file), { recursive: true });
  const already = await exists(file);
  if (!already) await writeFile(file, args.body, 'utf8');
  return { contentSha256: sha, contentRef, existed: already };
}

export async function readContent(root: string, ref: string): Promise<string> {
  assertSafeRef(ref);
  return readFile(path.join(root, ref), 'utf8');
}

export function contentPath(root: string, ref: string): string {
  assertSafeRef(ref);
  return path.join(root, ref);
}
