import { desc, eq, sql } from 'drizzle-orm';
import { v4, type BeeDb } from '@bee/db';
import { timestampToIso } from '@bee/core';
import { db as defaultDb } from '../db';

export function todayInShanghai(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function inspectionIdempotencyKey(date: string): string {
  return `ops_inspection:${date}`;
}

export type ChecklistState = 'ok' | 'warn' | 'fail' | 'info';

export interface ChecklistItem {
  id: string;
  label: string;
  state: ChecklistState;
  detail: string;
}

export interface OpsException {
  id: string;
  kind: string;
  subjectType: string;
  subjectId: string | null;
  summary: string;
  priority: string;
  status: string;
  assignedTo: string;
  createdAt: string;
  ageHours: number;
}

export interface OpsData {
  today: string;
  generatedAt: string;
  latestQuoteDate: string | null;
  dataCutoffAt: string | null;
  lastCollectionRun: {
    id: string;
    status: string;
    triggeredBy: string;
    finishedAt: string | null;
  } | null;
  inspection: {
    id: string;
    finishedAt: string | null;
    triggeredBy: string;
    note: string | null;
  } | null;
  exceptions: OpsException[];
  sourceAnomalies: Array<{ id: string; sourceName: string; detail: unknown; createdAt: string }>;
  checklist: ChecklistItem[];
  summary: {
    open: number;
    high: number;
    medium: number;
    low: number;
    oldestOpenHours: number | null;
    inspectionDone: boolean;
    readyToSignOff: boolean;
  };
}

/**
 * 运维页数据层（v4）。
 *
 * 只读 price_daily / job_run：v4 删除了 exception_queue、source_event、pipeline_run，
 * 因此异常、来源事件、巡检台账都返回空/停用状态；页面不会 500。
 */
export async function loadOpsData(database: BeeDb = defaultDb, now: Date = new Date()): Promise<OpsData> {
  const today = todayInShanghai(now);
  const generatedAt = now.toISOString();

  const [latestQuote] = await database
    .select({ latest: sql<string | null>`max(${v4.priceDaily.priceDate})` })
    .from(v4.priceDaily)
    .where(eq(v4.priceDaily.status, 'published'));

  const [latestFetch] = await database
    .select({ latest: sql<Date | null>`max(${v4.priceDaily.capturedAt})` })
    .from(v4.priceDaily);

  const [lastRunRow] = await database
    .select({
      id: v4.jobRun.id,
      status: v4.jobRun.status,
      finishedAt: v4.jobRun.finishedAt,
      jobCode: v4.job.code,
    })
    .from(v4.jobRun)
    .innerJoin(v4.job, eq(v4.job.id, v4.jobRun.jobId))
    .orderBy(desc(v4.jobRun.startedAt), desc(v4.jobRun.createdAt))
    .limit(1);

  const latestQuoteDate = latestQuote?.latest ?? null;
  const dataCutoffAt = timestampToIso(latestFetch?.latest ?? null);
  const lastCollectionRun = lastRunRow
    ? {
        id: lastRunRow.id,
        status: lastRunRow.status,
        triggeredBy: lastRunRow.jobCode,
        finishedAt: timestampToIso(lastRunRow.finishedAt),
      }
    : null;

  const checklist: ChecklistItem[] = [
    {
      id: 'data-freshness',
      label: '今日价格数据已发布',
      state: latestQuoteDate === today ? 'ok' : latestQuoteDate ? 'warn' : 'fail',
      detail: latestQuoteDate
        ? `最新已发布价格日 ${latestQuoteDate}；数据抓取截止 ${dataCutoffAt ?? '—'}`
        : '没有任何已发布价格',
    },
    {
      id: 'high-priority',
      label: '无未处理高优先级异常',
      state: 'ok',
      detail: 'v4 已删除异常队列；失败记录在 job_run.error，请到任务页查看',
    },
    {
      id: 'queue',
      label: '异常队列已巡检',
      state: 'ok',
      detail: 'v4 已删除异常队列',
    },
    {
      id: 'source-anomaly',
      label: '近 24h 来源异常',
      state: 'ok',
      detail: 'v4 已删除 source_event；来源异常请查看 job_run.error',
    },
    {
      id: 'inspection-recorded',
      label: `今日巡检已记录（${today}，Asia/Shanghai）`,
      state: 'warn',
      detail: 'v4 巡检台账尚未实现，当前只能查看数据新鲜度',
    },
  ];

  return {
    today,
    generatedAt,
    latestQuoteDate,
    dataCutoffAt,
    lastCollectionRun,
    // v4 没有 maintenance 运行类型；巡检记录停用。
    inspection: null,
    exceptions: [],
    sourceAnomalies: [],
    checklist,
    summary: {
      open: 0,
      high: 0,
      medium: 0,
      low: 0,
      oldestOpenHours: null,
      inspectionDone: false,
      readyToSignOff: false,
    },
  };
}