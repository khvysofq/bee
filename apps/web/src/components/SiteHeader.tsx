'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * 全站统一导航（GUA-29 视觉改版 v1）：wordmark + 四个入口。
 * 纯视觉层组件，不接数据；三页 + ops 用同一节奏。
 */

const NAV_ITEMS = [
  { href: '/', label: '行情速览' },
  { href: '/briefing', label: '每日简报' },
  { href: '/ops', label: '巡检 / 异常' },
  { href: '/status', label: '数据底座状态' },
];

export function Wordmark() {
  return (
    <span className="wordmark-mark" aria-hidden="true">
      <svg width="26" height="30" viewBox="0 0 26 30" fill="none">
        <path
          d="M13 1 24.3 7.5v15L13 29 1.7 22.5v-15L13 1Z"
          fill="var(--color-ink-900)"
        />
        <path d="M13 8.5 18.8 19H7.2L13 8.5Z" fill="var(--color-on-ink)" />
      </svg>
    </span>
  );
}

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link className="wordmark" href="/">
          <Wordmark />
          <span>
            <span className="wordmark-name">bee</span>
            <span className="wordmark-tagline">再生物资行情</span>
          </span>
        </Link>
        <nav className="site-nav" aria-label="全站导航">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? 'active' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
