import { runPriceJob } from './v4/runner';

/**
 * 手工执行 v4 价格采集任务（不依赖 pg-boss / scheduler）。
 *
 *   pnpm --filter @bee/jobs run:price demo.scrap-copper.fixture
 *   pnpm --filter @bee/jobs run:price demo.scrap-copper.fixture --now 2026-10-26T08:00:00Z
 */

interface CliArgs {
  jobCode: string;
  now?: Date;
}

function parseArgs(argv: string[]): CliArgs {
  let jobCode: string | undefined;
  let now: Date | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--now') {
      const value = argv[i + 1];
      if (!value) throw new Error('--now 缺少时间值（ISO 8601）');
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) throw new Error(`--now 不是合法时间：${value}`);
      now = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    if (jobCode) throw new Error(`多余的位置参数：${arg}`);
    jobCode = arg;
  }
  if (!jobCode) {
    throw new Error('用法：pnpm --filter @bee/jobs run:price <job-code> [--now <ISO8601>]');
  }
  return { jobCode, now };
}

const STATUS_ZH: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
};

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`参数错误：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  try {
    const result = await runPriceJob({ jobCode: args.jobCode, now: args.now });
    const reasons = Object.entries(result.stats.reasons);
    console.log(`任务：${result.jobCode}`);
    console.log(`状态：${result.status}（${STATUS_ZH[result.status] ?? result.status}）`);
    console.log(`抓取/解析：fetched=${result.stats.fetched} parsed=${result.stats.parsed}`);
    console.log(`写入：upserted=${result.stats.upserted} skipped=${result.stats.skipped}`);
    console.log(
      `原因：${reasons.length === 0 ? '无' : reasons.map(([key, count]) => `${key}=${count}`).join(', ')}`,
    );
    if (result.error) console.log(`错误：${result.error}`);
    console.log(`运行记录：${result.jobRunId}`);
    process.exit(result.status === 'succeeded' ? 0 : 1);
  } catch (error) {
    console.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();