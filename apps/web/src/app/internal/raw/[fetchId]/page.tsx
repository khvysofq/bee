import Link from 'next/link';
import { ARCHIVE_UNAVAILABLE_MESSAGE } from '@/lib/archive';

export const dynamic = 'force-dynamic';

/**
 * 原始存档查看器（v4 停用）。
 * 原始 HTML 归档已移到 OSS raw/；库内存档查看器尚未实现，保留路由并给出明确提示。
 */
export default async function RawArchivePage(props: { params: Promise<{ fetchId: string }> }) {
  const { fetchId } = await props.params;

  return (
    <main className="container container-narrow">
      <p className="eyebrow">原始存档查看器</p>
      <h1>库内存档查看已停用</h1>
      <p className="sub">{ARCHIVE_UNAVAILABLE_MESSAGE}</p>
      <p className="muted">
        抓取引用：<code>{fetchId}</code>
      </p>
      <p className="foot">
        <Link href="/internal/ops">← 返回内部运维</Link>
      </p>
    </main>
  );
}