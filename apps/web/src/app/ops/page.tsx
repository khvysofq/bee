import Link from 'next/link';
import { loadOpsData } from '@/lib/ops';
import { recordDailyInspection, resolveException } from './actions';

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
      <main className="container">
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
        {data.inspection ? (
          <div className="inspection-done">
            <p>
              已记录：<strong>{fmtDateTime(data.inspection.finishedAt)}</strong> · 执行人{' '}
              <code>{data.inspection.triggeredBy}</code> · 台账 run <code>{data.inspection.id}</code>
            </p>
            {data.inspection.note ? <p>备注：{data.inspection.note}</p> : null}
            <p className="muted">同一自然日重复提交会被台账幂等键复用，不会产生第二条巡检记录。</p>
          </div>
        ) : (
          <form action={recordDailyInspection} className="inspection-form">
            <label>
              巡检备注（可选）
              <input name="note" maxLength={500} placeholder="例如：已核对 P0-3 数据链与异常队列" />
            </label>
            <button type="submit">记录今日巡检（单人运营）</button>
          </form>
        )}
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
                      <form action={resolveException} className="resolve-form">
                        <input type="hidden" name="id" value={exception.id} />
                        <input name="resolution" placeholder="处理说明" maxLength={500} />
                        <button type="submit">标记已解决</button>
                      </form>
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
          <Link href="/briefing">← 返回每日简报</Link> · <Link href="/">数据底座状态</Link>
        </p>
        <p className="muted">
          巡检记录落在 <code>pipeline_run</code>（kind=maintenance，幂等键 ops_inspection:日期）；异常处理落在{' '}
          <code>exception_queue</code>。单人运营 + AI 预检，人只处理异常与口径决策。
        </p>
      </footer>
    </main>
  );
}
