import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JobsView } from '../src/components/jobs/JobsView';
import type { JobsData, JobWithStats } from '../src/lib/jobs-data';

const now = new Date('2026-10-27T01:00:00Z');

const definition: JobWithStats['definition'] = {
  id: '00000000-0000-0000-0000-000000000001',
  code: 'demo.local.fixture',
  type: 'fetch_table',
  tier: 'deterministic',
  target: { url: 'fixture://fengj-copper.html' },
  goal: '离线自检',
  adapter: 'fengj-copper-v1',
  outputSchema: null,
  mapping: { table: 'price_observation' },
  schedule: { cron: '*/15 * * * *', tz: 'Asia/Shanghai', enabled: true },
  limits: { timeout_s: 30, max_attempts: 1, backoff_s: [0] },
  agent: null,
  policy: { source_code: 'demo-fixture' },
  priority: 3,
  enabled: true,
  notes: null,
  createdAt: now,
  updatedAt: now,
};

const run: JobWithStats['recentRuns'][number] = {
  id: '00000000-0000-0000-0000-000000000002',
  jobCode: 'demo.local.fixture',
  scheduledFor: null,
  startedAt: now,
  finishedAt: now,
  status: 'succeeded',
  attempt: 1,
  workerId: 'test-worker',
  tierUsed: 'deterministic',
  costMs: 120,
  costTokens: 0,
  fetchedBytes: 2048,
  httpStatus: 200,
  rawFetchId: null,
  errorCode: null,
  errorDetail: null,
  nextRetryAt: null,
  createdAt: now,
};

const data: JobsData = {
  generatedAt: now.toISOString(),
  today: '2026-10-27',
  stats: { total: 1, enabled: 1, todayRuns: 1, todayFailed: 0 },
  jobs: [
    {
      definition,
      latestRun: run,
      recentRuns: [run],
      successRate20: { succeeded: 1, total: 1, pct: 100 },
      nextRunAt: '2026-10-27T01:15:00.000Z',
    },
  ],
  runs: [run],
  candidates: [
    {
      id: '00000000-0000-0000-0000-000000000003',
      jobRunId: run.id,
      kind: 'quote',
      payload: {
        raw_category_text: '废铜',
        raw_spec_text: '光亮铜线',
        raw_region_text: '佛山',
        price_low: 62000,
        price_high: 62000,
        raw_unit: '元/吨',
        quote_date: '2026-10-26',
      },
      schemaOk: true,
      dedupeKey: 'quote:demo-fixture|广东|佛山|废铜|光亮铜线|参考价|2026-10-26',
      evidenceRef: { raw: { sha256: 'a'.repeat(64), ref: 'raw/2026/10/27/x.bin' } },
      status: 'pending',
      rejectReason: null,
      validatorVersion: 'jobs-validator@1.0.0',
      acceptedRowId: null,
      createdAt: now,
    },
  ],
};

describe('/internal/jobs 渲染契约', () => {
  it('有任务时能看到 code / 状态 / 启用开关 / 下次执行', () => {
    const html = renderToStaticMarkup(createElement(JobsView, { data }));
    expect(html).toContain('demo.local.fixture');
    expect(html).toContain('成功');
    expect(html).toContain('启用');
    expect(html).toContain('立即执行');
    expect(html).toContain('100%');
    expect(html).toContain('2026-10-27 01:15:00 UTC');
    expect(html).toContain('quote:demo-fixture');
    expect(html).toContain('候选缓冲');
    expect(html).toContain('运行记录');
  });

  it('无任务时空态文案与最小示例 JSON 正确', () => {
    const empty: JobsData = {
      generatedAt: now.toISOString(),
      today: '2026-10-27',
      stats: { total: 0, enabled: 0, todayRuns: 0, todayFailed: 0 },
      jobs: [],
      runs: [],
      candidates: [],
    };
    const html = renderToStaticMarkup(createElement(JobsView, { data: empty }));
    expect(html).toContain('还没有任务');
    expect(html).toContain('pnpm jobs:seed');
    expect(html).toContain('POST /internal/api/jobs');
    expect(html).toContain('demo.local.fixture');
    expect(html).toContain('没有符合条件的运行记录');
    expect(html).toContain('没有符合条件的候选');
  });
});