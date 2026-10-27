'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SearchItem } from '@/lib/market-types';

/**
 * 全站品类 / 合约搜索：索引由 RSC 一次传入，输入时纯前端过滤，不发请求。
 * 选中条目直达单品页；没有匹配时回车回总览并按关键词过滤。
 */
export function HeaderSearch(props: { items: SearchItem[] }) {
  const { items } = props;
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items.slice(0, 8);
    return items
      .filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(needle))
      .slice(0, 10);
  }, [items, query]);

  function select(item: SearchItem) {
    setOpen(false);
    setQuery('');
    router.push(item.href);
  }

  return (
    <div className="header-search">
      <svg className="header-search-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.4" />
        <path d="m10.4 10.4 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls="global-search-results"
        aria-label="搜索品类、规格或合约"
        placeholder="搜索品类 / 合约 / 品种"
        value={query}
        onFocus={() => {
          if (blurTimer.current) clearTimeout(blurTimer.current);
          setOpen(true);
        }}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, matches.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const item = matches[active];
            if (item) select(item);
            else if (query.trim()) router.push(`/?q=${encodeURIComponent(query.trim())}`);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open ? (
        <div className="search-pop" id="global-search-results" role="listbox">
          {matches.length === 0 ? (
            <p className="search-pop-empty">没有匹配的品类或合约。回车可按关键词过滤总览。</p>
          ) : (
            matches.map((item, index) => (
              <button
                key={`${item.href}-${item.label}`}
                type="button"
                role="option"
                aria-selected={index === active}
                className="search-pop-item"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => select(item)}
              >
                <span className="search-pop-label">{item.label}</span>
                <span className="search-pop-meta">{item.meta}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}