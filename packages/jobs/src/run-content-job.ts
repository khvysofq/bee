import { runContentJob } from './v4/content-runner';

/**
 * 手工执行 v4 内容任务（不依赖 pg-boss / scheduler）。
 *
 *   pnpm --filter @bee/jobs run:content demo.news.copper
 *   pnpm --filter @bee/jobs run:content demo.digest.copper
 *   pnpm --filter @bee/jobs run:content demo.analysis.copper
 *   pnpm --filter @bee/jobs run:content demo.forecast.copper
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
    throw new Error('用法：pnpm --filter @bee/jobs run:content <job-code> [--now <ISO8601>]');
  }
  return { jobCode, now };
}

const STATUS_ZH: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
};

const KIND_ZH: Record<string, string> = {
  fetch_news: '新闻抓取与入库',
  digest: '日报生成',
  analysis: '行业分析生成',
  forecast: '价格预测生成',
};

const STAT_LABELS: Record<string, string> = {
  fetched: '抓取',
  extracted: '提取',
  uploaded: '上传 S3',
  inserted: '新增行',
  duplicate: '重复跳过',
  skipped: '跳过',
  news_items: '新闻条目',
  price_rows: '价格行',
  groups: '地域/规格组',
  samples: '报价日样本',
  upserted: 'upsert',
};

const STAT_ORDERS: Record<string, string[]> = {
  fetch_news: ['fetched', 'extracted', 'uploaded', 'inserted', 'duplicate', 'skipped'],
  digest: ['news_items', 'price_rows', 'samples', 'uploaded', 'upserted'],
  analysis: ['price_rows', 'groups', 'samples', 'uploaded', 'upserted'],
  forecast: ['price_rows', 'groups', 'samples', 'uploaded', 'upserted'],
};

function formatStats(jobKind: string, stats: Record<string, unknown>): string {
  const order = STAT_ORDERS[jobKind];
  const parts: string[] = [];
  const keys = order ?? Object.keys(stats).filter((key) => key !== 'reasons');
  for (const key of keys) {
    const value = stats[key];
    if (typeof value !== 'number') continue;
    parts.push(`${STAT_LABELS[key] ?? key}=${value}`);
  }
  return parts.length === 0 ? '无' : parts.join(' ');
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`参数错误：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  try {
    const result = await runContentJob({ jobCode: args.jobCode, now: args.now });
    const reasons = Object.entries(result.stats.reasons);
    console.log(`任务：${result.jobCode}`);
    console.log(`类型：${result.jobKind}（${KIND_ZH[result.jobKind] ?? result.jobKind}）`);
    console.log(`状态：${result.status}（${STATUS_ZH[result.status] ?? result.status}）`);
    if (result.title) console.log(`标题：${result.title}`);
    if (result.contentId) console.log(`内容 id：${result.contentId}`);
    if (result.s3Key) console.log(`S3 对象：${result.s3Key}`);
    console.log(`统计：${formatStats(result.jobKind, result.stats as unknown as Record<string, unknown>)}`);
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