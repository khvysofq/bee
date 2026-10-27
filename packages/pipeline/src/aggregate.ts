import { and, eq, inArray } from 'drizzle-orm';
import { dbSchema } from '@bee/db';
import type { BeeDbOrTx } from './ledger';
import type { DailyQuoteRow, DerivedIndicatorRow } from './types';

export const AGGREGATE_VERSION = 'aggregate@1.0.0';

/** 统计局等「来源直发全国参考价」的定档口径前缀；页面与指标必须展示，禁止当成废料分档现货。 */
export const ANCHOR_COVERAGE_NOTE =
  '全国参考锚点价（原生品，非废料分档现货；区域分档暂缺）';

function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function money(value: number): string {
  return value.toFixed(2);
}

/**
 * 定档：同一（品类×规格×地域×日期×价类型）下，只消费 validated 观测。
 * 多源用中位，单源直取；区间取贡献观测的最小下界/最大上界，中值是各源中位的中位。
 */
export async function aggregateDailyQuotes(
  tx: BeeDbOrTx,
  args: { runId: string | null; observationIds: string[]; rulesVersion: string; methodVersion?: string },
): Promise<DailyQuoteRow[]> {
  if (args.observationIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(dbSchema.priceObservation)
    .where(
      and(
        inArray(dbSchema.priceObservation.id, args.observationIds),
        eq(dbSchema.priceObservation.validationStatus, 'validated'),
      ),
    );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.categoryId || !row.specId || !row.regionId || !row.priceType || !row.quoteDate) continue;
    if (row.normValueLow === null || row.normValueHigh === null) continue;
    const key = [row.categoryId, row.specId, row.regionId, row.quoteDate, row.priceType].join('|');
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const quotes: DailyQuoteRow[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const lows = group.map((row) => num(row.normValueLow)).filter((v): v is number => v !== null);
    const highs = group.map((row) => num(row.normValueHigh)).filter((v): v is number => v !== null);
    const mids = group.map((row) => {
      const low = num(row.normValueLow);
      const high = num(row.normValueHigh);
      return low === null || high === null ? null : (low + high) / 2;
    }).filter((v): v is number => v !== null);
    if (lows.length === 0 || highs.length === 0 || mids.length === 0) continue;
    const sourceCount = new Set(group.map((row) => row.sourceId)).size;
    const method = sourceCount === 1 ? 'single_source' : 'median_multi_source';
    const valueMid = median(mids);
    const groupSourceIds = [...new Set(group.map((row) => row.sourceId))];
    const groupSources = await tx
      .select({ id: dbSchema.source.id, fetcherKind: dbSchema.source.fetcherKind })
      .from(dbSchema.source)
      .where(inArray(dbSchema.source.id, groupSourceIds));
    const isAnchorQuote = groupSources.length > 0 && groupSources.every((source) => source.fetcherKind === 'stats_bulletin');
    const coverageNote = isAnchorQuote
      ? `${ANCHOR_COVERAGE_NOTE}；来源：国家统计局旬报（全国口径）`
      : `覆盖 ${sourceCount} 个来源；仅 validated 观测参与定档`;
    const [quote] = await tx
      .insert(dbSchema.dailyQuote)
      .values({
        categoryId: first.categoryId!,
        specId: first.specId!,
        regionId: first.regionId!,
        quoteDate: first.quoteDate!,
        priceType: first.priceType!,
        valueLow: money(Math.min(...lows)),
        valueHigh: money(Math.max(...highs)),
        valueMid: money(valueMid),
        method,
        contributingObservationIds: group.map((row) => row.id),
        sourceCount,
        methodVersion: args.methodVersion ?? AGGREGATE_VERSION,
        rulesVersion: args.rulesVersion,
        computationRunId: args.runId,
        confidence: sourceCount >= 2 ? 'high' : 'medium',
        coverageNote,
        status: 'draft',
      })
      .onConflictDoUpdate({
        target: [
          dbSchema.dailyQuote.categoryId,
          dbSchema.dailyQuote.specId,
          dbSchema.dailyQuote.regionId,
          dbSchema.dailyQuote.quoteDate,
          dbSchema.dailyQuote.priceType,
        ],
        set: {
          valueLow: money(Math.min(...lows)),
          valueHigh: money(Math.max(...highs)),
          valueMid: money(valueMid),
          method,
          contributingObservationIds: group.map((row) => row.id),
          sourceCount,
          methodVersion: args.methodVersion ?? AGGREGATE_VERSION,
          rulesVersion: args.rulesVersion,
          computationRunId: args.runId,
          confidence: sourceCount >= 2 ? 'high' : 'medium',
          coverageNote,
          updatedAt: new Date(),
        },
      })
      .returning();
    quotes.push(quote!);
  }
  return quotes;
}

/**
 * 全国加工指标：对同一（品类×规格×价类型×日期）的各城市定档价等权聚合。
 * 指标与贡献明细在同一事务写入；权重快照落在 method_json，贡献明细逐条可回溯。
 */
export async function aggregateNationalIndicators(
  tx: BeeDbOrTx,
  args: { runId: string; quotes: DailyQuoteRow[]; methodVersion?: string },
): Promise<DerivedIndicatorRow[]> {
  const countryRegion = await tx
    .select({ id: dbSchema.region.id })
    .from(dbSchema.region)
    .where(eq(dbSchema.region.level, 'country'))
    .limit(1);
  const countryId = countryRegion[0]?.id;
  if (!countryId) throw new Error('缺少 country 根节点，无法计算全国加工指标');

  const groups = new Map<string, DailyQuoteRow[]>();
  for (const quote of args.quotes) {
    const key = [quote.categoryId, quote.specId, quote.priceType, quote.quoteDate].join('|');
    const list = groups.get(key) ?? [];
    list.push(quote);
    groups.set(key, list);
  }

  const indicators: DerivedIndicatorRow[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const weight = 1 / group.length;
    const value = group.reduce((sum, quote) => sum + Number(quote.valueMid) * weight, 0);
    const weights: Record<string, number> = {};
    for (const quote of group) weights[quote.regionId] = weight;

    const isAnchorIndicator = first.coverageNote?.startsWith(ANCHOR_COVERAGE_NOTE) ?? false;
    const kind = isAnchorIndicator ? 'national_reference' : 'national_weighted_avg';
    const methodJson = isAnchorIndicator
      ? {
          weights,
          basis: '来源直接发布的全国参考价（单点，非本系统按城市聚合）',
          note: '全国参考锚点价：原生品价格，不是废料分档现货价；区域分档暂缺。',
          formula: '直接引用',
        }
      : {
          weights,
          basis: '按各参与城市当日定档价等权加权',
          note: '加工指标，不是观测值；不可作为某地实际成交价引用',
          formula: '加权平均',
        };

    const [indicator] = await tx
      .insert(dbSchema.derivedIndicator)
      .values({
        kind,
        categoryId: first.categoryId,
        specId: first.specId,
        regionId: countryId,
        priceType: first.priceType,
        basisDate: first.quoteDate,
        value: money(value),
        methodJson,
        methodVersion: args.methodVersion ?? AGGREGATE_VERSION,
        computationRunId: args.runId,
        isAggregate: 1,
      })
      .onConflictDoUpdate({
        target: [
          dbSchema.derivedIndicator.kind,
          dbSchema.derivedIndicator.categoryId,
          dbSchema.derivedIndicator.specId,
          dbSchema.derivedIndicator.regionId,
          dbSchema.derivedIndicator.priceType,
          dbSchema.derivedIndicator.basisDate,
        ],
        set: {
          value: money(value),
          methodJson,
          methodVersion: args.methodVersion ?? AGGREGATE_VERSION,
          computationRunId: args.runId,
        },
      })
      .returning();

    await tx.delete(dbSchema.indicatorContribution).where(eq(dbSchema.indicatorContribution.indicatorId, indicator!.id));
    await tx.insert(dbSchema.indicatorContribution).values(
      group.map((quote) => ({
        indicatorId: indicator!.id,
        quoteId: quote.id,
        valueAtAggregation: quote.valueMid,
        weight: weight.toFixed(6),
      })),
    );
    indicators.push(indicator!);
  }
  return indicators;
}

export async function publishQuotes(
  tx: BeeDbOrTx,
  args: { quoteIds: string[]; publishedAt?: Date },
): Promise<number> {
  if (args.quoteIds.length === 0) return 0;
  const updated = await tx
    .update(dbSchema.dailyQuote)
    .set({ status: 'published', publishedAt: args.publishedAt ?? new Date(), updatedAt: new Date() })
    .where(and(inArray(dbSchema.dailyQuote.id, args.quoteIds), eq(dbSchema.dailyQuote.status, 'draft')))
    .returning({ id: dbSchema.dailyQuote.id });
  return updated.length;
}
