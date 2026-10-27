import type { ReactNode } from 'react';
import type { JobsData, JobWithStats } from '@/lib/jobs-data';
import { JobEditor, JobToggle, JobTrigger } from './JobActions';
import { CandidatesPanel, RunsPanel } from './JobsPanels';
import { statusLabel } from './labels';

function fmtDateTime(value: Date | string | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function fmtDuration(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}

const EMPTY_EXAMPLE = {
  code: 'demo.local.fixture',
  type: 'fetch_table',
  tier: 'deterministic',
  target: { url: 'fixture://fengj-copper.html', method: 'GET', rps: 0.5 },
  goal: '离线自检：解析仓库内 fengj 废铜表格 fixture',
  adapter: 'fengj-copper-v1',
  mapping: { table: 'price_observation', data_class: 'spot_quote', keys: { region: 'city', value: 'price' } },
  schedule: { cron: '*/15 * * * *', tz: 'Asia/Shanghai', enabled: true },
  limits: { timeout_s: 30, max_attempts: 1, backoff_s: [0] },
  policy: { source_code: 'demo-fixture', redistribution: 'licensed' },
  priority: 3,
  enabled: true,
};

function LatestRun({ job }: { job: JobWithStats }): ReactNode {
  if (!job.latestRun) return <span className="muted">尚未运行</span>;
  const run = job.latestRun;
  return (
    <span>
      <span className={`job-status job-status-${run.status}`}>{statusLabel(run.status)}</span>
      <br />
      <span className="muted">
        {fmtDateTime(run.startedAt ?? run.createdAt)} · {fmtDuration(run.costMs)}
      </span>
    </span>
  );
}

function editableJob(def: JobsData['jobs'][number]['definition']): Record<string, unknown> {
  return {
    code: def.code,
    type: def.type,
    tier: def.tier,
    target: def.target,
    goal: def.goal,
    adapter: def.adapter,
    output_schema: def.outputSchema,
    mapping: def.mapping,
    schedule: def.schedule,
    limits: def.limits,
    agent: def.agent,
    policy: def.policy,
    priority: def.priority,
    enabled: def.enabled,
    notes: def.notes,
  };
}

function JobRow({ job }: { job: JobWithStats }): ReactNode {
  const def = job.definition;
  const schedule = (def.schedule as { cron?: string; tz?: string } | null) ?? {};
  return (
    <tbody>
      <tr>
        <td>
          <code className="job-code">{def.code}</code>
          {def.notes ? <div className="muted job-note">{def.notes}</div> : null}
        </td>
        <td>{def.type}</td>
        <td>{def.tier}</td>
        <td>
          <code className="job-cron">{schedule.cron ?? '—'}</code>
          <div className="muted">{schedule.tz ?? 'Asia/Shanghai'}</div>
        </td>
        <td>
          <JobToggle code={def.code} enabled={def.enabled} />
        </td>
        <td>
          <LatestRun job={job} />
        </td>
        <td>
          {job.successRate20.pct === null ? (
            <span className="muted">—</span>
          ) : (
            <span>
              {job.successRate20.pct}%{' '}
              <span className="muted">
                （{job.successRate20.succeeded}/{job.successRate20.total}）
              </span>
            </span>
          )}
        </td>
        <td>{job.nextRunAt ? fmtDateTime(job.nextRunAt) : <span className="muted">未排期</span>}</td>
        <td>
          <JobTrigger code={def.code} /> <JobEditor job={editableJob(def)} />
        </td>
      </tr>
      <tr className="job-detail-row">
        <td colSpan={9}>
          <details>
            <summary>最近 10 次运行</summary>
            {job.recentRuns.length === 0 ? (
              <p className="empty-row">还没有运行记录。点「立即执行」入队，worker 领取后即可看到。</p>
            ) : (
              <div className="table-wrap">
                <table className="quote-table">
                  <thead>
                    <tr>
                      <th>状态</th>
                      <th>attempt</th>
                      <th>开始</th>
                      <th>耗时</th>
                      <th>HTTP</th>
                      <th>bytes</th>
                      <th>错误</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.recentRuns.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <span className={`job-status job-status-${run.status}`}>{statusLabel(run.status)}</span>
                        </td>
                        <td>{run.attempt}</td>
                        <td>{fmtDateTime(run.startedAt ?? run.createdAt)}</td>
                        <td>{fmtDuration(run.costMs)}</td>
                        <td>{run.httpStatus ?? '—'}</td>
                        <td>{run.fetchedBytes ?? '—'}</td>
                        <td>
                          {run.errorCode ? <code>{run.errorCode}</code> : '—'}
                          {run.errorDetail ? <div className="muted">{run.errorDetail.slice(0, 200)}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </td>
      </tr>
    </tbody>
  );
}

export function JobsView({ data }: { data: JobsData }): ReactNode {
  return (
    <main className="container container-wide">
      <header className="brief-head">
        <div>
          <p className="eyebrow">bee · 运维 · 作业系统</p>
          <h1>任务管理</h1>
          <p className="sub">
            任务即数据：新增同类任务 = 插一行；停用 = 改 enabled。所有写操作走 <code>/internal/api/jobs</code>，
            worker 只产候选、业务写入只经 <code>/internal/ingest</code>。
          </p>
        </div>
        <div className="muted">生成于 {fmtDateTime(data.generatedAt)}（{data.today} Asia/Shanghai）</div>
      </header>

      <section className="ops-stats" aria-label="任务读数">
        <div>
          <strong>{data.stats.total}</strong>
          <span>任务总数</span>
        </div>
        <div>
          <strong>{data.stats.enabled}</strong>
          <span>启用中</span>
        </div>
        <div>
          <strong>{data.stats.todayRuns}</strong>
          <span>今日运行</span>
        </div>
        <div className={data.stats.todayFailed > 0 ? 'warn' : ''}>
          <strong>{data.stats.todayFailed}</strong>
          <span>今日失败</span>
        </div>
      </section>

      <section className="jobs-panel" aria-label="任务列表">
        <h2>任务（{data.jobs.length}）</h2>
        {data.jobs.length === 0 ? (
          <div className="jobs-empty">
            <p>
              <strong>还没有任务。</strong>先运行 <code>pnpm jobs:seed</code> 插入两条示例任务，或通过{' '}
              <code>POST /internal/api/jobs</code> 新建。最小示例 JSON：
            </p>
            <pre>{JSON.stringify(EMPTY_EXAMPLE, null, 2)}</pre>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="quote-table jobs-table">
              <thead>
                <tr>
                  <th>code</th>
                  <th>type</th>
                  <th>tier</th>
                  <th>cron</th>
                  <th>启用</th>
                  <th>最近一次</th>
                  <th>近 20 次成功率</th>
                  <th>下次执行</th>
                  <th>操作</th>
                </tr>
              </thead>
              {data.jobs.map((job) => (
                <JobRow key={job.definition.code} job={job} />
              ))}
            </table>
          </div>
        )}
      </section>

      <RunsPanel runs={data.runs} />
      <CandidatesPanel candidates={data.candidates} />

      <footer className="brief-foot">
        <p className="muted">
          队列 pg-boss（queue=<code>job.run</code>）；worker 与 scheduler 分别用{' '}
          <code>pnpm jobs:worker</code> / <code>pnpm jobs:scheduler</code> 常驻。
        </p>
      </footer>
    </main>
  );
}