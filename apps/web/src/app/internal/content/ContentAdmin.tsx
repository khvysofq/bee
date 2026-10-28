'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { ContentAdminRow } from '@/lib/content-admin';
import { fmtDate, sendJson } from '../admin-client';

const KIND_LABELS: Record<string, string> = {
  news_item: '新闻原料',
  news_digest: '日报',
  analysis: '分析',
  forecast: '预测',
};

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  hidden: '已隐藏',
};

const VISIBILITY_LABELS: Record<string, string> = {
  internal: '内部',
  public: '公开',
};

interface Filters {
  kind: string;
  status: string;
}

function hrefWith(filters: Filters, patch: Partial<Filters>): string {
  const next = { ...filters, ...patch };
  const params = new URLSearchParams();
  if (next.kind) params.set('kind', next.kind);
  if (next.status) params.set('status', next.status);
  const query = params.toString();
  return query ? `/internal/content?${query}` : '/internal/content';
}

export function ContentAdmin({
  rows,
  filters,
}: {
  rows: ContentAdminRow[];
  filters: Filters;
}): ReactNode {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  const changeStatus = async (row: ContentAdminRow, status: 'published' | 'hidden'): Promise<void> => {
    setBusyId(row.id);
    setError(null);
    const result = await sendJson(`/internal/api/content/${row.id}`, 'PATCH', { status });
    setBusyId(null);
    if (!result.ok) {
      setError({ id: row.id, message: result.message });
      return;
    }
    router.refresh();
  };

  return (
    <main className="container container-wide">
      <header className="brief-head">
        <div>
          <p className="eyebrow">bee · 运维 · 内容</p>
          <h1>内容审核</h1>
          <p className="sub">
            四种 kind 共表。发布/隐藏只改 status；<code>news_item</code> 是内部原料，visibility
            恒为 internal，不能对外公开。
          </p>
        </div>
        <div className="admin-filters" aria-label="内容过滤">
          <label>
            <span>kind</span>
            <select
              value={filters.kind}
              onChange={(event) => router.push(hrefWith(filters, { kind: event.target.value }))}
            >
              <option value="">全部</option>
              <option value="news_item">news_item</option>
              <option value="news_digest">news_digest</option>
              <option value="analysis">analysis</option>
              <option value="forecast">forecast</option>
            </select>
          </label>
          <label>
            <span>status</span>
            <select
              value={filters.status}
              onChange={(event) => router.push(hrefWith(filters, { status: event.target.value }))}
            >
              <option value="">全部</option>
              <option value="draft">draft</option>
              <option value="published">published</option>
              <option value="hidden">hidden</option>
            </select>
          </label>
          <span className="muted">共 {rows.length} 条</span>
        </div>
      </header>

      <section className="admin-section" aria-label="内容列表">
        {rows.length === 0 ? (
          <p className="empty-row">当前筛选下没有内容。</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>kind</th>
                  <th>标题</th>
                  <th>品类</th>
                  <th>地域</th>
                  <th>日期</th>
                  <th>visibility</th>
                  <th>status</th>
                  <th>body_md_key</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className="admin-badge admin-badge-kind">{KIND_LABELS[row.kind] ?? row.kind}</span>
                      <div className="muted admin-cell-sub">{row.kind}</div>
                      {row.kind === 'news_item' ? (
                        <div className="admin-cell-sub admin-label-internal">内部原料</div>
                      ) : null}
                    </td>
                    <td className="admin-title-cell">
                      <strong>{row.title}</strong>
                      {row.sourceName ? (
                        <div className="muted admin-cell-sub">来源：{row.sourceName}</div>
                      ) : null}
                    </td>
                    <td>
                      {row.categoryName}
                      <div className="muted admin-cell-sub">{row.categoryCode}</div>
                    </td>
                    <td>{row.regionName ?? '—'}</td>
                    <td className="admin-nowrap">{fmtDate(row.contentDate)}</td>
                    <td>
                      <span
                        className={`admin-badge ${
                          row.visibility === 'public' ? 'admin-badge-active' : 'admin-badge-draft'
                        }`}
                      >
                        {VISIBILITY_LABELS[row.visibility] ?? row.visibility}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`admin-badge admin-badge-${
                          row.status === 'published' ? 'active' : row.status === 'hidden' ? 'archived' : 'draft'
                        }`}
                      >
                        {STATUS_LABELS[row.status] ?? row.status}
                      </span>
                    </td>
                    <td>
                      {row.bodyMdKey ? (
                        <code className="admin-key" title={row.bodyMdKey}>
                          {row.bodyMdKey}
                        </code>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <div className="admin-actions">
                        {row.status !== 'published' ? (
                          <button
                            type="button"
                            disabled={busyId === row.id}
                            onClick={() => void changeStatus(row, 'published')}
                          >
                            {busyId === row.id ? '处理中…' : '发布'}
                          </button>
                        ) : null}
                        {row.status === 'published' ? (
                          <button
                            type="button"
                            className="admin-button-quiet"
                            disabled={busyId === row.id}
                            onClick={() => void changeStatus(row, 'hidden')}
                          >
                            {busyId === row.id ? '处理中…' : '隐藏'}
                          </button>
                        ) : null}
                        {error?.id === row.id ? (
                          <span className="admin-error">{error.message}</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}