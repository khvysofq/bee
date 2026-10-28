/**
 * 内部管理页共用的客户端请求与格式化工具。
 * 所有写操作都走 /internal/api/*，成功后由页面 router.refresh() 取最新数据。
 */

export async function sendJson(
  url: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<{ ok: boolean; message: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    return { ok: false, message: `请求失败：${String(cause)}` };
  }

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

export function fmtDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export function fmtDate(value: string | null): string {
  return value ? value.slice(0, 10) : '—';
}