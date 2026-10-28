import Link from 'next/link';
import { db } from '@/db';
import { listCategories } from '@/lib/categories-admin';
import { CategoriesAdmin } from './CategoriesAdmin';

export const dynamic = 'force-dynamic';

export default async function InternalCategoriesPage() {
  let rows: Awaited<ReturnType<typeof listCategories>> | null = null;
  let error: string | null = null;
  try {
    rows = await listCategories(db);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (error || !rows) {
    return (
      <main className="container container-wide">
        <h1>品类管理</h1>
        <div className="error">
          <p>品类数据读取失败：{error ?? '未知错误'}</p>
          <p>
            先起库并应用迁移：<code>pnpm db:migrate</code>，再插入 v4 种子：<code>pnpm db:seed</code>。
          </p>
        </div>
      </main>
    );
  }

  return (
    <>
      <CategoriesAdmin rows={rows} />
      <p className="container container-wide muted">
        <Link href="/internal/jobs">← 任务管理</Link> · <Link href="/internal/sources">来源管理</Link> ·{' '}
        <Link href="/internal/content">内容审核</Link>
      </p>
    </>
  );
}