import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { v4, type BeeV4Db } from '@bee/db';
import { addDays, dateInShanghai, isDateString } from './dates';
import {
  composeMarkdown,
  deterministicUuid,
  tableCell,
  truncateText,
} from './markdown';
import { keyFor, type MarkdownStorage } from './storage';

/**
 * 日报 / 行业分析 / 价格预测的统一生成器。
 *
 * 三者都是确定性规则产出：只读 content(news_item) 与 price_daily，
 * 生成 Markdown → 上传 S3 → 按确定性 id upsert content。
 * 不调用任何大模型，也不预测具体点位。
 */

export interface GenerateConfig {
  content_date?: string;
  lookback_days?: number;
  horizon_days?: number;
}

export type GeneratedKind = 'news_digest' | 'analysis' | 'forecast';

export interface GenerateStats {
  news_items: number;
  price_rows: number;
  groups: number;
  samples: number;
  uploaded: number;
  upserted: number;
  reasons: Record<string, number>;
}

export interface GenerateOptions {
  now: Date;
  storage: MarkdownStorage;
}

export interface GenerateOutcome {
  kind: GeneratedKind;
  contentId: string;
  s3Key: string;
  title: string;
  stats: GenerateStats;
}

export function emptyGenerateStats(): GenerateStats {
  return {
    news_items: 0,
    price_rows: 0,
    groups: 0,
    samples: 0,
    uploaded: 0,
    upserted: 0,
    reasons: {},
  };
}

interface PricePoint {
  date: string;
  value: number;
  regionCode: string;
  regionName: string;
  regionSort: number;
  specCode: string | null;
  specName: string | null;
  specTier: number;
  unit: string;
  sourceCode: string | null;
}

interface GeneratedDoc {
  kind: GeneratedKind;
  title: string;
  summary: string;
  body: string;
  meta: Record<string, unknown>;
  contentDate: string;
  periodStart?: string;
  periodEnd?: string;
  sources: string[];
  stats: GenerateStats;
}

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(n: number): string {
  return n.toFixed(2);
}

function signedMoney(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

function percent(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function uniqueSources(...groups: (string | null | undefined)[][]): string[] {
  const set = new Set<string>();
  for (const group of groups) {
    for (const value of group) if (value) set.add(value);
  }
  return [...set];
}

async function listPricePoints(
  db: BeeV4Db,
  categoryId: string,
  from: string,
  to: string,
): Promise<PricePoint[]> {
  const rows = await db
    .select({
      date: sql<string>`${v4.priceDaily.priceDate}::text`,
      value: v4.priceDaily.valueMid,
      unit: v4.priceDaily.unit,
      regionCode: v4.region.code,
      regionName: v4.region.name,
      regionSort: v4.region.sortOrder,
      specCode: v4.spec.code,
      specName: v4.spec.name,
      specTier: sql<number>`coalesce(${v4.spec.tier}, 0)`,
      sourceCode: v4.source.code,
    })
    .from(v4.priceDaily)
    .innerJoin(v4.region, eq(v4.priceDaily.regionId, v4.region.id))
    .leftJoin(v4.spec, eq(v4.priceDaily.specId, v4.spec.id))
    .leftJoin(v4.source, eq(v4.priceDaily.sourceId, v4.source.id))
    .where(
      and(
        eq(v4.priceDaily.categoryId, categoryId),
        gte(v4.priceDaily.priceDate, from),
        lte(v4.priceDaily.priceDate, to),
        eq(v4.priceDaily.status, 'published'),
      ),
    )
    .orderBy(v4.priceDaily.priceDate, v4.region.sortOrder);

  return rows.flatMap((row) => {
    const value = toNumber(row.value);
    if (value === null) return [];
    return [
      {
        date: row.date,
        value,
        regionCode: row.regionCode,
        regionName: row.regionName,
        regionSort: row.regionSort,
        specCode: row.specCode ?? null,
        specName: row.specName ?? null,
        specTier: Number(row.specTier ?? 0),
        unit: row.unit,
        sourceCode: row.sourceCode ?? null,
      },
    ];
  });
}

function regionLabel(code: string, name: string): string {
  return name || code;
}

function specLabel(code: string | null, name: string | null): string {
  return name ?? code ?? '品类级';
}

/** ---------- 日报 ---------- */

async function buildDigest(
  db: BeeV4Db,
  category: typeof v4.category.$inferSelect,
  config: GenerateConfig,
  now: Date,
): Promise<GeneratedDoc> {
  const stats = emptyGenerateStats();
  const today = dateInShanghai(now);
  const contentDate = config.content_date ?? addDays(today, -1);
  if (!isDateString(contentDate)) {
    throw new Error(`config.content_date 不是 YYYY-MM-DD：${contentDate}`);
  }

  const items = await db
    .select({
      id: v4.content.id,
      title: v4.content.title,
      sourceCode: v4.source.code,
      sourceName: v4.source.name,
    })
    .from(v4.content)
    .leftJoin(v4.source, eq(v4.content.sourceId, v4.source.id))
    .where(
      and(
        eq(v4.content.categoryId, category.id),
        eq(v4.content.kind, 'news_item'),
        eq(v4.content.contentDate, contentDate),
        eq(v4.content.status, 'published'),
      ),
    )
    .orderBy(desc(v4.content.publishedAt), desc(v4.content.createdAt))
    .limit(10);
  stats.news_items = items.length;

  const [latest] = await db
    .select({ date: sql<string | null>`max(${v4.priceDaily.priceDate})::text` })
    .from(v4.priceDaily)
    .where(
      and(
        eq(v4.priceDaily.categoryId, category.id),
        lte(v4.priceDaily.priceDate, contentDate),
        eq(v4.priceDaily.status, 'published'),
      ),
    );

  const prices = latest?.date
    ? await listPricePoints(db, category.id, latest.date, latest.date)
    : [];
  stats.price_rows = prices.length;
  stats.samples = new Set(prices.map((p) => p.date)).size;
  stats.groups = new Set(prices.map((p) => `${p.regionCode}::${p.specCode ?? '-'}`)).size;

  const newsLines =
    items.length === 0
      ? ['- 当日暂无收录的新闻。']
      : items.map((item) => {
          const source = item.sourceName ?? item.sourceCode ?? '未标注来源';
          return `- ${tableCell(item.title)}（来源：${tableCell(source)}）`;
        });

  const priceLines =
    prices.length === 0
      ? ['当日暂无报价数据。']
      : [
          '| 地域 | 规格 | 价格（元/吨） | 日期 |',
          '| --- | --- | ---: | --- |',
          ...prices.map(
            (p) =>
              `| ${tableCell(regionLabel(p.regionCode, p.regionName))} | ${tableCell(specLabel(p.specCode, p.specName))} | ${tableCell(money(p.value))} | ${tableCell(p.date)} |`,
          ),
        ];

  const body = [
    `# ${category.nameCn}日报 · ${contentDate}`,
    '',
    '## 今日要点',
    ...newsLines,
    '',
    '## 价格速览',
    ...priceLines,
    '',
    '## 声明',
    '本日报由 bee 按当日已收录的新闻与报价自动聚合，价格取区间中值，仅供参考，不构成交易建议。',
  ].join('\n');

  const headline = items[0]?.title ?? null;
  const summary = truncateText(
    headline
      ? `${items.length} 条新闻：${headline}（${contentDate}）`
      : `收录 ${items.length} 条新闻、${prices.length} 条报价（${contentDate}）。`,
    160,
  );

  return {
    kind: 'news_digest',
    title: headline
      ? `${category.nameCn}日报 · ${contentDate}｜${truncateText(headline, 30)}`
      : `${category.nameCn}日报 · ${contentDate}`,
    summary,
    body,
    meta: {
      item_ids: items.map((item) => item.id),
      price_snapshot: prices.map((p) => ({
        region: regionLabel(p.regionCode, p.regionName),
        spec: specLabel(p.specCode, p.specName),
        value_mid: money(p.value),
        unit: p.unit,
        price_date: p.date,
      })),
    },
    contentDate,
    sources: uniqueSources(
      items.map((item) => item.sourceCode),
      prices.map((p) => p.sourceCode),
    ),
    stats,
  };
}

/** ---------- 分析 ---------- */

interface GroupedSeries {
  regionCode: string;
  regionName: string;
  regionSort: number;
  specCode: string | null;
  specName: string | null;
  specTier: number;
  points: PricePoint[];
}

function groupSeries(points: PricePoint[]): GroupedSeries[] {
  const map = new Map<string, GroupedSeries>();
  for (const point of points) {
    const key = `${point.regionCode}::${point.specCode ?? '-'}`;
    let group = map.get(key);
    if (!group) {
      group = {
        regionCode: point.regionCode,
        regionName: point.regionName,
        regionSort: point.regionSort,
        specCode: point.specCode,
        specName: point.specName,
        specTier: point.specTier,
        points: [],
      };
      map.set(key, group);
    }
    group.points.push(point);
  }
  for (const group of map.values()) {
    group.points.sort((a, b) => a.date.localeCompare(b.date));
  }
  return [...map.values()].sort(
    (a, b) =>
      a.regionSort - b.regionSort || b.specTier - a.specTier || a.regionCode.localeCompare(b.regionCode),
  );
}

function changeSince(
  points: PricePoint[],
  days: number,
): { delta: number; pct: number } | null {
  const latest = points[points.length - 1];
  if (!latest) return null;
  const cutoff = addDays(latest.date, -days);
  let base: PricePoint | undefined;
  for (const point of points) {
    if (point.date <= cutoff) base = point;
    else break;
  }
  if (!base || base.value === 0) return null;
  return { delta: latest.value - base.value, pct: ((latest.value - base.value) / base.value) * 100 };
}

async function buildAnalysis(
  db: BeeV4Db,
  category: typeof v4.category.$inferSelect,
  config: GenerateConfig,
  now: Date,
): Promise<GeneratedDoc> {
  const stats = emptyGenerateStats();
  const contentDate = config.content_date ?? dateInShanghai(now);
  if (!isDateString(contentDate)) {
    throw new Error(`config.content_date 不是 YYYY-MM-DD：${contentDate}`);
  }
  const lookback = Math.min(365, Math.max(1, Number(config.lookback_days ?? 30)));
  const from = addDays(contentDate, -lookback);

  const points = await listPricePoints(db, category.id, from, contentDate);
  const groups = groupSeries(points);
  const distinctDays = new Set(points.map((p) => p.date)).size;
  stats.price_rows = points.length;
  stats.groups = groups.length;
  stats.samples = distinctDays;

  const metrics = groups.map((group) => {
    const latest = group.points[group.points.length - 1];
    const values = group.points.map((p) => p.value);
    const change7 = changeSince(group.points, 7);
    const change30 = changeSince(group.points, 30);
    return {
      region: regionLabel(group.regionCode, group.regionName),
      region_code: group.regionCode,
      spec: specLabel(group.specCode, group.specName),
      spec_code: group.specCode,
      latest: latest ? Number(money(latest.value)) : null,
      latest_date: latest?.date ?? null,
      change_7d: change7 ? Number(change7.delta.toFixed(2)) : null,
      change_7d_pct: change7 ? Number(change7.pct.toFixed(2)) : null,
      change_30d: change30 ? Number(change30.delta.toFixed(2)) : null,
      change_30d_pct: change30 ? Number(change30.pct.toFixed(2)) : null,
      min: values.length ? Number(Math.min(...values).toFixed(2)) : null,
      max: values.length ? Number(Math.max(...values).toFixed(2)) : null,
      samples: group.points.length,
    };
  });

  const priceTable =
    metrics.length === 0
      ? ['统计窗口内暂无报价样本。']
      : [
          '| 地域 | 规格 | 最新价 | 7 日变化 | 30 日变化 | 区间（低–高） | 样本数 |',
          '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
          ...metrics.map((m) => {
            const change7 =
              m.change_7d_pct === null ? '—' : `${signedMoney(m.change_7d ?? 0)}（${percent(m.change_7d_pct)}）`;
            const change30 =
              m.change_30d_pct === null
                ? '—'
                : `${signedMoney(m.change_30d ?? 0)}（${percent(m.change_30d_pct)}）`;
            const range =
              m.min === null || m.max === null ? '—' : `${money(m.min)}–${money(m.max)}`;
            return `| ${tableCell(m.region)} | ${tableCell(m.spec)} | ${tableCell(m.latest === null ? '—' : money(m.latest))} | ${tableCell(change7)} | ${tableCell(change30)} | ${tableCell(range)} | ${tableCell(m.samples)} |`;
          }),
        ];

  let observation: string[];
  if (points.length === 0) {
    observation = [`近 ${lookback} 天（${from} 至 ${contentDate}）没有可用报价，无法形成分析。`];
  } else if (distinctDays <= 1) {
    observation = [
      `样本仅覆盖 ${distinctDays} 个报价日（${points.length} 条报价），样本不足，暂不构成趋势。`,
      '当前数值只能反映单一报价日的横截面价格，不能用于判断涨跌方向。',
    ];
  } else {
    const describable = metrics.filter((m) => m.change_7d_pct !== null);
    if (describable.length === 0) {
      observation = [
        `样本覆盖 ${distinctDays} 个报价日，但缺少 7 日以前的对照样本，暂不描述趋势方向。`,
      ];
    } else {
      const mover = describable
        .slice()
        .sort((a, b) => Math.abs(b.change_7d_pct ?? 0) - Math.abs(a.change_7d_pct ?? 0))[0];
      observation = [
        `样本覆盖 ${distinctDays} 个报价日。近 7 日变化最明显的是 ${mover?.region} · ${mover?.spec}（${percent(mover?.change_7d_pct ?? 0)}）。`,
        '以上为历史报价的规则性统计，不预测未来点位。',
      ];
    }
  }

  const body = [
    `# ${category.nameCn}行情分析 · ${contentDate}`,
    '',
    '## 样本范围',
    `- 品类：${category.nameCn}`,
    `- 统计窗口：${from} 至 ${contentDate}（近 ${lookback} 天）`,
    `- 报价样本：${points.length} 行，覆盖 ${distinctDays} 个报价日、${groups.length} 个地域/规格组合`,
    '- 价格口径：区间中值，单位以报价表为准',
    '',
    '## 价格表',
    ...priceTable,
    '',
    '## 变化',
    distinctDays <= 1
      ? '- 仅有单一报价日，7 日/30 日变化均无对照样本。'
      : `- 逐项 7 日/30 日变化见上表；无对照样本的单元格记为「—」。`,
    '',
    '## 观察',
    ...observation.map((line) => `- ${line}`),
    '',
    '## 声明',
    '本分析由 bee 基于历史报价的确定性统计生成，不构成投资或交易建议。',
  ].join('\n');

  return {
    kind: 'analysis',
    title: `${category.nameCn}行情分析 · ${contentDate}`,
    summary: truncateText(
      points.length === 0
        ? `近 ${lookback} 天暂无报价样本。`
        : `近 ${lookback} 天共 ${points.length} 条报价样本，覆盖 ${distinctDays} 个报价日、${groups.length} 个地域/规格组合。`,
      160,
    ),
    body,
    meta: { metrics, method: 'deterministic-v1' },
    contentDate,
    sources: uniqueSources(points.map((p) => p.sourceCode)),
    stats,
  };
}

/** ---------- 预测 ---------- */

interface ForecastRead {
  direction: 'up' | 'down' | 'flat';
  confidence: 'low' | 'medium' | 'high';
  invalidation: string;
  ma5: number | null;
  ma20: number | null;
  dailyAverage: number | null;
  samples: number;
  rows: number;
}

function dailyAverages(points: PricePoint[]): { date: string; value: number }[] {
  const byDate = new Map<string, number[]>();
  for (const point of points) {
    const list = byDate.get(point.date);
    if (list) list.push(point.value);
    else byDate.set(point.date, [point.value]);
  }
  return [...byDate.entries()]
    .map(([date, values]) => ({ date, value: values.reduce((s, v) => s + v, 0) / values.length }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function readForecast(points: PricePoint[]): ForecastRead {
  const series = dailyAverages(points);
  const values = series.map((s) => s.value);
  const n = values.length;
  if (n === 0) {
    return {
      direction: 'flat',
      confidence: 'low',
      invalidation: '没有可用报价样本，预测不可用。',
      ma5: null,
      ma20: null,
      dailyAverage: null,
      samples: 0,
      rows: points.length,
    };
  }

  const ma5 = mean(values.slice(-Math.min(5, n)));
  const ma20 = mean(values.slice(-Math.min(20, n)));
  const dailyAverage = values[n - 1] ?? null;
  if (ma5 === null || ma20 === null || ma20 === 0) {
    return {
      direction: 'flat',
      confidence: 'low',
      invalidation: '均价为 0 或样本异常，预测不可用。',
      ma5,
      ma20,
      dailyAverage,
      samples: n,
      rows: points.length,
    };
  }

  const gap = (ma5 - ma20) / ma20;
  let direction: ForecastRead['direction'] = 'flat';
  if (gap > 0.003) direction = 'up';
  else if (gap < -0.003) direction = 'down';

  const absGap = Math.abs(gap);
  let confidence: ForecastRead['confidence'] = 'low';
  if (n >= 20 && absGap >= 0.01) confidence = 'high';
  else if (n >= 5 && absGap >= 0.005) confidence = 'medium';

  const lower = ma20 * 0.98;
  const upper = ma20 * 1.02;
  let invalidation: string;
  if (direction === 'up') {
    invalidation = `若日均价连续两个报价日跌破 ${money(lower)} 元/吨（20 日均价下方 2%），上行判断失效。`;
  } else if (direction === 'down') {
    invalidation = `若日均价连续两个报价日升破 ${money(upper)} 元/吨（20 日均价上方 2%），下行判断失效。`;
  } else {
    invalidation = `若日均价升破 ${money(upper)} 元/吨或跌破 ${money(lower)} 元/吨（20 日均价上下 2%），横盘判断失效。`;
  }

  return { direction, confidence, invalidation, ma5, ma20, dailyAverage, samples: n, rows: points.length };
}

const DIRECTION_ZH: Record<ForecastRead['direction'], string> = {
  up: '上行',
  down: '下行',
  flat: '横盘',
};

const CONFIDENCE_ZH: Record<ForecastRead['confidence'], string> = {
  high: '高',
  medium: '中',
  low: '低',
};

async function buildForecast(
  db: BeeV4Db,
  category: typeof v4.category.$inferSelect,
  config: GenerateConfig,
  now: Date,
): Promise<GeneratedDoc> {
  const stats = emptyGenerateStats();
  const contentDate = config.content_date ?? dateInShanghai(now);
  if (!isDateString(contentDate)) {
    throw new Error(`config.content_date 不是 YYYY-MM-DD：${contentDate}`);
  }
  const horizon = Math.min(60, Math.max(1, Number(config.horizon_days ?? 7)));
  const periodStart = addDays(contentDate, 1);
  const periodEnd = addDays(periodStart, horizon);
  const from = addDays(contentDate, -30);

  const points = await listPricePoints(db, category.id, from, contentDate);
  if (points.length === 0) throw new Error('最近 30 天没有报价样本，无法生成预测');
  const read = readForecast(points);
  stats.price_rows = read.rows;
  stats.samples = read.samples;
  stats.groups = groupSeries(points).length;

  const degraded: string[] = [];
  if (read.samples < 5) degraded.push(`报价日不足 5 个（实际 ${read.samples} 个），MA5 退化为全部样本均值`);
  if (read.samples < 20) degraded.push(`报价日不足 20 个（实际 ${read.samples} 个），MA20 退化为全部样本均值`);

  const basis = [
    `- 样本：最近 30 天内 ${read.rows} 条报价、${read.samples} 个报价日；最新日均价 ${read.dailyAverage === null ? '—' : money(read.dailyAverage)} 元/吨。`,
    `- MA5 = ${read.ma5 === null ? '—' : money(read.ma5)}；MA20 = ${read.ma20 === null ? '—' : money(read.ma20)}。`,
    `- 规则：MA5 相对 MA20 变化 ${read.ma5 === null || read.ma20 === null || read.ma20 === 0 ? '—' : percent(((read.ma5 - read.ma20) / read.ma20) * 100)}，阈值 ±0.30%，据此判定${DIRECTION_ZH[read.direction]}。`,
    ...degraded.map((line) => `- 说明：${line}。`),
  ];

  const body = [
    `# ${category.nameCn}价格预测 · ${periodStart} 至 ${periodEnd}`,
    '',
    '## 方向',
    `**${DIRECTION_ZH[read.direction]}（${read.direction}）**，置信度：${CONFIDENCE_ZH[read.confidence]}（${read.confidence}）。`,
    '',
    '## 依据',
    ...basis,
    '',
    '## 推翻条件',
    read.invalidation,
    '',
    '## 免责声明',
    '本预测由确定性规则（移动平均外推）生成，未使用大模型，也不给出具体点位；仅基于历史报价，不构成任何投资或交易建议。',
  ].join('\n');

  return {
    kind: 'forecast',
    title: `${category.nameCn}价格预测 · ${periodStart} 至 ${periodEnd}`,
    summary: truncateText(
      `未来 ${horizon} 天（${periodStart} 至 ${periodEnd}）方向：${DIRECTION_ZH[read.direction]}，置信度：${CONFIDENCE_ZH[read.confidence]}。`,
      160,
    ),
    body,
    meta: {
      direction: read.direction,
      confidence: read.confidence,
      invalidation: read.invalidation,
      method: 'deterministic-v1',
      samples: read.samples,
    },
    contentDate,
    periodStart,
    periodEnd,
    sources: uniqueSources(points.map((p) => p.sourceCode)),
    stats,
  };
}

/** ---------- 统一入口 ---------- */

export async function generateContent(
  db: BeeV4Db,
  job: typeof v4.job.$inferSelect,
  runId: string,
  options: GenerateOptions,
): Promise<GenerateOutcome> {
  if (!job.categoryId) throw new Error('生成任务缺少品类：job.category_id 为空');
  const [category] = await db
    .select()
    .from(v4.category)
    .where(eq(v4.category.id, job.categoryId))
    .limit(1);
  if (!category) throw new Error(`品类不存在：${job.categoryId}`);

  const config = (job.config ?? {}) as GenerateConfig;

  let doc: GeneratedDoc;
  switch (job.kind) {
    case 'digest':
      doc = await buildDigest(db, category, config, options.now);
      break;
    case 'analysis':
      doc = await buildAnalysis(db, category, config, options.now);
      break;
    case 'forecast':
      doc = await buildForecast(db, category, config, options.now);
      break;
    default:
      throw new Error(`generateContent 不处理 job.kind=${job.kind}`);
  }

  // 区域固定为全国（region_id = null），确定性 id 的业务键里显式写 national。
  const id = deterministicUuid(
    [doc.kind, category.code, 'national', doc.contentDate, doc.periodStart ?? '', doc.periodEnd ?? ''].join(
      '|',
    ),
  );
  const s3Key = keyFor(doc.kind, category.code, doc.contentDate, id);
  const markdown = composeMarkdown(
    {
      id,
      kind: doc.kind,
      category: category.nameCn,
      categoryCode: category.code,
      region: '全国',
      date: doc.contentDate,
      periodStart: doc.periodStart,
      periodEnd: doc.periodEnd,
      sources: doc.sources,
      license: 'licensed',
      generatedAt: options.now.toISOString(),
    },
    doc.body,
  );

  const uploaded = await options.storage.putMarkdown(s3Key, markdown);
  doc.stats.uploaded = 1;

  await db
    .insert(v4.content)
    .values({
      id,
      categoryId: category.id,
      regionId: null,
      kind: doc.kind,
      title: doc.title,
      summary: doc.summary,
      bodyMdKey: uploaded.key,
      bodySha256: uploaded.sha256,
      assets: [],
      meta: doc.meta,
      contentDate: doc.contentDate,
      periodStart: doc.periodStart ?? null,
      periodEnd: doc.periodEnd ?? null,
      sourceId: null,
      url: null,
      urlHash: null,
      license: 'licensed',
      visibility: 'public',
      status: 'published',
      publishedAt: options.now,
      runId,
      updatedAt: options.now,
    })
    .onConflictDoUpdate({
      target: v4.content.id,
      set: {
        title: doc.title,
        summary: doc.summary,
        bodyMdKey: uploaded.key,
        bodySha256: uploaded.sha256,
        meta: doc.meta,
        contentDate: doc.contentDate,
        periodStart: doc.periodStart ?? null,
        periodEnd: doc.periodEnd ?? null,
        license: 'licensed',
        visibility: 'public',
        status: 'published',
        publishedAt: options.now,
        runId,
        updatedAt: options.now,
      },
    });
  doc.stats.upserted = 1;

  return {
    kind: doc.kind,
    contentId: id,
    s3Key,
    title: doc.title,
    stats: doc.stats,
  };
}