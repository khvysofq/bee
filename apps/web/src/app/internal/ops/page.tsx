import Link from 'next/link';
import { loadOpsData } from '@/lib/ops';

export const dynamic = 'force-dynamic';

function fmtDateTime(value: string | null): string {
  if (!value) return '—';
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

const PRIORITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };
const KIND_LABEL: Record<string, string> = {
  validation: '校验',
  caliber: '口径',
  source: '来源',
  pipeline: '管线',
};

export default async function OpsPage() {
  let data: Awaited<ReturnType<typeof loadOpsData>> | null = null;
  let error: string | null = null;
  try {
    data = await loadOpsData();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (error) {
    return (
      <main className="container container-narrow">
        <h1>每日巡检 / 异常队列</h1>
        <div className="error">
          <p>运维数据读取失败：{error}</p>
          <p>
            先起库并生成数据：<code>pnpm db:migrate && pnpm db:seed && pnpm data:fixture</code>
          </p>
        </div>
      </main>
    );
  }

  if (!data) return null;

  return (
    <main className="container container-wide">
      <header className="brief-head">
        <div>
          <p className="eyebrow">bee · 运维</p>
          <h1>每日巡检 / 异常队列</h1>
          <p className="sub">
            {data.today}（Asia/Shanghai）· 单人 + AI 运营：AI 预检汇总，人每天一次确认并处理异常 · 生成于{' '}
            {fmtDateTime(data.generatedAt)}
          </p>
        </div>
        <div className={`signoff ${data.summary.readyToSignOff ? 'ok' : 'warn'}`}>
          <strong>{data.summary.readyToSignOff ? '可签收' : data.summary.inspectionDone ? '有异常待处理' : '待巡检'}</strong>
          <span>{data.summary.inspectionDone ? '今日巡检已记录' : '今日巡检未记录'}</span>
        </div>
      </header>

      <section className="ops-stats">
        <div>
          <strong>{data.summary.open}</strong>
          <span>开放异常</span>
        </div>
        <div className={data.summary.high > 0 ? 'warn' : ''}>
          <strong>{data.summary.high}</strong>
          <span>高优先级</span>
        </div>
        <div>
          <strong>{data.summary.oldestOpenHours ?? '—'}</strong>
          <span>最久开放（小时）</span>
        </div>
        <div>
          <strong>{data.latestQuoteDate ?? '—'}</strong>
          <span>最新定档日</span>
        </div>
      </section>

      <section className="checklist" aria-label="每日巡检清单">
        <h2>巡检清单（AI 预检）</h2>
        <ul>
          {data.checklist.map((item) => (
            <li key={item.id} className={`check-${item.state}`}>
              <span className="check-badge">{item.state}</span>
              <div>
                <strong>{item.label}</strong>
                <p>{item.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="inspection-action">
        <h2>今日巡检记录</h2>
        <p className="muted">
          v4 数据层暂未提供巡检台账写入；这里只读展示数据新鲜度与任务运行状态，巡检记录功能停用。
        </p>
      </section>

      <section className="exceptions" aria-label="开放异常队列">
        <h2>开放异常（{data.exceptions.length}）</h2>
        <p className="muted">
          异常不进入简报。处理完成后在此标记解决；口径类决策应另落 caliber_decision。最近一次采集运行：
          {data.lastCollectionRun ? (
            <>
              {' '}
              <code>{data.lastCollectionRun.status}</code> · {fmtDateTime(data.lastCollectionRun.finishedAt)} ·{' '}
              {data.lastCollectionRun.triggeredBy}
            </>
          ) : (
            ' 无'
          )}
        </p>
        {data.exceptions.length === 0 ? (
          <p className="empty-row">队列为空。</p>
        ) : (
          <div className="table-wrap">
            <table className="quote-table">
              <thead>
                <tr>
                  <th>优先级</th>
                  <th>类型</th>
                  <th>摘要</th>
                  <th>对象</th>
                  <th>已开放</th>
                  <th>指派</th>
                  <th>处理</th>
                </tr>
              </thead>
              <tbody>
                {data.exceptions.map((exception) => (
                  <tr key={exception.id}>
                    <td>
                      <span className={`tag tag-priority-${exception.priority}`}>
                        {PRIORITY_LABEL[exception.priority] ?? exception.priority}
                      </span>
                    </td>
                    <td>{KIND_LABEL[exception.kind] ?? exception.kind}</td>
                    <td>{exception.summary}</td>
                    <td>
                      <code>{exception.subjectType}</code>
                      {exception.subjectId ? (
                        <>
                          <br />
                          <code title={exception.subjectId}>{exception.subjectId.slice(0, 8)}…</code>
                        </>
                      ) : null}
                    </td>
                    <td>{exception.ageHours.toFixed(2)} h</td>
                    <td>{exception.assignedTo}</td>
                    <td>
                      <span className="muted">—（v4 异常队列已删除）</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ops-note">
        <h2>近期来源异常（24h）</h2>
        {data.sourceAnomalies.length === 0 ? (
          <p className="muted">无。</p>
        ) : (
          <ul>
            {data.sourceAnomalies.map((event) => (
              <li key={event.id}>
                {event.sourceName} · {fmtDateTime(event.createdAt)} · <code>{JSON.stringify(event.detail)}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="brief-foot">
        <p>
          <Link href="/internal/status">← 数据状态</Link> · <Link href="/">返回用户站</Link>
        </p>
        <p className="muted">
          巡检与异常处理在 v4 中尚未实现；当前只读展示 price_daily 的新鲜度与 job_run 的最新运行。
        </p>
      </footer>
    </main>
  );
}
