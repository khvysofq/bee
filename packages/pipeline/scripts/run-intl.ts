/**
 * 国际层（L1）月频序列 → market_series / series_point。
 *
 * 用法：pnpm series:intl            # 抓全部已登记 FRED 序列
 *      pnpm series:intl --only PCOPPUSDM
 *
 * 行为：每条序列一次请求，整段历史一次入库（FRED CSV 就是全历史），幂等重跑不重复写。
 */
import { fileURLToPath } from 'node:url';
import { createDb, resolveDatabaseUrl } from '@bee/db';
import {
  FRED_SERIES,
  ingestSeriesDocument,
  parseFredCsv,
  seedFredSource,
  seedIntlUnits,
} from '../src';
import { seedPipelineDictionaries } from '../tests/helpers/seed';

const STORE_ROOT = fileURLToPath(new URL('../../../data/raw-store', import.meta.url));
const UA = 'Mozilla/5.0 (compatible; BeeDataBot/0.1; purpose=market-data)';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }
  const only = argValue('only');
  const targets = only ? FRED_SERIES.filter((s) => s.id === only || s.code === only) : FRED_SERIES;

  const db = createDb(connectionString);
  try {
    await seedPipelineDictionaries(db);
    await seedIntlUnits(db);
    const sourceId = await seedFredSource(db);

    for (const def of targets) {
      const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${def.id}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        console.warn(`! ${def.id} HTTP ${res.status}`);
        continue;
      }
      const body = await res.text();
      const rows = parseFredCsv(body, def.id).map((r) => ({ ...r, nameCn: def.nameCn }));
      if (!rows.length) {
        console.warn(`! ${def.id} 无可解析行`);
        continue;
      }
      const result = await ingestSeriesDocument(db, {
        spec: {
          sourceId,
          layer: 'international',
          kind: 'index',
          frequency: 'monthly',
          venue: 'FRED',
          unitCode: def.unitCode,
          currency: 'USD',
          codePrefix: 'fred',
          categoryByInstrument: def.categoryCode ? { [def.id]: def.categoryCode } : {},
          summary: def.note,
        },
        doc: {
          url,
          fetchedAt: new Date(),
          httpStatus: 200,
          contentType: 'text/csv',
          body,
        },
        rows,
        storeRoot: STORE_ROOT,
        idempotencyKey: `series:intl:${def.id}`,
      });
      console.log(
        `${def.code}: +${result.pointsInserted} 点（跳过 ${result.pointsSkipped}），${rows[0]!.obsDate} → ${rows.at(-1)!.obsDate}`,
      );
    }
  } finally {
    await db.$client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
