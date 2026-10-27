'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark } from './Brand';

/**
 * 用户侧全站导航（GUA-33）：品牌 + 三大核心功能，不出现内部入口。
 * 内部运维页走 /internal/*，有自己的独立导航，不在此出现。
 */

const NAV_ITEMS = [
  { href: '/market', label: '行情数据' },
  { href: '/outlook', label: '趋势推演' },
  { href: '/qa', label: '行业问答' },
];

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link className="brand" href="/" aria-label="bee 再生物资行情 · 返回首页">
          <Wordmark />
        </Link>
        <nav className="site-nav" aria-label="三大核心功能">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? 'active' : undefined}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}