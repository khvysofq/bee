import type { Metadata } from 'next';
import Link from 'next/link';

/** 内部运维页外壳（GUA-33）：与用户界面隔离，不进入用户导航，搜索引擎不索引。 */
export const metadata: Metadata = {
  title: 'bee · 内部运维',
  robots: { index: false, follow: false },
};

export default function InternalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="internal-bar">
        <div className="internal-brand">
          bee / INTERNAL
          <span>内部页 · 不对用户展示</span>
        </div>
        <nav className="internal-nav" aria-label="内部导航">
          <Link href="/internal/ops">每日巡检</Link>
          <Link href="/internal/jobs">任务管理</Link>
          <Link href="/internal/status">数据状态</Link>
          <Link href="/">返回用户站</Link>
        </nav>
      </div>
      {children}
    </>
  );
}