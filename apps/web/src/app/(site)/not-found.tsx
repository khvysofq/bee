import Link from 'next/link';

export default function SiteNotFound() {
  return (
    <main className="terminal">
      <div className="shell">
        <div className="t-not-found">
          <h1>没有这个行情标的</h1>
          <p>链接可能已失效，或该序列不在对外展示范围内。可以回到行情总览重新选择。</p>
          <p style={{ marginTop: 'var(--space-4)' }}>
            <Link className="text-link" href="/">
              返回行情总览
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}