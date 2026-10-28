'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { HeaderSearch } from './HeaderSearch';
import { QaDrawer } from './QaDrawer';
import { Wordmark } from './Brand';
import type { SearchItem } from '@/lib/market-types';

/**
 * 全站头部（行情台 v3）：行情 / 推演 / 问答 + 全局品类搜索。
 * 右侧问答抽屉全站可开；内部运维页走 /internal/*，不套用此壳。
 */

const NAV_ITEMS = [
  { href: '/', label: '行情', exact: true },
  { href: '/outlook', label: '推演' },
  { href: '/qa', label: '问答' },
];

export function SiteHeader(props: { searchItems: SearchItem[] }) {
  const pathname = usePathname();
  const [qaOpen, setQaOpen] = useState(false);

  return (
    <>
      <header className="site-header">
        <div className="site-header-inner">
          <Link className="brand" href="/" aria-label="bee 再生物资行情 · 返回行情">
            <Wordmark />
          </Link>
          <nav className="site-nav" aria-label="三大核心功能">
            {NAV_ITEMS.map((item) => {
              const active = item.exact
                ? pathname === item.href ||
                  pathname.startsWith('/m/') ||
                  pathname.startsWith('/c/') ||
                  pathname.startsWith('/content/')
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
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
          <div className="header-tools">
            <span className="w-live" title="日频报价 · 服务端直出">
              <span className="w-live-dot" aria-hidden="true" />
              LINK · 日频
            </span>
            <HeaderSearch items={props.searchItems} />
            <button className="header-qa" type="button" onClick={() => setQaOpen(true)}>
              问一问
            </button>
          </div>
        </div>
      </header>

      {!qaOpen ? (
        <button className="qa-fab" type="button" onClick={() => setQaOpen(true)}>
          问答
        </button>
      ) : null}

      <QaDrawer open={qaOpen} onClose={() => setQaOpen(false)} />
    </>
  );
}