import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { createV4Db, resolveV4DatabaseUrl, v4, type BeeV4Db } from '@bee/db';
import { addDays, isDateString } from './v4/dates';
import { generateContent } from './v4/generate';
import { composeMarkdown, deterministicUuid, sha256Hex, truncateText } from './v4/markdown';
import { createMarkdownStorage, keyFor, type MarkdownStorage } from './v4/storage';

/**
 * 按历史行情批量生成内容（演示）：pnpm --filter @bee/jobs seed:content-history
 *
 * 默认 2026-09-29 ~ 2026-10-28，3 个 active 品类，每个品类每天：
 *   - 2 条 news_item（内部原料，供日报聚合）
 *   - 1 篇 news_digest（重大新闻 / 日报）
 *   - 1 篇 analysis（行业分析）
 *   - 每周一 1 篇 forecast（预测未来 7 天）
 *
 * 全部基于 price_daily 的真实统计 + 模板文案，不调用大模型，不编造公司/成交，
 * 不给点位建议。所有 id 与 S3 key 都是确定性的，重复执行只覆盖、不新增行。
 */

const DEFAULT_FROM = '2026-09-29';
const DEFAULT_TO = '2026-10-28';
const CATEGORY_CODES = ['1110105', '1110201', '1110202'] as const;

interface TitleNote {
  title: string;
  note: string;
}

interface CategoryProfile {
  code: string;
  name: string;
  unit: string;
  regions: string[];
  titles: TitleNote[];
}

const PROFILES: Record<string, CategoryProfile> = {
  '1110105': {
    code: '1110105',
    name: '废钢铁',
    unit: '元/吨',
    regions: ['华东', '华南', '华北', '华中', '西南', '东北'],
    titles: [
      {
        title: '华东钢厂到货量回落，重废采购价小幅上调',
        note: '样本钢厂到货量连续两日低于日耗，库存天数下滑，部分钢厂小幅上调采购价以补充库存，成交以按需为主。',
      },
      {
        title: '电弧炉开工率回升，废钢需求边际改善',
        note: '电炉钢利润有所修复，带动电弧炉开工率回升，废钢日耗随之增加，但成材端仍以按需采购为主。',
      },
      {
        title: '华南拆解料供应偏紧，轻薄料价格坚挺',
        note: '华南拆解开工偏低，轻薄料货源偏紧，打包场出货节奏放缓，价格获得阶段性支撑。',
      },
      {
        title: '北方工地开工放缓，钢筋切粒成交转淡',
        note: '北方气温下降，工地施工节奏放缓，钢筋切粒需求转弱，市场成交以零星补库为主。',
      },
      {
        title: '钢厂库存连续两日下降，废钢补库意愿增强',
        note: '样本钢厂库存连续下降，补库意愿有所增强，但采购价调整仍主要跟随到货量与成材利润。',
      },
      {
        title: '进口再生钢铁原料窗口收窄，国内废钢替代增强',
        note: '进口再生钢铁原料到岸成本上升，进口窗口收窄，国内废钢的替代需求相应增强，港口库存变化有限。',
      },
    ],
  },
  '1110201': {
    code: '1110201',
    name: '废铜',
    unit: '元/吨',
    regions: ['华东', '华南', '华北', '华中', '西南', '东北'],
    titles: [
      {
        title: 'LME 铜价震荡，废铜进口倒挂收窄',
        note: '外盘铜价维持震荡，废铜进口倒挂幅度收窄，进口贸易商观望情绪仍浓，到港货源以长单为主。',
      },
      {
        title: '华南拆解厂开工下滑，光亮铜货源偏紧',
        note: '华南拆解厂开工下滑，光亮铜流通货源偏紧，持货商挺价意愿增强，下游按需接货。',
      },
      {
        title: '精废价差扩大，再生铜杆厂采购转谨慎',
        note: '精废价差扩大后，再生铜杆厂采购转为谨慎，多维持低库存运行，成交以刚需小单为主。',
      },
      {
        title: '电网订单回暖，废铜制杆开工率提升',
        note: '电网相关订单回暖，废铜制杆企业开工率提升，原料采购节奏加快，但压价情绪仍在。',
      },
      {
        title: '港口废铜库存下降，持货商惜售',
        note: '港口废铜库存下降，持货商惜售情绪升温，市场可流通货源减少，买卖双方价格分歧加大。',
      },
      {
        title: '空调排产走弱，黄杂铜需求承压',
        note: '空调排产走弱，黄杂铜下游需求承压，拆解料出货速度放缓，价格跟随精铜走势窄幅调整。',
      },
    ],
  },
  '1110202': {
    code: '1110202',
    name: '废铝',
    unit: '元/吨',
    regions: ['华东', '华南', '华北', '华中', '西南', '东北'],
    titles: [
      {
        title: '铝价高位震荡，再生铝厂刚需采购',
        note: '铝价高位震荡，再生铝厂以刚需采购为主，原料库存维持低位，成交价格随盘面小幅调整。',
      },
      {
        title: '易拉罐料价格持稳，打包厂出货意愿增强',
        note: '易拉罐料价格持稳，打包厂出货意愿增强，市场流通量有所增加，下游按需补库。',
      },
      {
        title: '汽车压铸订单回升，生铝需求改善',
        note: '汽车压铸订单回升，生铝需求边际改善，再生铝厂开工率小幅提升，采购仍以压价为主。',
      },
      {
        title: '进口废铝碎料减少，港口库存下降',
        note: '进口废铝碎料到港量减少，港口库存下降，国内货源补充有限，持货商报价相对坚挺。',
      },
      {
        title: '建筑型材开工偏弱，熟铝成交一般',
        note: '建筑型材开工偏弱，熟铝需求表现一般，市场成交以老客户长单为主，散单议价空间有限。',
      },
      {
        title: '再生铝锭厂利润收窄，采购压价',
        note: '再生铝锭厂利润收窄，对原料采购压价意愿增强，废铝持货商出货节奏放缓，成交偏淡。',
      },
    ],
  },
};

const CATEGORY_ORDER = CATEGORY_CODES.map((code) => PROFILES[code]!);

const DEMO_NEWS_SOURCE = {
  code: 'demo-news',
  name: '离线新闻样例',
  type: 'news',
  baseUrl: 'fixture://news-copper-sample.html',
  robotsStatus: 'allowed',
  redistribution: 'licensed',
} as const;

interface CliArgs {
  from: string;
  to: string;
}

function parseArgs(argv: string[]): CliArgs {
  let from = DEFAULT_FROM;
  let to = DEFAULT_TO;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from' || arg === '--to') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} 缺少日期值（YYYY-MM-DD）`);
      if (!isDateString(value)) throw new Error(`${arg} 不是 YYYY-MM-DD：${value}`);
      if (arg === '--from') from = value;
      else to = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith('--')) throw new Error(`未知参数：${arg}`);
  }
  if (from > to) throw new Error(`--from 不能晚于 --to：${from} > ${to}`);
  return { from, to };
}

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) dates.push(cursor);
  return dates;
}

function isMonday(date: string): boolean {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
}

function money(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface DailyPrice {
  date: string;
  average: number;
  previousDate: string | null;
  previousAverage: number | null;
}

/** 取某品类每日「全国」均价（region.code=CN），并以相邻报价日计算涨跌。 */
async function loadDailyPrices(
  db: BeeV4Db,
  categoryId: string,
  from: string,
  to: string,
): Promise<Map<string, DailyPrice>> {
  const rows = await db
    .select({
      date: sql<string>`${v4.priceDaily.priceDate}::text`,
      value: v4.priceDaily.valueMid,
      regionCode: v4.region.code,
    })
    .from(v4.priceDaily)
    .innerJoin(v4.region, eq(v4.priceDaily.regionId, v4.region.id))
    .where(
      and(
        eq(v4.priceDaily.categoryId, categoryId),
        gte(v4.priceDaily.priceDate, from),
        lte(v4.priceDaily.priceDate, to),
        eq(v4.priceDaily.status, 'published'),
      ),
    );

  const national = rows.filter((row) => row.regionCode === 'CN');
  const usable = national.length > 0 ? national : rows;

  const byDate = new Map<string, number[]>();
  for (const row of usable) {
    const value = Number(row.value);
    if (!Number.isFinite(value)) continue;
    const list = byDate.get(row.date);
    if (list) list.push(value);
    else byDate.set(row.date, [value]);
  }

  const dates = [...byDate.keys()].sort();
  const result = new Map<string, DailyPrice>();
  dates.forEach((date, index) => {
    const values = byDate.get(date)!;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const previousDate = index > 0 ? dates[index - 1]! : null;
    const previousValues = previousDate ? byDate.get(previousDate)! : null;
    const previousAverage = previousValues
      ? previousValues.reduce((sum, value) => sum + value, 0) / previousValues.length
      : null;
    result.set(date, { date, average, previousDate, previousAverage });
  });
  return result;
}

function buildNewsBody(
  profile: CategoryProfile,
  date: string,
  region: string,
  price: DailyPrice | undefined,
  note: string,
): string {
  const first =
    price === undefined
      ? `${date}，${region}地区${profile.name}暂无可用报价样本，当日价格与涨跌无法计算，市场以观望为主。`
      : (() => {
          const previous = price.previousAverage;
          const changePct =
            previous === null || previous === 0
              ? null
              : ((price.average - previous) / previous) * 100;
          const changeText =
            changePct === null
              ? '当日缺少前一报价日对照，暂不计算涨跌'
              : `较前一报价日（${price.previousDate}）${
                  changePct > 0 ? '上涨' : changePct < 0 ? '下跌' : '持平'
                } ${Math.abs(changePct).toFixed(2)}%`;
          return `${date}，${region}地区${profile.name}现货参考价报 ${money(price.average)} ${profile.unit}，${changeText}。该价格由当日全国主要集散地报价中值取平均得到，覆盖主要规格与交易环节，仅反映当日横截面水平。`;
        })();

  const second = `${note}当前供需、库存与开工变化仍以区域到货和订单节奏为主，价格随成交松紧窄幅波动。以上为演示内容，不构成交易建议。`;
  return `${first}\n\n${second}`;
}

function buildSeedJob(
  profile: CategoryProfile,
  categoryId: string,
  kind: 'digest' | 'analysis' | 'forecast',
  date: string,
): typeof v4.job.$inferSelect {
  const now = new Date(`${date}T10:00:00Z`);
  const config =
    kind === 'digest'
      ? { content_date: date }
      : kind === 'analysis'
        ? { content_date: date, lookback_days: 30 }
        : { content_date: date, horizon_days: 7 };

  return {
    id: deterministicUuid(`seed-job|${kind}|${profile.code}`),
    code: `history.${kind}.${profile.code}`,
    categoryId,
    sourceId: null,
    kind,
    schedule: {},
    config,
    enabled: true,
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function insertNewsItem(
  db: BeeV4Db,
  storage: MarkdownStorage,
  profile: CategoryProfile,
  categoryId: string,
  sourceId: string,
  date: string,
  slot: number,
  title: string,
  body: string,
): Promise<void> {
  const id = deterministicUuid(`news_item|${profile.code}|${date}|${slot}`);
  const runId = deterministicUuid(`seed-run|news_item|${profile.code}|${date}`);
  const publishedAt = new Date(`${date}T08:00:00Z`);
  const url = `fixture://content-history/${profile.code}/${date}/${slot}`;
  const key = keyFor('news_item', profile.code, date, id);
  const markdown = composeMarkdown(
    {
      id,
      kind: 'news_item',
      category: profile.name,
      categoryCode: profile.code,
      region: '全国',
      date,
      sources: [DEMO_NEWS_SOURCE.code],
      license: 'licensed',
      generatedAt: publishedAt.toISOString(),
    },
    body,
  );
  const uploaded = await storage.putMarkdown(key, markdown);

  const values = {
    id,
    categoryId,
    regionId: null,
    kind: 'news_item',
    title,
    summary: truncateText(body, 120),
    bodyMdKey: uploaded.key,
    bodySha256: uploaded.sha256,
    assets: [],
    meta: { demo: true, generator: 'template-v1' },
    contentDate: date,
    periodStart: null,
    periodEnd: null,
    sourceId,
    url,
    urlHash: sha256Hex(url),
    license: 'licensed',
    visibility: 'internal',
    status: 'published',
    publishedAt,
    runId,
    updatedAt: publishedAt,
  };

  await db
    .insert(v4.content)
    .values(values)
    .onConflictDoUpdate({ target: v4.content.id, set: values });
}

interface Bucket {
  news_item: number;
  news_digest: number;
  analysis: number;
  forecast: number;
}

function emptyBucket(): Bucket {
  return { news_item: 0, news_digest: 0, analysis: 0, forecast: 0 };
}

async function main(): Promise<void> {
  const { from, to } = parseArgs(process.argv.slice(2));
  const dates = datesBetween(from, to);
  const priceFrom = addDays(from, -10);

  const db = createV4Db(resolveV4DatabaseUrl());
  const storage = createMarkdownStorage();

  const stats = new Map<string, Bucket>();
  let uploads = 0;
  let generated = 0;

  try {
    await db
      .insert(v4.source)
      .values({
        code: DEMO_NEWS_SOURCE.code,
        name: DEMO_NEWS_SOURCE.name,
        type: DEMO_NEWS_SOURCE.type,
        baseUrl: DEMO_NEWS_SOURCE.baseUrl,
        robotsStatus: DEMO_NEWS_SOURCE.robotsStatus,
        redistribution: DEMO_NEWS_SOURCE.redistribution,
        enabled: true,
      })
      .onConflictDoNothing({ target: v4.source.code });

    const [source] = await db
      .select({ id: v4.source.id })
      .from(v4.source)
      .where(eq(v4.source.code, DEMO_NEWS_SOURCE.code))
      .limit(1);
    if (!source) throw new Error(`来源不存在：${DEMO_NEWS_SOURCE.code}`);

    const categoryRows = await db
      .select({ id: v4.category.id, code: v4.category.code })
      .from(v4.category)
      .where(
        and(
          eq(v4.category.status, 'active'),
          inArray(
            v4.category.code,
            CATEGORY_CODES.map((code) => code),
          ),
        ),
      );
    const categoryIdByCode = new Map(categoryRows.map((row) => [row.code, row.id]));
    for (const profile of CATEGORY_ORDER) {
      if (!categoryIdByCode.has(profile.code)) {
        throw new Error(`缺少 active 品类：${profile.code}`);
      }
      stats.set(profile.code, emptyBucket());
    }

    const priceByCategory = new Map<string, Map<string, DailyPrice>>();
    for (const profile of CATEGORY_ORDER) {
      const categoryId = categoryIdByCode.get(profile.code)!;
      priceByCategory.set(profile.code, await loadDailyPrices(db, categoryId, priceFrom, to));
    }

    // 1) 先写新闻原料，日报聚合才有内容可读。
    for (const [dayIndex, date] of dates.entries()) {
      for (const profile of CATEGORY_ORDER) {
        const categoryId = categoryIdByCode.get(profile.code)!;
        const bucket = stats.get(profile.code)!;
        const price = priceByCategory.get(profile.code)?.get(date);

        for (let slot = 0; slot < 2; slot += 1) {
          const titleIndex = (dayIndex * 2 + slot) % profile.titles.length;
          const { title, note } = profile.titles[titleIndex]!;
          const region = profile.regions[(dayIndex + slot) % profile.regions.length]!;
          const body = buildNewsBody(profile, date, region, price, note);
          await insertNewsItem(
            db,
            storage,
            profile,
            categoryId,
            source.id,
            date,
            slot,
            title,
            body,
          );
          uploads += 1;
          bucket.news_item += 1;
        }
      }
    }

    // 2) 再按天生成日报 / 分析 / 周一预测。
    for (const date of dates) {
      for (const profile of CATEGORY_ORDER) {
        const categoryId = categoryIdByCode.get(profile.code)!;
        const bucket = stats.get(profile.code)!;
        const now = new Date(`${date}T10:00:00Z`);
        const run = (kind: 'digest' | 'analysis' | 'forecast') =>
          generateContent(
            db,
            buildSeedJob(profile, categoryId, kind, date),
            deterministicUuid(`seed-run|${kind}|${profile.code}|${date}`),
            { now, storage },
          );

        await run('digest');
        bucket.news_digest += 1;
        uploads += 1;
        generated += 1;

        await run('analysis');
        bucket.analysis += 1;
        uploads += 1;
        generated += 1;

        if (isMonday(date)) {
          await run('forecast');
          bucket.forecast += 1;
          uploads += 1;
          generated += 1;
        }
      }
    }

    const totals = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(v4.content);
    const totalRows = totals[0]?.total ?? 0;

    console.log(`日期范围：${from} ~ ${to}（${dates.length} 天，${CATEGORY_ORDER.length} 个品类）`);
    console.log('每品类内容数量：');
    for (const profile of CATEGORY_ORDER) {
      const bucket = stats.get(profile.code)!;
      console.log(
        `  - ${profile.code} ${profile.name}：news_item ${bucket.news_item} / news_digest ${bucket.news_digest} / analysis ${bucket.analysis} / forecast ${bucket.forecast}`,
      );
    }
    console.log(`S3 上传：${uploads} 个对象（news_item ${uploads - generated} 条 + 报告 ${generated} 篇）`);
    console.log(`content 总行数：${totalRows}`);
  } finally {
    storage.close();
    await db.$client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});