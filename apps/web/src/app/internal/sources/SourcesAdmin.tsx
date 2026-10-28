'use client';

import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { SourceAdminRow } from '@/lib/sources-admin';
import { fmtDateTime, sendJson } from '../admin-client';

const TYPE_LABELS: Record<string, string> = {
  price: '价格',
  news: '新闻',
  analysis: '分析',
  mixed: '混合',
};

const ROBOTS_LABELS: Record<string, string> = {
  allowed: '允许',
  disallowed: '禁止',
  unknown: '未知',
};

const REDISTRIBUTION_LABELS: Record<string, string> = {
  none: '不可转载',
  internal_only: '仅内部',
  attribution: '署名转载',
  licensed: '已授权',
};

interface FormValues {
  id?: string;
  code: string;
  name: string;
  type: string;
  baseUrl: string;
  robotsStatus: string;
  redistribution: string;
  rateLimitSeconds: string;
  enabled: boolean;
}

const EMPTY: FormValues = {
  code: '',
  name: '',
  type: 'news',
  baseUrl: '',
  robotsStatus: 'unknown',
  redistribution: 'none',
  rateLimitSeconds: '60',
  enabled: true,
};

function valuesOf(row: SourceAdminRow): FormValues {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    baseUrl: row.baseUrl ?? '',
    robotsStatus: row.robotsStatus,
    redistribution: row.redistribution,
    rateLimitSeconds: String(row.rateLimitSeconds),
    enabled: row.enabled,
  };
}

function SourceForm({
  initial,
  mode,
  onSaved,
  onCancel,
}: {
  initial: FormValues;
  mode: 'create' | 'edit';
  onSaved: () => void;
  onCancel?: () => void;
}): ReactNode {
  const [values, setValues] = useState<FormValues>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof FormValues>(field: K, value: FormValues[K]): void => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      ...(values.id ? { id: values.id } : {}),
      code: values.code.trim(),
      name: values.name.trim(),
      type: values.type,
      baseUrl: values.baseUrl.trim() || null,
      robotsStatus: values.robotsStatus,
      redistribution: values.redistribution,
      rateLimitSeconds: Number.parseInt(values.rateLimitSeconds, 10),
      enabled: values.enabled,
    };
    const result = await sendJson('/internal/api/sources', 'POST', body);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setValues(EMPTY);
    onSaved();
  };

  return (
    <form className="admin-form" onSubmit={(event) => void submit(event)}>
      <div className="admin-form-grid">
        <label>
          <span>code</span>
          <input
            value={values.code}
            onChange={(event) => update('code', event.target.value)}
            disabled={mode === 'edit'}
            required
            pattern="[a-z0-9][a-z0-9._-]*"
            placeholder="example-news"
          />
        </label>
        <label>
          <span>名称</span>
          <input
            value={values.name}
            onChange={(event) => update('name', event.target.value)}
            required
            placeholder="示例新闻来源"
          />
        </label>
        <label>
          <span>类型</span>
          <select value={values.type} onChange={(event) => update('type', event.target.value)}>
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}（{value}）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>robots</span>
          <select
            value={values.robotsStatus}
            onChange={(event) => update('robotsStatus', event.target.value)}
          >
            {Object.entries(ROBOTS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}（{value}）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>转载口径</span>
          <select
            value={values.redistribution}
            onChange={(event) => update('redistribution', event.target.value)}
          >
            {Object.entries(REDISTRIBUTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}（{value}）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>限速（秒）</span>
          <input
            type="number"
            min={1}
            max={86400}
            value={values.rateLimitSeconds}
            onChange={(event) => update('rateLimitSeconds', event.target.value)}
          />
        </label>
        <label className="admin-form-wide">
          <span>base_url</span>
          <input
            value={values.baseUrl}
            onChange={(event) => update('baseUrl', event.target.value)}
            placeholder="https://example.com"
          />
        </label>
        <label className="admin-check">
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(event) => update('enabled', event.target.checked)}
          />
          <span>启用（任务调度只读取启用的来源）</span>
        </label>
      </div>
      <div className="admin-form-actions">
        <button type="submit" disabled={busy}>
          {busy ? '保存中…' : mode === 'create' ? '创建来源' : '保存修改'}
        </button>
        {onCancel ? (
          <button type="button" className="admin-button-quiet" onClick={onCancel} disabled={busy}>
            取消
          </button>
        ) : null}
        {error ? <span className="admin-error">{error}</span> : null}
      </div>
    </form>
  );
}

export function SourcesAdmin({ rows }: { rows: SourceAdminRow[] }): ReactNode {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = (): void => {
    setCreating(false);
    setEditingId(null);
    router.refresh();
  };

  return (
    <main className="container container-wide">
      <header className="brief-head">
        <div>
          <p className="eyebrow">bee · 运维 · 来源</p>
          <h1>来源管理</h1>
          <p className="sub">
            来源配置决定采集限速与转载口径。code 创建后不可修改；写操作全部落{' '}
            <code>admin_audit</code>。
          </p>
        </div>
        <div className="muted">共 {rows.length} 个来源</div>
      </header>

      <section className="admin-section" aria-label="来源操作">
        <div className="admin-toolbar">
          <button type="button" onClick={() => setCreating((value) => !value)}>
            {creating ? '收起新建表单' : '新建来源'}
          </button>
          {creating ? <span className="muted">code 只能包含小写字母、数字、点、下划线、连字符</span> : null}
        </div>
        {creating ? (
          <SourceForm
            initial={EMPTY}
            mode="create"
            onSaved={refresh}
            onCancel={() => setCreating(false)}
          />
        ) : null}
      </section>

      <section className="admin-section" aria-label="来源列表">
        {rows.length === 0 ? (
          <p className="empty-row">还没有来源。</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>code</th>
                  <th>名称</th>
                  <th>类型</th>
                  <th>robots</th>
                  <th>转载</th>
                  <th>限速</th>
                  <th>启用</th>
                  <th>任务数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Fragment key={row.id}>
                    <tr>
                      <td>
                        <code>{row.code}</code>
                      </td>
                      <td>
                        <strong>{row.name}</strong>
                        {row.baseUrl ? <div className="muted admin-cell-sub">{row.baseUrl}</div> : null}
                      </td>
                      <td>{TYPE_LABELS[row.type] ?? row.type}</td>
                      <td>{ROBOTS_LABELS[row.robotsStatus] ?? row.robotsStatus}</td>
                      <td>{REDISTRIBUTION_LABELS[row.redistribution] ?? row.redistribution}</td>
                      <td className="admin-nowrap">{row.rateLimitSeconds}s</td>
                      <td>
                        <span className={`admin-badge ${row.enabled ? 'admin-badge-active' : 'admin-badge-archived'}`}>
                          {row.enabled ? '启用' : '停用'}
                        </span>
                      </td>
                      <td>{row.jobCount}</td>
                      <td>
                        <button
                          type="button"
                          className="admin-button-quiet"
                          onClick={() => setEditingId((id) => (id === row.id ? null : row.id))}
                        >
                          {editingId === row.id ? '收起' : '编辑'}
                        </button>
                        <div className="muted admin-cell-sub">{fmtDateTime(row.updatedAt)}</div>
                      </td>
                    </tr>
                    {editingId === row.id ? (
                      <tr className="admin-edit-row">
                        <td colSpan={9}>
                          <SourceForm
                            initial={valuesOf(row)}
                            mode="edit"
                            onSaved={refresh}
                            onCancel={() => setEditingId(null)}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}