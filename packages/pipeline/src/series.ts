import { eq, inArray, sql } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { finishRun, registerRawFetch, startRun, withStep } from './ledger';
import { resolveRawStoreRoot, storeContent } from './store';

/**
 * 时序数据入库（market_series + series_point）。
 *
 * 为什么独立于 price_observation 的管线：期货合约、指数、库存不是「页面上的一行价目」，
 * 它们没有 raw_text 区间、不进规格字典、也不该参与现货均价（见 schema/series.ts 文件头）。
 * 但两者共用同一条不可变存档与同一套台账 —— 溯源能力必须一致。
 *
 * 幂等：同 (series, obs_date, revision) 的重复采集被唯一键挡住（ON CONFLICT DO NOTHING），
 * 所以「把同一段时间重跑一遍」是安全的，这是回填两年数据的执行基础。
 */

export interface SeriesRowInput {
  /** 品种代码，如 rb / cu / PCOPPUSDM。 */
  instrumentCode: string;
  /** 合约或序列明细码，如 rb2610；月频序列用品种码本身。 */
  contractCode: string;
  nameCn: string;
  /** 观测日 YYYY-MM-DD；月频用当月 1 日。 */
  obsDate: string;
  /** 主值（期货=结算价；指数=指数值；库存=量）。 */
  value: string;
  openPrice?: string | null;
  highPrice?: string | null;
  lowPrice?: string | null;
  closePrice?: string | null;
  settlePrice?: string | null;
  volume?: string | null;
  openInterest?: string | null;
  turnover?: string | null;
  detail?: Record<string, unknown>;
}

export interface SeriesIngestSpec {
  sourceId: string;
  layer: 'international' | 'national' | 'regional';
  kind: 'futures' | 'index' | 'inventory' | 'macro';
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';
  venue: string;
  /** unit.code，如 CNY_per_ton。 */
  unitCode: string;
  currency?: string;
  /** 序列 code 前缀，如 shfe → shfe.rb2610。 */
  codePrefix: string;
  /** 品种代码 → 品类 code（rb → scrap-steel）。缺省不挂品类。 */
  categoryByInstrument?: Record<string, string>;
  /** 区域层序列必须给 region code。 */
  regionCode?: string;
  displayAllowed?: boolean;
  /** 序列说明（展示层可读）。 */
  summary?: string;
}

export interface SeriesIngestDocument {
  url: string;
  fetchedAt: Date;
  httpStatus: number;
  contentType?: string;
  /** 原始响应正文（原样归档，永不改写）。 */
  body: string;
}

export interface SeriesIngestResult {
  runId: string;
  /** 本次是否复用了既有 run（同幂等键已成功）——复用时为零新增。 */
  reused: boolean;
  fetchId: string | null;
  seriesTouched: number;
  pointsInserted: number;
  pointsSkipped: number;
}

const num = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === '-' || s === '—') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : null;
};

export function normalizeShfeRow(row: Record<string, unknown>, obsDate: string): SeriesRowInput | null {
  const product = String(row.PRODUCTGROUPID ?? '').trim();
  const productId = String(row.PRODUCTID ?? '').trim();
  const month = String(row.DELIVERYMONTH ?? '').trim();
  // 只要期货合约（PRODUCTCLASS=1，PRODUCTID 形如 rb_f）；剔除期权/仓单/TAS 等其它行。
  if (!product || row.PRODUCTCLASS !== '1' || !/^\d{4}$/.test(month)) return null;
  if (!/^[a-z]{1,2}_f$/.test(productId)) return null;

  const settle = num(row.SETTLEMENTPRICE);
  const close = num(row.CLOSEPRICE);
  const value = settle ?? close;
  if (!value) return null;

  return {
    instrumentCode: product,
    contractCode: `${product}${month}`,
    nameCn: String(row.PRODUCTNAME ?? product).trim(),
    obsDate,
    value,
    openPrice: num(row.OPENPRICE),
    highPrice: num(row.HIGHESTPRICE),
    lowPrice: num(row.LOWESTPRICE),
    closePrice: close,
    settlePrice: settle,
    volume: num(row.VOLUME),
    openInterest: num(row.OPENINTEREST),
    turnover: num(row.TURNOVER),
    detail: {
      deliveryMonth: month,
      prevSettle: num(row.PRESETTLEMENTPRICE),
      productId,
    },
  };
}

/** 批量入库一个文档（一天的行情 / 一个月的序列）。 */
export async function ingestSeriesDocument(
  db: BeeDb,
  args: {
    spec: SeriesIngestSpec;
    doc: SeriesIngestDocument;
    rows: SeriesRowInput[];
    runId?: string;
    storeRoot?: string;
    idempotencyKey?: string;
    gitSha?: string;
  },
): Promise<SeriesIngestResult> {
  const { spec, doc, rows } = args;
  const storeRoot = args.storeRoot ?? resolveRawStoreRoot();

  const started = await startRun(db, {
    kind: 'daily_collect',
    triggeredBy: `series:${spec.codePrefix}`,
    idempotencyKey: args.idempotencyKey,
    configJson: {
      adapter: `${spec.codePrefix}_series`,
      url: doc.url,
      rows: rows.length,
      layer: spec.layer,
      kind: spec.kind,
    },
    pins: {
      gitSha: args.gitSha ?? process.env.GIT_SHA ?? 'workspace',
      rulesVersion: 'series-ingest@1.0.0',
      dictionaryHash: 'n/a',
    },
  });
  if (!started.claimed) {
    // 幂等语义（见 README 硬约束 1）：同键且已 succeeded = 这次不重复执行，按零新增汇报；
    // 在途/失败才拒绝（在途重入会双写，失败需人工或新 run 重跑）。
    if (started.run.status === 'succeeded') {
      return { runId: started.run.id, reused: true, fetchId: null, seriesTouched: 0, pointsInserted: 0, pointsSkipped: rows.length };
    }
    throw new Error(
      `run ${started.run.id} 的幂等键已被占用（状态 ${started.run.status}），拒绝重复执行；` +
        `重跑请换幂等键或等其终态`,
    );
  }
  const runId = started.run.id;

  try {
    // 存档 + 抓取登记先落（各自独立提交）：抓取「发生过」这件事不该因后续业务回滚而消失。
    const stored = await storeContent(storeRoot, {
      namespace: 'raw',
      body: doc.body,
      date: doc.fetchedAt,
    });
    const { fetch } = await registerRawFetch(db, {
      sourceId: spec.sourceId,
      runId,
      url: doc.url,
      fetchedAt: doc.fetchedAt,
      httpStatus: doc.httpStatus,
      contentSha256: stored.contentSha256,
      contentRef: stored.contentRef,
      contentType: doc.contentType,
      contentSizeBytes: Buffer.byteLength(doc.body, 'utf8'),
      fetchMeta: { adapter: `${spec.codePrefix}_series`, rows: rows.length },
    });

    const outcome = await withStep(
      db,
      {
        runId,
        stepKind: 'fetch',
        seq: 1,
        stepVersion: 'series-ingest@1.0.0',
        inputRefs: { fetch_id: fetch.id },
        outputRefs: (res: { fetchId: string; inserted: number; skipped: number }) => ({
          fetch_id: res.fetchId,
          inserted: res.inserted,
          skipped: res.skipped,
        }),
      },
      async (_step, tx) => {
        const [unit] = await tx
          .select({ id: dbSchema.unit.id })
          .from(dbSchema.unit)
          .where(eq(dbSchema.unit.code, spec.unitCode));
        if (!unit) throw new Error(`单位字典缺少 ${spec.unitCode}`);

        let regionId: string | null = null;
        if (spec.regionCode) {
          const [region] = await tx
            .select({ id: dbSchema.region.id })
            .from(dbSchema.region)
            .where(eq(dbSchema.region.code, spec.regionCode));
          if (!region) throw new Error(`地域字典缺少 ${spec.regionCode}`);
          regionId = region.id;
        }

        const categoryCodes = [...new Set(rows.map((r) => spec.categoryByInstrument?.[r.instrumentCode]).filter(Boolean))] as string[];
        const categoryRows = categoryCodes.length
          ? await tx
              .select({ id: dbSchema.category.id, code: dbSchema.category.code })
              .from(dbSchema.category)
              .where(inArray(dbSchema.category.code, categoryCodes))
          : [];
        const categoryByCode = new Map(categoryRows.map((c) => [c.code, c.id]));

        // 批量：先把本批涉及的序列一次性对齐（缺的补建），再一次性写点。
        // 逐行 upsert 在两年回填里会变成 15 万次往返，这里压成「一次查 + 一次补」。
        const codeOf = (row: SeriesRowInput) => `${spec.codePrefix}.${row.contractCode}`;
        const wanted = new Map<string, SeriesRowInput>();
        for (const row of rows) if (!wanted.has(codeOf(row))) wanted.set(codeOf(row), row);

        const existing = await tx
          .select({ id: dbSchema.marketSeries.id, code: dbSchema.marketSeries.code })
          .from(dbSchema.marketSeries)
          .where(inArray(dbSchema.marketSeries.code, [...wanted.keys()]));
        const idByCode = new Map(existing.map((r) => [r.code, r.id]));

        const missing = [...wanted.entries()].filter(([code]) => !idByCode.has(code));
        if (missing.length) {
          const insertedSeries = await tx
            .insert(dbSchema.marketSeries)
            .values(
              missing.map(([code, row]) => {
                const categoryCode = spec.categoryByInstrument?.[row.instrumentCode];
                return {
                  code,
                  // 期货按「品种 + 合约」命名；序列型数据（FRED/指数）合约码即品种码，直接用原名。
                  nameCn: row.contractCode === row.instrumentCode ? row.nameCn : `${row.nameCn} ${row.contractCode}`,
                  layer: spec.layer,
                  kind: spec.kind,
                  frequency: spec.frequency,
                  sourceId: spec.sourceId,
                  categoryId: categoryCode ? (categoryByCode.get(categoryCode) ?? null) : null,
                  regionId,
                  instrumentCode: row.instrumentCode,
                  venue: spec.venue,
                  unitId: unit.id,
                  currency: spec.currency ?? 'CNY',
                  externalRef: doc.url,
                  displayAllowed: spec.displayAllowed ?? true,
                  summary: spec.summary,
                  status: 'active' as const,
                };
              }),
            )
            .returning({ id: dbSchema.marketSeries.id, code: dbSchema.marketSeries.code });
          for (const r of insertedSeries) idByCode.set(r.code, r.id);
        }
        const seriesTouched = idByCode.size;

        const written = await tx
          .insert(dbSchema.seriesPoint)
          .values(
            rows.map((row, index) => ({
              seriesId: idByCode.get(codeOf(row))!,
              sourceId: spec.sourceId,
              obsDate: row.obsDate,
              value: row.value,
              openPrice: row.openPrice ?? null,
              highPrice: row.highPrice ?? null,
              lowPrice: row.lowPrice ?? null,
              closePrice: row.closePrice ?? null,
              settlePrice: row.settlePrice ?? null,
              volume: row.volume ?? null,
              openInterest: row.openInterest ?? null,
              turnover: row.turnover ?? null,
              detail: row.detail ?? null,
              fetchId: fetch.id,
              sourceRowIndex: index,
              runId,
            })),
          )
          // 幂等：同序列同日已有值时静默跳过（回填重跑的常态路径）。
          .onConflictDoNothing({
            target: [dbSchema.seriesPoint.seriesId, dbSchema.seriesPoint.obsDate, dbSchema.seriesPoint.revision],
          })
          .returning({ id: dbSchema.seriesPoint.id });
        const inserted = written.length;
        const skipped = rows.length - inserted;

        return { seriesTouched, inserted, skipped, fetchId: fetch.id };
      },
    );

    await finishRun(db, runId, { status: 'succeeded' });
    if (outcome.replayed || !outcome.result) {
      // 该步已有终局：本次没有重新执行（at-least-once 重投），按零新增汇报。
      return { runId, reused: false, fetchId: fetch.id, seriesTouched: 0, pointsInserted: 0, pointsSkipped: rows.length };
    }
    const value = outcome.result;
    return {
      runId,
      reused: false,
      fetchId: value.fetchId,
      seriesTouched: value.seriesTouched,
      pointsInserted: value.inserted,
      pointsSkipped: value.skipped,
    };
  } catch (err) {
    await finishRun(db, runId, { status: 'failed', error: (err as Error).message.slice(0, 500) }).catch(() => undefined);
    throw err;
  }
}

/** 序列 + 最近若干点，供展示层读取（三层页面的数据入口）。 */
export async function loadSeriesOverview(
  db: BeeDb,
  args: { layer?: 'international' | 'national' | 'regional'; limit?: number } = {},
): Promise<Array<{ code: string; nameCn: string; layer: string; kind: string; venue: string | null; points: number; latest: string | null; value: string | null }>> {
  const rows = await db.execute(sql`
    select s.code,
           s.name_cn,
           s.layer::text as layer,
           s.kind::text as kind,
           s.venue,
           count(p.id)::int as points,
           max(p.obs_date)::text as latest,
           (array_agg(p.value order by p.obs_date desc))[1]::text as value
      from market_series s
      left join series_point p on p.series_id = s.id
     where (${args.layer ?? null}::text is null or s.layer::text = ${args.layer ?? null}::text)
     group by s.id, s.code, s.name_cn, s.layer, s.kind, s.venue
     order by s.layer, s.code
     limit ${args.limit ?? 500}
  `);
  return rows.rows as never;
}