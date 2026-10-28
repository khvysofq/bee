import Link from 'next/link';
import { db } from '@/db';
import { CONTENT_KINDS, CONTENT_STATUSES, listContents } from '@/lib/content-admin';
import { ContentAdmin } from './ContentAdmin';

export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default async function InternalContentPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string | string[]; status?: string | string[] }>;
}) {
  const params = await searchParams;
  const kindParam = first(params.kind);
  const statusParam = first(params.status);
  const kind = (CONTENT_KINDS as readonly string[]).includes(kindParam) ? kindParam : '';
  const status = (CONTENT_STATUSES as readonly string[]).includes(statusParam) ? statusParam : '';

  let rows: Awaited<ReturnType<typeof listContents>> | null = null;
  let error: string | null = null;
  try {
    rows = await listContents(db, { kind: kind || undefined, status: status || undefined });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (error || !rows) {
    return (
      <main className="container container-wide">
        <h1>内容审核</h1>
        <div className="error">
          <p>内容数据读取失败：{error ?? '未知错误'}</p>
          <p>
            先起库并应用迁移：<code>pnpm db:migrate</code>，再插入 v4 种子：<code>pnpm db:seed</code>。
          </p>
        </div>
      </main>
    );
  }

  return (
    <>
      <ContentAdmin rows={rows} filters={{ kind, status }} />
      <p className="container container-wide muted">
        <Link href="/internal/jobs">← 任务管理</Link> · <Link href="/internal/categories">品类管理</Link> ·{' '}
        <Link href="/internal/sources">来源管理</Link>
      </p>
    </>
  );
}