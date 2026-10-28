import Link from 'next/link';
import { db } from '@/db';
import { listSources } from '@/lib/sources-admin';
import { SourcesAdmin } from './SourcesAdmin';

export const dynamic = 'force-dynamic';

export default async function InternalSourcesPage() {
  let rows: Awaited<ReturnType<typeof listSources>> | null = null;
  let error: string | null = null;
  try {
    rows = await listSources(db);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (error || !rows) {
    return (
      <main className="container container-wide">
        <h1>来源管理</h1>
        <div className="error">
          <p>来源数据读取失败：{error ?? '未知错误'}</p>
          <p>
            先起库并应用迁移：<code>pnpm db:migrate</code>，再插入 v4 种子：<code>pnpm db:seed</code>。
          </p>
        </div>
      </main>
    );
  }

  return (
    <>
      <SourcesAdmin rows={rows} />
      <p className="container container-wide muted">
        <Link href="/internal/jobs">← 任务管理</Link> · <Link href="/internal/categories">品类管理</Link> ·{' '}
        <Link href="/internal/content">内容审核</Link>
      </p>
    </>
  );
}