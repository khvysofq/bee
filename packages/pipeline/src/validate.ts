import { and, eq, lt } from 'drizzle-orm';
import { dbSchema } from '@bee/db';
import type { BeeDbOrTx } from './ledger';
import type { AgentReviewer } from './agent';
import type {
  NormalizedObservation,
  PriceType,
  ValidationPlan,
  ValidationPlanItem,
  ValidationThresholds,
} from './types';
import { DEFAULT_THRESHOLDS } from './types';

export interface ObservationForValidation {
  observationKey: string;
  observationId: string | null;
  sourceId: string;
  sourceName: string;
  categoryId: string | null;
  specId: string | null;
  regionId: string | null;
  priceType: PriceType | null;
  quoteDate: string | null;
  normValueLow: number | null;
  normValueHigh: number | null;
  initialStatus: 'normalized' | 'needs_human';
  issues: string[];
}

export function observationFromNormalized(item: NormalizedObservation): ObservationForValidation {
  return {
    observationKey: `${item.sourceCode}:${item.fetchId}:${item.sourceRowIndex}`,
    observationId: item.observationId,
    sourceId: item.sourceId,
    sourceName: item.sourceCode,
    categoryId: item.categoryId,
    specId: item.specId,
    regionId: item.regionId,
    priceType: item.priceType,
    quoteDate: item.row.quoteDate,
    normValueLow: item.normValueLow,
    normValueHigh: item.normValueHigh,
    initialStatus: item.status,
    issues: item.issues,
  };
}

function mid(low: number | null, high: number | null): number | null {
  if (low === null || high === null) return null;
  return (low + high) / 2;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function pct(deviation: number, base: number): number {
  return base === 0 ? 0 : Math.abs(deviation) / base;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function dimensionKey(item: ObservationForValidation): string | null {
  if (!item.categoryId || !item.specId || !item.regionId || !item.priceType || !item.quoteDate) return null;
  return [item.categoryId, item.specId, item.regionId, item.priceType, item.quoteDate].join('|');
}

function seriesKey(item: ObservationForValidation): string | null {
  if (!item.categoryId || !item.specId || !item.regionId || !item.priceType) return null;
  return [item.sourceId, item.categoryId, item.specId, item.regionId, item.priceType].join('|');
}

interface PriorCandidate {
  observationKey: string;
  quoteDate: string;
  mid: number;
}

interface Prepared {
  source: ObservationForValidation;
  key: string | null;
  itemMid: number | null;
  missing: string[];
  checks: ValidationPlanItem['checks'];
  baseStatus: ValidationPlanItem['status'];
  duplicateOf: string | null;
}

/**
 * 规则校验计划（纯读 + 计算，不写任何表）。
 *
 * 时序检查按 quote_date 顺序推进：同批次的早期观测一旦计划为 validated，就成为后续日期的
 * 基线（否则一次采集回填多天时，日/周环比永远看不到同批历史）。历史基线只认 DB 里已
 * validated 的观测；回放时传入内存观测，因此不会写生产观测/定档表。
 */
export async function planValidation(
  db: BeeDbOrTx,
  args: {
    observations: ObservationForValidation[];
    reviewer: AgentReviewer;
    thresholds?: Partial<ValidationThresholds>;
  },
): Promise<ValidationPlan> {
  const thresholds: ValidationThresholds = { ...DEFAULT_THRESHOLDS, ...args.thresholds };
  const groups = new Map<string, ObservationForValidation[]>();
  for (const item of args.observations) {
    const key = dimensionKey(item);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const seen = new Map<string, ObservationForValidation>();
  const prepared: Prepared[] = [];
  for (const item of args.observations) {
    const checks: ValidationPlanItem['checks'] = [];
    const missing: string[] = [];
    if (!item.categoryId) missing.push('category');
    if (!item.specId) missing.push('spec');
    if (!item.regionId) missing.push('region');
    if (!item.priceType) missing.push('priceType');
    if (!item.quoteDate) missing.push('quoteDate');
    if (item.normValueLow === null || item.normValueHigh === null) missing.push('normValue');
    const issues = [...item.issues];

    checks.push({
      checkKind: 'caliber_consistency',
      verdict: missing.length === 0 && item.initialStatus === 'normalized' ? 'pass' : 'needs_human',
      detail: { missingDimensions: missing, normalizationIssues: issues },
    });

    const key = dimensionKey(item);
    const itemMid = mid(item.normValueLow, item.normValueHigh);
    let crossIsolated = false;
    if (key && itemMid !== null) {
      const group = groups.get(key) ?? [];
      const sourceIds = new Set(group.map((entry) => entry.sourceId));
      if (sourceIds.size >= 2) {
        const med = median(group.map((entry) => mid(entry.normValueLow, entry.normValueHigh)).filter((v): v is number => v !== null));
        const deviation = pct(itemMid - med, med);
        crossIsolated = deviation > thresholds.crossSourcePct;
        checks.push({
          checkKind: 'cross_source',
          verdict: crossIsolated ? 'isolate' : 'pass',
          detail: {
            groupKey: key,
            medianMid: round6(med),
            deviationPct: round6(deviation),
            thresholdPct: thresholds.crossSourcePct,
            comparedSources: sourceIds.size,
          },
        });
      }
    }

    let duplicateOf: string | null = null;
    if (key && itemMid !== null) {
      const dedupeKey = `${item.sourceId}|${key}|${itemMid}`;
      duplicateOf = seen.get(dedupeKey)?.observationKey ?? null;
      if (!duplicateOf) seen.set(dedupeKey, item);
    }

    const baseStatus: ValidationPlanItem['status'] =
      missing.length > 0 || item.initialStatus === 'needs_human'
        ? 'needs_human'
        : crossIsolated || duplicateOf
          ? 'isolated'
          : 'validated';
    prepared.push({ source: item, key, itemMid, missing, checks, baseStatus, duplicateOf });
  }

  const ordered = [...prepared].sort((a, b) => {
    const da = a.source.quoteDate ?? '';
    const dbb = b.source.quoteDate ?? '';
    return da.localeCompare(dbb) || a.source.observationKey.localeCompare(b.source.observationKey);
  });
  const batchPriors = new Map<string, PriorCandidate[]>();
  const resultByKey = new Map<string, ValidationPlanItem>();

  for (const entry of ordered) {
    const item = entry.source;
    let timeIsolated = false;
    const timeKey = seriesKey(item);
    if (timeKey && entry.itemMid !== null && item.quoteDate) {
      const candidates = [...(batchPriors.get(timeKey) ?? [])];
      const dbPriors = await db
        .select({
          id: dbSchema.priceObservation.id,
          quoteDate: dbSchema.priceObservation.quoteDate,
          normValueLow: dbSchema.priceObservation.normValueLow,
          normValueHigh: dbSchema.priceObservation.normValueHigh,
        })
        .from(dbSchema.priceObservation)
        .where(
          and(
            eq(dbSchema.priceObservation.categoryId, item.categoryId!),
            eq(dbSchema.priceObservation.specId, item.specId!),
            eq(dbSchema.priceObservation.regionId, item.regionId!),
            eq(dbSchema.priceObservation.priceType, item.priceType!),
            eq(dbSchema.priceObservation.sourceId, item.sourceId),
            eq(dbSchema.priceObservation.validationStatus, 'validated'),
            lt(dbSchema.priceObservation.quoteDate, item.quoteDate),
          ),
        )
        .orderBy(dbSchema.priceObservation.quoteDate)
        .limit(20);
      for (const row of dbPriors) {
        if (!row.quoteDate) continue;
        const priorMid = mid(
          row.normValueLow === null ? null : Number(row.normValueLow),
          row.normValueHigh === null ? null : Number(row.normValueHigh),
        );
        if (priorMid !== null) candidates.push({ observationKey: row.id, quoteDate: row.quoteDate, mid: priorMid });
      }
      candidates.sort((a, b) => a.quoteDate.localeCompare(b.quoteDate));
      const latest = candidates.at(-1);
      if (latest) {
        const days = (Date.parse(item.quoteDate) - Date.parse(latest.quoteDate)) / 86_400_000;
        if (days <= 7) {
          const window = days <= 1 ? 'day' : 'week';
          const threshold = window === 'day' ? thresholds.dayChangePct : thresholds.weekChangePct;
          const deviation = pct(entry.itemMid - latest.mid, latest.mid);
          timeIsolated = deviation > threshold;
          entry.checks.push({
            checkKind: 'time_series',
            verdict: timeIsolated ? 'isolate' : 'pass',
            detail: {
              priorObservationKey: latest.observationKey,
              priorQuoteDate: latest.quoteDate,
              window,
              days,
              deviationPct: round6(deviation),
              thresholdPct: threshold,
            },
          });
        }
      }
    }

    entry.checks.push({
      checkKind: 'dedupe',
      verdict: entry.duplicateOf ? 'isolate' : 'pass',
      detail: { duplicateOf: entry.duplicateOf },
    });

    const finalStatus: ValidationPlanItem['status'] =
      entry.baseStatus === 'needs_human'
        ? 'needs_human'
        : entry.baseStatus === 'isolated' || timeIsolated
          ? 'isolated'
          : 'validated';
    if (finalStatus === 'validated' && timeKey && entry.itemMid !== null && item.quoteDate) {
      const list = batchPriors.get(timeKey) ?? [];
      list.push({ observationKey: item.observationKey, quoteDate: item.quoteDate, mid: entry.itemMid });
      batchPriors.set(timeKey, list);
    }

    const ruleVerdicts = entry.checks.map((check) => ({ checkKind: check.checkKind, verdict: check.verdict }));
    const agentReview = await args.reviewer.review({
      sourceName: item.sourceName,
      categoryId: item.categoryId,
      specId: item.specId,
      regionId: item.regionId,
      priceType: item.priceType,
      ruleVerdicts,
    });
    resultByKey.set(item.observationKey, {
      observationKey: item.observationKey,
      observationId: item.observationId,
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      categoryId: item.categoryId,
      specId: item.specId,
      regionId: item.regionId,
      priceType: item.priceType,
      quoteDate: item.quoteDate,
      normValueLow: item.normValueLow,
      normValueHigh: item.normValueHigh,
      status: finalStatus,
      missingDimensions: entry.missing,
      checks: entry.checks,
      agentReview: {
        verdict: agentReview.verdict,
        rationale: agentReview.rationale,
        input: {
          sourceName: item.sourceName,
          categoryId: item.categoryId,
          specId: item.specId,
          regionId: item.regionId,
          priceType: item.priceType,
          ruleVerdicts,
        },
      },
    });
  }

  const items = args.observations
    .map((item) => resultByKey.get(item.observationKey))
    .filter((item): item is ValidationPlanItem => Boolean(item));
  const counts = {
    validated: items.filter((item) => item.status === 'validated').length,
    isolated: items.filter((item) => item.status === 'isolated').length,
    needsHuman: items.filter((item) => item.status === 'needs_human').length,
  };
  return { items, thresholds, counts };
}

export interface AppliedValidation {
  validationIds: string[];
  invocationIds: string[];
  exceptionIds: string[];
  counts: ValidationPlan['counts'];
}

/** 把校验计划落库：validation_result（规则 + Agent）、agent_invocation、异常队列 + 状态流转。 */
export async function applyValidation(
  tx: BeeDbOrTx,
  args: {
    plan: ValidationPlan;
    runId: string;
    stepId: string;
    rulesVersion: string;
    reviewer: AgentReviewer;
    promptSha: string;
  },
): Promise<AppliedValidation> {
  const validationIds: string[] = [];
  const invocationIds: string[] = [];
  const exceptionIds: string[] = [];

  for (const item of args.plan.items) {
    if (!item.observationId) throw new Error(`校验计划缺少 observationId：${item.observationKey}`);
    for (const check of item.checks) {
      const [row] = await tx
        .insert(dbSchema.validationResult)
        .values({
          observationId: item.observationId,
          checkKind: check.checkKind,
          verdict: check.verdict,
          detail: {
            ...check.detail,
            thresholds: args.plan.thresholds,
            observationKey: item.observationKey,
          },
          performedByKind: 'rule',
          performedByRef: `rule:${check.checkKind}@daw29-v1`,
          runId: args.runId,
          rulesVersion: args.rulesVersion,
        })
        .returning({ id: dbSchema.validationResult.id });
      validationIds.push(row!.id);
    }

    const [invocation] = await tx
      .insert(dbSchema.agentInvocation)
      .values({
        runId: args.runId,
        stepId: args.stepId,
        purpose: 'validation_judgment',
        model: args.reviewer.model,
        promptVersion: args.reviewer.promptVersion,
        promptSha: args.promptSha,
        inputJson: item.agentReview.input,
        outputJson: { verdict: item.agentReview.verdict, rationale: item.agentReview.rationale },
        latencyMs: 0,
      })
      .returning({ id: dbSchema.agentInvocation.id });
    invocationIds.push(invocation!.id);

    const [llmResult] = await tx
      .insert(dbSchema.validationResult)
      .values({
        observationId: item.observationId,
        checkKind: 'llm_judgment',
        verdict: item.agentReview.verdict,
        detail: {
          rationale: item.agentReview.rationale,
          ruleVerdicts: item.agentReview.input.ruleVerdicts,
          note: 'Agent 只做判断；报价数字一律来自确定性抽取链',
        },
        performedByKind: 'agent',
        performedByRef: `llm:${args.reviewer.model}+${args.reviewer.promptVersion}`,
        runId: args.runId,
        agentInvocationId: invocation!.id,
        rulesVersion: args.rulesVersion,
      })
      .returning({ id: dbSchema.validationResult.id });
    validationIds.push(llmResult!.id);

    await tx
      .update(dbSchema.priceObservation)
      .set({ validationStatus: item.status })
      .where(eq(dbSchema.priceObservation.id, item.observationId));

    if (item.status === 'isolated' || item.status === 'needs_human') {
      const reasons = item.checks
        .filter((check) => check.verdict === 'isolate' || check.verdict === 'needs_human')
        .map((check) => check.checkKind)
        .join('、');
      const [exception] = await tx
        .insert(dbSchema.exceptionQueue)
        .values({
          kind: 'validation',
          subjectType: 'observation',
          subjectId: item.observationId,
          summary:
            item.status === 'isolated'
              ? `观测被异常隔离（${reasons || '规则异常'}），不进入简报；来源 ${item.sourceName}`
              : `观测口径不完整（${item.missingDimensions.join('、') || reasons || '待人工确认'}），待人工映射/确认`,
          priority: item.status === 'isolated' ? 'high' : 'medium',
          status: 'open',
          assignedTo: 'unassigned',
        })
        .returning({ id: dbSchema.exceptionQueue.id });
      exceptionIds.push(exception!.id);
    }
  }

  return { validationIds, invocationIds, exceptionIds, counts: args.plan.counts };
}

/** 把 DB 观测行转成校验输入（回放对照时使用）。 */
export function observationFromDb(
  row: typeof dbSchema.priceObservation.$inferSelect,
  sourceName: string,
): ObservationForValidation {
  return {
    observationKey: `${row.sourceId}:${row.fetchId}:${row.sourceRowIndex}`,
    observationId: row.id,
    sourceId: row.sourceId,
    sourceName,
    categoryId: row.categoryId,
    specId: row.specId,
    regionId: row.regionId,
    priceType: row.priceType,
    quoteDate: row.quoteDate,
    normValueLow: row.normValueLow === null ? null : Number(row.normValueLow),
    normValueHigh: row.normValueHigh === null ? null : Number(row.normValueHigh),
    initialStatus: row.validationStatus === 'needs_human' ? 'needs_human' : 'normalized',
    issues: [],
  };
}
