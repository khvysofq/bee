'use client';

import { useState, type ReactNode } from 'react';

/**
 * 管理页交互组件：全部经 /internal/api/* 发请求，不在 server action 里直接写库。
 * 操作成功后刷新整页数据（最朴素也最不容易出现半截状态）。
 */

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; message: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // 非 JSON 响应按状态码处理。
  }
  if (!response.ok) {
    const error = (payload as { error?: { message?: string } } | null)?.error;
    return { ok: false, message: error?.message ?? `HTTP ${response.status}` };
  }
  return { ok: true, message: '' };
}

function ActionShell({ children, error }: { children: ReactNode; error: string | null }): ReactNode {
  return (
    <span className="job-action">
      {children}
      {error ? <span className="job-action-error">{error}</span> : null}
    </span>
  );
}

export function JobTrigger({ code }: { code: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const trigger = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    const result = await postJson(`/internal/api/jobs/${encodeURIComponent(code)}/trigger`, {});
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    window.location.reload();
  };

  return (
    <ActionShell error={message}>
      <button type="button" onClick={trigger} disabled={busy}>
        {busy ? '入队中…' : '立即执行'}
      </button>
    </ActionShell>
  );
}

export function JobToggle({ code, enabled }: { code: string; enabled: boolean }): ReactNode {
  const [checked, setChecked] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    const previous = checked;
    setChecked(next);
    const result = await postJson(`/internal/api/jobs/${encodeURIComponent(code)}/toggle`, { enabled: next });
    setBusy(false);
    if (!result.ok) {
      setChecked(previous);
      setError(result.message);
      return;
    }
    window.location.reload();
  };

  return (
    <ActionShell error={error}>
      <label className="job-switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>{checked ? '启用' : '停用'}</span>
      </label>
    </ActionShell>
  );
}

export function JobEditor({ job }: { job: Record<string, unknown> }): ReactNode {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(job, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (cause) {
      setBusy(false);
      setError(`JSON 不合法：${String(cause)}`);
      return;
    }
    const result = await postJson('/internal/api/jobs', body);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    window.location.reload();
  };

  return (
    <span className="job-action">
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {open ? '收起编辑' : '编辑'}
      </button>
      {open ? (
        <span className="job-editor">
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={14} spellCheck={false} />
          <span>
            <button type="button" onClick={save} disabled={busy}>
              {busy ? '保存中…' : '保存任务定义'}
            </button>
            {error ? <span className="job-action-error">{error}</span> : null}
          </span>
        </span>
      ) : null}
    </span>
  );
}