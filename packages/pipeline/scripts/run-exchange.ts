/**
 * 交易所日行情 → market_series / series_point（三层数据里的「国内全国」层）。
 *
 * 用法：
 *   pnpm series:exchange --from 2026-09-01 --to 2026-10-27 --venue shfe,ine
 *   pnpm series:exchange --from 2024-10-01 --to 2026-10-27 --venue shfe --rate 3000
 *
 * 行为：
 *  - 按自然日遍历；非交易日（404）跳过，不落存档、不记点；
 *  - 每个交易日一份原始 JSON 归档（内容寻址）+ 一份抓取登记 + 一组 series_point；
 *  - 幂等：同一交易日重跑不会产生重复点（唯一键 + ON CONFLICT DO NOTHING）。
 */
import { fileURLToPath } from 'node:url';
import { createDb, resolveDatabaseUrl } from '@bee/db';
import {
  CATEGORY_BY_INSTRUMENT,
  ingestSeriesDocument,
  normalizeShfeRow,
  seedSeriesSources,
  type SeriesRowInput,
} from '../src';
import { seedPipelineDictionaries } from '../tests/helpers/seed';

const STORE_ROOT = fileURLToPath(new URL('../../../data/raw-store', import.meta.url));

const VENUES = {
  shfe: {
    code: 'shfe',
    venue: 'SHFE',
    url: (d: string) => `https://www.shfe.com.cn/data/tradedata/future/dailydata/kx${d}.dat`,
  },
  ine: {
    code: 'ine',
    venue: 'INE',
    url: (d: string) => `https://www.ine.cn/data/tradedata/future/dailydata/kx${d}.dat`,
  },
} as const;

type VenueKey = keyof typeof VENUES;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ymd = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const iso = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

const UA =
  'Mozilla/5.0 (compatible; BeeDataBot/0.1; +https://github.com/khvysofq/bee; purpose=market-data)';

async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    console.error('缺少 DATABASE_URL：先复制 .env.example 为 .env，并启动本地 Postgres。');
    process.exit(1);
  }

  const from = new Date(argValue('from') ?? iso(new Date(Date.now() - 30 * 86400_000)));
  const to = new Date(argValue('to') ?? iso(new Date()));
  const rate = Number(argValue('rate') ?? '2000');
  const venueKeys = (argValue('venue') ?? 'shfe,ine').split(',').map((s) => s.trim()) as VenueKey[];
  for (const k of venueKeys) {
    if (!VENUES[k]) {
      console.error(`未知交易所 ${k}，可选：${Object.keys(VENUES).join(' / ')}`);
      process.exit(1);
    }
  }

  const db = createDb(connectionString);
  try {
    console.log('种子：基础字典 + 交易所来源（幂等）...');
    await seedPipelineDictionaries(db);
    const sourceIds = await seedSeriesSources(db);

    const totals = { days: 0, tradingDays: 0, nonTrading: 0, failed: 0, points: 0, skipped: 0 };

    for (const key of venueKeys) {
      const v = VENUES[key];
      console.log(`\n== ${v.venue} ${iso(from)} .. ${iso(to)} ==`);
      for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
        const day = ymd(d);
        const dayIso = iso(d);
        totals.days++;
        const url = v.url(day);
        let body: string | null = null;
        try {
          const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
          if (res.status === 404) {
            totals.nonTrading++;
            await sleep(rate);
            continue;
          }
          if (!res.ok) {
            totals.failed++;
            console.warn(`! ${v.venue} ${dayIso} HTTP ${res.status}`);
            await sleep(rate);
            continue;
          }
          body = await res.text();
        } catch (err) {
          totals.failed++;
          console.warn(`! ${v.venue} ${dayIso} ${(err as Error).message}`);
          await sleep(rate);
          continue;
        }
        await sleep(rate);

        let payload: { o_curinstrument?: Array<Record<string, unknown>> };
        try {
          payload = JSON.parse(body);
        } catch {
          totals.failed++;
          console.warn(`! ${v.venue} ${dayIso} 响应不是 JSON`);
          continue;
        }
        const rawRows = payload.o_curinstrument ?? [];
        const rows: SeriesRowInput[] = [];
        for (const r of rawRows) {
          const row = normalizeShfeRow(r, dayIso);
          if (row) rows.push(row);
        }
        if (!rows.length) {
          totals.nonTrading++;
          continue;
        }

        const result = await ingestSeriesDocument(db, {
          spec: {
            sourceId: sourceIds.get(v.code)!,
            layer: 'national',
            kind: 'futures',
            frequency: 'daily',
            venue: v.venue,
            unitCode: 'CNY_per_ton',
            currency: 'CNY',
            codePrefix: v.code,
            categoryByInstrument: CATEGORY_BY_INSTRUMENT,
            summary: `${v.venue} 日行情结算价（期货，预期价，非现货）`,
          },
          doc: {
            url,
            fetchedAt: new Date(),
            httpStatus: 200,
            contentType: 'application/json',
            body,
          },
          rows,
          storeRoot: STORE_ROOT,
          idempotencyKey: `series:${v.code}:${day}`,
        });
        totals.tradingDays++;
        totals.points += result.pointsInserted;
        totals.skipped += result.pointsSkipped;
        if (result.pointsInserted) {
          console.log(
            `  ${v.venue} ${dayIso}: +${result.pointsInserted} 点（${result.seriesTouched} 合约）`,
          );
        }
      }
    }

    console.log('\n完成：', JSON.stringify(totals, null, 2));
  } finally {
    await db.$client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});