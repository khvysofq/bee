import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
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

function ageHours(iso: string, now: Date): number {
  return Math.max(0, Math.round(((now.getTime() - new Date(iso).getTime()) / 36_000) ) / 100);
}

export async function loadOpsData(database: BeeDb = defaultDb, now: Date = new Date()): Promise<OpsData> {
  const today = todayInShanghai(now);
  const generatedAt = now.toISOString();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const exceptionRows = await database
    .select()
    .from(dbSchema.exceptionQueue)
    .where(eq(dbSchema.exceptionQueue.status, 'open'))
    .orderBy(desc(dbSchema.exceptionQueue.priority), dbSchema.exceptionQueue.createdAt);

  const exceptions: OpsException[] = exceptionRows.map((row) => {
    const createdAt = timestampToIso(row.createdAt) ?? generatedAt;
    return {
      id: row.id,
      kind: row.kind,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      summary: row.summary,
      priority: row.priority,
      status: row.status,
      assignedTo: row.assignedTo,
      createdAt,
      ageHours: ageHours(createdAt, now),
    };
  });

  const [lastCollection] = await database
    .select({
      id: dbSchema.pipelineRun.id,
      status: dbSchema.pipelineRun.status,
      triggeredBy: dbSchema.pipelineRun.triggeredBy,
      finishedAt: dbSchema.pipelineRun.finishedAt,
    })
    .from(dbSchema.pipelineRun)
    .where(eq(dbSchema.pipelineRun.kind, 'daily_collect'))
    .orderBy(desc(dbSchema.pipelineRun.createdAt))
    .limit(1);

  const [inspectionRow] = await database
    .select({
      id: dbSchema.pipelineRun.id,
      finishedAt: dbSchema.pipelineRun.finishedAt,
      triggeredBy: dbSchema.pipelineRun.triggeredBy,
      configJson: dbSchema.pipelineRun.configJson,
    })
    .from(dbSchema.pipelineRun)
    .where(
      and(
        eq(dbSchema.pipelineRun.kind, 'maintenance'),
        eq(dbSchema.pipelineRun.idempotencyKey, inspectionIdempotencyKey(today)),
      ),
    )
    .limit(1);

  const [latestQuote] = await database
    .select({ latest: sql<string | null>`max(${dbSchema.dailyQuote.quoteDate})` })
    .from(dbSchema.dailyQuote)
    .where(eq(dbSchema.dailyQuote.status, 'published'));

  const [latestFetch] = await database
    .select({ latest: sql<Date | null>`max(${dbSchema.priceObservation.fetchedAt})` })
    .from(dbSchema.priceObservation);

  const anomalyRows = await database
    .select({
      id: dbSchema.sourceEvent.id,
      sourceName: dbSchema.source.name,
      detail: dbSchema.sourceEvent.detail,
      createdAt: dbSchema.sourceEvent.createdAt,
    })
    .from(dbSchema.sourceEvent)
    .innerJoin(dbSchema.source, eq(dbSchema.sourceEvent.sourceId, dbSchema.source.id))
    .where(and(eq(dbSchema.sourceEvent.eventKind, 'fetch_anomaly'), gte(dbSchema.sourceEvent.createdAt, since24h)))
    .orderBy(desc(dbSchema.sourceEvent.createdAt));

  const high = exceptions.filter((row) => row.priority === 'high').length;
  const medium = exceptions.filter((row) => row.priority === 'medium').length;
  const low = exceptions.filter((row) => row.priority === 'low').length;
  const oldestOpenHours =
    exceptions.length === 0 ? null : Math.max(...exceptions.map((row) => row.ageHours));
  const latestQuoteDate = latestQuote?.latest ?? null;
  const dataCutoffAt = timestampToIso(latestFetch?.latest ?? null);
  const inspectionDone = Boolean(inspectionRow);
  const note =
    inspectionRow?.configJson &&
    typeof inspectionRow.configJson === 'object' &&
    'note' in inspectionRow.configJson &&
    typeof (inspectionRow.configJson as { note?: unknown }).note === 'string'
      ? (inspectionRow.configJson as { note: string }).note
      : null;

  const checklist: ChecklistItem[] = [
    {
      id: 'data-freshness',
      label: '今日定档数据已发布',
      state: latestQuoteDate === today ? 'ok' : latestQuoteDate ? 'warn' : 'fail',
      detail: latestQuoteDate
        ? `最新已发布定档日 ${latestQuoteDate}；数据抓取截止 ${dataCutoffAt ?? '—'}`
        : '没有任何已发布定档报价',
    },
    {
      id: 'high-priority',
      label: '无未处理高优先级异常',
      state: high === 0 ? 'ok' : 'fail',
      detail: high === 0 ? '高优先级异常 0 条' : `高优先级异常 ${high} 条，需先处理`,
    },
    {
      id: 'queue',
      label: '异常队列已巡检',
      state: exceptions.length === 0 ? 'ok' : 'warn',
      detail:
        exceptions.length === 0
          ? '开放异常 0 条'
          : `开放异常 ${exceptions.length} 条（中 ${medium} / 低 ${low}），最久 ${oldestOpenHours ?? 0} 小时`,
    },
    {
      id: 'source-anomaly',
      label: '近 24h 无来源异常',
      state: anomalyRows.length === 0 ? 'ok' : 'warn',
      detail: anomalyRows.length === 0 ? '近 24h 无来源异常事件' : `近 24h ${anomalyRows.length} 条来源异常事件`,
    },
    {
      id: 'fixture-label',
      label: '来源署名 / 免责声明标识在线',
      state: 'ok',
      detail:
        '简报页展示「数据来源：国家统计局（流通领域重要生产资料市场价格）」+ 公报原文链接；存在 fixture 源时显示 FIXTURE 标识；页脚保留 BRIEF_DISCLAIMER_V1',
    },
    {
      id: 'inspection-recorded',
      label: `今日巡检已记录（${today}，Asia/Shanghai）`,
      state: inspectionDone ? 'ok' : 'warn',
      detail: inspectionDone
        ? `已由 ${inspectionRow?.triggeredBy ?? '—'} 于 ${timestampToIso(inspectionRow?.finishedAt ?? null) ?? '—'} 记录`
        : '尚未记录今日巡检；单人运营每天点一次「记录今日巡检」',
    },
  ];

  return {
    today,
    generatedAt,
    latestQuoteDate,
    dataCutoffAt,
    lastCollectionRun: lastCollection
      ? {
          id: lastCollection.id,
          status: lastCollection.status,
          triggeredBy: lastCollection.triggeredBy,
          finishedAt: timestampToIso(lastCollection.finishedAt),
        }
      : null,
    inspection: inspectionRow
      ? {
          id: inspectionRow.id,
          finishedAt: timestampToIso(inspectionRow.finishedAt),
          triggeredBy: inspectionRow.triggeredBy,
          note,
        }
      : null,
    exceptions,
    sourceAnomalies: anomalyRows.map((row) => ({
      id: row.id,
      sourceName: row.sourceName,
      detail: row.detail,
      createdAt: timestampToIso(row.createdAt) ?? '',
    })),
    checklist,
    summary: {
      open: exceptions.length,
      high,
      medium,
      low,
      oldestOpenHours,
      inspectionDone,
      readyToSignOff: inspectionDone && high === 0,
    },
  };
}
