import Link from 'next/link';
import { db } from '@/db';
import { loadJobsData } from '@/lib/jobs-data';
import { JobsView } from '@/components/jobs/JobsView';

export const dynamic = 'force-dynamic';

export default async function InternalJobsPage() {
  let data: Awaited<ReturnType<typeof loadJobsData>> | null = null;
  let error: string | null = null;
  try {
    data = await loadJobsData(db);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (error) {
    return (
      <main className="container container-narrow">
        <h1>任务管理</h1>
        <div className="error">
          <p>任务数据读取失败：{error}</p>
          <p>
            先起库并应用迁移：<code>pnpm db:migrate</code>，再插入示例任务：<code>pnpm jobs:seed</code>。
          </p>
        </div>
      </main>
    );
  }

  if (!data) return null;
  return (
    <>
      <JobsView data={data} />
      <p className="container container-wide muted">
        <Link href="/internal/ops">← 每日巡检</Link> · <Link href="/internal/status">数据状态</Link>
      </p>
    </>
  );
}