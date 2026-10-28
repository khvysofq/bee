'use client';

import { Fragment, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { CategoryAdminRow } from '@/lib/categories-admin';
import { fmtDateTime, sendJson } from '../admin-client';

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  active: '启用',
  archived: '归档',
};

interface FormValues {
  id?: string;
  code: string;
  nameCn: string;
  nameEn: string;
  description: string;
  status: string;
  sortOrder: string;
}

const EMPTY: FormValues = {
  code: '',
  nameCn: '',
  nameEn: '',
  description: '',
  status: 'active',
  sortOrder: '0',
};

function valuesOf(row: CategoryAdminRow): FormValues {
  return {
    id: row.id,
    code: row.code,
    nameCn: row.nameCn,
    nameEn: row.nameEn ?? '',
    description: row.description ?? '',
    status: row.status,
    sortOrder: String(row.sortOrder),
  };
}

function CategoryForm({
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

  const update = (field: keyof FormValues, value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      ...(values.id ? { id: values.id } : {}),
      code: values.code.trim(),
      nameCn: values.nameCn.trim(),
      nameEn: values.nameEn.trim() || null,
      description: values.description.trim() || null,
      status: values.status,
      sortOrder: Number.parseInt(values.sortOrder, 10) || 0,
    };
    const result = await sendJson('/internal/api/categories', 'POST', body);
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
            pattern="[0-9a-z][0-9a-z-]*"
            placeholder="1110301"
          />
        </label>
        <label>
          <span>中文名称</span>
          <input
            value={values.nameCn}
            onChange={(event) => update('nameCn', event.target.value)}
            required
            placeholder="废不锈钢"
          />
        </label>
        <label>
          <span>英文名称</span>
          <input
            value={values.nameEn}
            onChange={(event) => update('nameEn', event.target.value)}
            placeholder="Stainless steel scrap"
          />
        </label>
        <label>
          <span>状态</span>
          <select value={values.status} onChange={(event) => update('status', event.target.value)}>
            <option value="draft">草稿</option>
            <option value="active">启用</option>
            <option value="archived">归档</option>
          </select>
        </label>
        <label>
          <span>排序</span>
          <input
            type="number"
            min={0}
            max={9999}
            value={values.sortOrder}
            onChange={(event) => update('sortOrder', event.target.value)}
          />
        </label>
        <label className="admin-form-wide">
          <span>描述</span>
          <textarea
            rows={2}
            value={values.description}
            onChange={(event) => update('description', event.target.value)}
            placeholder="品类说明（可留空）"
          />
        </label>
      </div>
      <div className="admin-form-actions">
        <button type="submit" disabled={busy}>
          {busy ? '保存中…' : mode === 'create' ? '创建品类' : '保存修改'}
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

export function CategoriesAdmin({ rows }: { rows: CategoryAdminRow[] }): ReactNode {
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
          <p className="eyebrow">bee · 运维 · 品类</p>
          <h1>品类管理</h1>
          <p className="sub">
            品类是 v4 的主轴。code 创建后不可修改；新增品类只插一行，不建表。
            写操作全部落 <code>admin_audit</code>。
          </p>
        </div>
        <div className="muted">共 {rows.length} 个品类</div>
      </header>

      <section className="admin-section" aria-label="品类操作">
        <div className="admin-toolbar">
          <button type="button" onClick={() => setCreating((value) => !value)}>
            {creating ? '收起新建表单' : '新建品类'}
          </button>
          {creating ? <span className="muted">code 只能包含小写字母、数字、连字符</span> : null}
        </div>
        {creating ? (
          <CategoryForm
            initial={EMPTY}
            mode="create"
            onSaved={refresh}
            onCancel={() => setCreating(false)}
          />
        ) : null}
      </section>

      <section className="admin-section" aria-label="品类列表">
        {rows.length === 0 ? (
          <p className="empty-row">还没有品类。</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>code</th>
                  <th>名称</th>
                  <th>状态</th>
                  <th>排序</th>
                  <th>规格数</th>
                  <th>价格行</th>
                  <th>内容数</th>
                  <th>更新时间</th>
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
                        <strong>{row.nameCn}</strong>
                        {row.nameEn ? <div className="muted admin-cell-sub">{row.nameEn}</div> : null}
                        {row.description ? (
                          <div className="muted admin-cell-sub">{row.description}</div>
                        ) : null}
                      </td>
                      <td>
                        <span className={`admin-badge admin-badge-${row.status}`}>
                          {STATUS_LABELS[row.status] ?? row.status}
                        </span>
                      </td>
                      <td>{row.sortOrder}</td>
                      <td>{row.specCount}</td>
                      <td>{row.priceCount}</td>
                      <td>{row.contentCount}</td>
                      <td className="admin-nowrap">{fmtDateTime(row.updatedAt)}</td>
                      <td>
                        <button
                          type="button"
                          className="admin-button-quiet"
                          onClick={() => setEditingId((id) => (id === row.id ? null : row.id))}
                        >
                          {editingId === row.id ? '收起' : '编辑'}
                        </button>
                      </td>
                    </tr>
                    {editingId === row.id ? (
                      <tr className="admin-edit-row">
                        <td colSpan={9}>
                          <CategoryForm
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