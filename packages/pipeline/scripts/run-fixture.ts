/**
 * 把 P0-3 fixture 数据链跑进当前 DATABASE_URL 指向的开发库。
 *
 * 用途：P0-4 简报页本地验收需要「真实来自 P0-3 管线」的数据，而不是手写 seed。
 * 该脚本复用 P0-3 集成测试的字典/来源种子与 fixture 适配器，产出：
 * raw_content/raw_fetch → price_observation → validation_result → daily_quote/derived_indicator。
 *
 * 用法：pnpm data:fixture
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb, dbSchema, resolveDatabaseUrl } from '@bee/db';
import { runFixturePipeline } from '../src';
import { seedPipelineDictionaries } from '../tests/helpers/seed';

const STORE_ROOT = fileURLToPath(new URL('../../../data/raw-store', import.meta.url));

async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    console.error('缺少 DATABASE_URL：先复制 .env.example 为 .env，并启动本地 Postgres。');
    process.exit(1);
  }

  const db = createDb(connectionString);
  try {
    console.log('种子：fixture 字典 / 来源 / 映射（幂等）...');
    await seedPipelineDictionaries(db);

    const idempotencyKey = process.env.FIXTURE_RUN_KEY ?? `fixture:dev:${randomUUID()}`;
    console.log(`运行 P0-3 fixture 管线（idempotencyKey=${idempotencyKey}）...`);
    const summary = await runFixturePipeline({
      db,
      storeRoot: STORE_ROOT,
      idempotencyKey,
      triggeredBy: 'manual:fixture-script',
      gitSha: process.env.GIT_SHA ?? 'workspace',
    });

    const [latestQuote] = await db
      .select({ quoteDate: dbSchema.dailyQuote.quoteDate })
      .from(dbSchema.dailyQuote)
      .orderBy(dbSchema.dailyQuote.quoteDate)
      .limit(1);

    console.log('P0-3 fixture 数据链完成：');
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
          earliestQuoteDate: latestQuote?.quoteDate ?? null,
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
