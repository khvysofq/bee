/**
 * 把国家统计局「流通领域重要生产资料市场价格」旬报跑进当前 DATABASE_URL。
 *
 * 默认联网抓取统计局公报索引的最新一期；`--snapshot <html> --document-url <url>`
 * 可离线回放已归档快照。数字全部来自 HTML 表格的确定性抽取，不调用 LLM。
 *
 * 用法：pnpm data:stats
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { desc, eq } from 'drizzle-orm';
import { createDb, dbSchema, resolveDatabaseUrl } from '@bee/db';
import {
  createSourceRegistry,
  runFixturePipeline,
  seedStatsDictionaries,
  STATS_ATTRIBUTION,
  STATS_LICENSE_ID,
  STATS_SOURCE_CODE,
  type StatsAdapterOptions,
} from '../src';
import { seedPipelineDictionaries } from '../tests/helpers/seed';

const STORE_ROOT = fileURLToPath(new URL('../../../data/raw-store', import.meta.url));

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    console.error('缺少 DATABASE_URL：先复制 .env.example 为 .env，并启动本地 Postgres。');
    process.exit(1);
  }

  const snapshotPath = argValue('--snapshot');
  const documentUrl = argValue('--document-url');
  const statsOptions: StatsAdapterOptions | undefined =
    snapshotPath || documentUrl ? { snapshotPath, documentUrl } : undefined;

  const db = createDb(connectionString);
  try {
    console.log('种子：基础字典 + 统计局来源/锚点规格/映射（幂等）...');
    await seedPipelineDictionaries(db);
    await seedStatsDictionaries(db);

    const idempotencyKey = process.env.STATS_RUN_KEY ?? `stats:dev:${randomUUID()}`;
    console.log(`运行统计局旬价管线（idempotencyKey=${idempotencyKey}，${snapshotPath ? '快照回放' : '联网抓取'}）...`);
    const summary = await runFixturePipeline({
      db,
      storeRoot: STORE_ROOT,
      adapters: createSourceRegistry({ stats: statsOptions }),
      sourceCodes: [STATS_SOURCE_CODE],
      allowedLicenses: [STATS_LICENSE_ID],
      idempotencyKey,
      triggeredBy: 'manual:stats-script',
      gitSha: process.env.GIT_SHA ?? 'workspace',
    });

    const [fetch] = await db
      .select({ url: dbSchema.rawFetch.url, contentSha256: dbSchema.rawFetch.contentSha256 })
      .from(dbSchema.rawFetch)
      .where(eq(dbSchema.rawFetch.runId, summary.run.id));
    const [latestQuote] = await db
      .select({ quoteDate: dbSchema.dailyQuote.quoteDate })
      .from(dbSchema.dailyQuote)
      .where(eq(dbSchema.dailyQuote.computationRunId, summary.run.id))
      .orderBy(desc(dbSchema.dailyQuote.quoteDate))
      .limit(1);

    console.log('统计局旬价数据链完成：');
    console.log(
      JSON.stringify(
        {
          runId: summary.run.id,
          runStatus: summary.run.status,
          counts: summary.counts,
          rawFetches: summary.rawFetchIds.length,
          observations: summary.observationIds.length,
          quotes: summary.quoteIds.length,
          indicators: summary.indicatorIds.length,
          exceptions: summary.exceptionIds.length,
          latestQuoteDate: latestQuote?.quoteDate ?? null,
          sourceUrl: fetch?.url ?? null,
          contentSha256: fetch?.contentSha256 ?? null,
          attribution: STATS_ATTRIBUTION,
          storeRoot: STORE_ROOT,
        },
        null,
        2,
      ),
    );
  } finally {
    await db.$client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
