'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { CandidateRow, JobRunRow } from '@/lib/jobs-data';
import { statusLabel } from './labels';

function fmt(value: Date | string | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

const RUN_STATUS_LABEL: Record<string, string> = {
  queued: '排队',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  dead: '死信',
  skipped: '跳过',
  policy_blocked: '合规拦截',
};


export function RunsPanel({ runs }: { runs: JobRunRow[] }): ReactNode {
  const [status, setStatus] = useState('all');
  const options = useMemo(() => {
    const seen = new Set(runs.map((run) => run.status));
    return ['all', ...seen].sort();
  }, [runs]);
  const filtered = status === 'all' ? runs : runs.filter((run) => run.status === status);

  return (
    <section className="jobs-panel" aria-label="运行记录">
      <div className="jobs-panel-head">
        <h2>运行记录（最近 {runs.length} 条）</h2>
        <label className="jobs-filter">
          状态
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            {options.map((option) => (
              <option key={option} value={option}>
                {option === 'all' ? '全部' : statusLabel(option)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {filtered.length === 0 ? (
        <p className="empty-row">没有符合条件的运行记录。</p>
      ) : (
        <div className="table-wrap">
          <table className="quote-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>开始</th>
                <th>耗时</th>
                <th>HTTP</th>
                <th>bytes</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((run) => (
                <tr key={run.id}>
                  <td>
                    <code>{run.jobCode}</code>
                  </td>
                  <td>
                    <span className={`job-status job-status-${run.status}`}>{statusLabel(run.status)}</span>
                    <span className="muted"> #{run.attempt}</span>
                  </td>
                  <td>{fmt(run.startedAt ?? run.createdAt)}</td>
                  <td>{run.costMs === null ? '—' : `${run.costMs} ms`}</td>
                  <td>{run.httpStatus ?? '—'}</td>
                  <td>{run.fetchedBytes ?? '—'}</td>
                  <td>
                    {run.errorCode ? <code>{run.errorCode}</code> : '—'}
                    {run.errorDetail ? (
                      <span className="job-error-detail" title={run.errorDetail}>
                        {run.errorDetail.slice(0, 200)}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function payloadSummary(payload: unknown): string {
  const row = payload as Record<string, unknown> | null;
  if (!row) return '—';
  return [
    row.raw_category_text,
    row.raw_spec_text,
    row.raw_region_text,
    `${row.price_low ?? '?'}–${row.price_high ?? '?'} ${row.raw_unit ?? ''}`,
    row.quote_date,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function CandidatesPanel({ candidates }: { candidates: CandidateRow[] }): ReactNode {
  const [status, setStatus] = useState('pending');
  const filtered = candidates.filter((candidate) => status === 'all' || candidate.status === status);

  return (
    <section className="jobs-panel" aria-label="候选缓冲">
      <div className="jobs-panel-head">
        <h2>候选缓冲（{candidates.length} 条）</h2>
        <label className="jobs-filter">
          状态
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="pending">待处理</option>
            <option value="rejected">已拒绝</option>
            <option value="accepted">已接受</option>
            <option value="all">全部</option>
          </select>
        </label>
      </div>
      {filtered.length === 0 ? (
        <p className="empty-row">没有符合条件的候选。worker 运行后，这里会出现 pending / rejected 记录。</p>
      ) : (
        <ul className="jobs-candidates">
          {filtered.map((candidate) => (
            <li key={candidate.id}>
              <div>
                <span className={`job-status job-status-${candidate.status}`}>{candidate.status}</span>{' '}
                <code>{candidate.dedupeKey}</code>
              </div>
              <div className="muted">{payloadSummary(candidate.payload)}</div>
              {candidate.rejectReason ? <div>拒绝原因：{candidate.rejectReason}</div> : null}
              <details>
                <summary>证据 / payload</summary>
                <pre>{JSON.stringify({ evidence: candidate.evidenceRef, payload: candidate.payload }, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}