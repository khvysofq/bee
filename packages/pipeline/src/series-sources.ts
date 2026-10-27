import { eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';

/**
 * 交易所来源登记（上期所 / 上期能源 / 郑商所）。
 *
 * 合规依据（2026-10-27 实测）：
 *  - 三个站的 /robots.txt 均返回 404（无 robots 文件 → 未声明任何爬取限制）；
 *  - 日行情文件是交易所对公众发布的行情数据，非付费墙、非登录内容；
 *  - 使用约束：注明出处、不得用于误导性陈述。登记为 allowed，仅低频读取（每日 1–2 次）。
 */

export const SERIES_SOURCES = [
  {
    code: 'shfe',
    name: '上海期货交易所',
    baseUrl: 'https://www.shfe.com.cn',
    venue: 'SHFE',
    unitCode: 'CNY_per_ton',
    currency: 'CNY',
  },
  {
    code: 'ine',
    name: '上海国际能源交易中心',
    baseUrl: 'https://www.ine.cn',
    venue: 'INE',
    unitCode: 'CNY_per_ton',
    currency: 'CNY',
  },
  {
    code: 'czce',
    name: '郑州商品交易所',
    baseUrl: 'http://www.czce.com.cn',
    venue: 'CZCE',
    unitCode: 'CNY_per_ton',
    currency: 'CNY',
  },
] as const;

/** 品种 → 品类（只映射有明确归属的；其余挂空，不猜）。 */
export const CATEGORY_BY_INSTRUMENT: Record<string, string> = {
  // 上期所：钢材系 → 废钢，有色 → 废铜/废铝
  rb: 'scrap-steel',
  hc: 'scrap-steel',
  wr: 'scrap-steel',
  ss: 'scrap-steel',
  cu: 'scrap-copper',
  bc: 'scrap-copper',
  al: 'scrap-aluminum',
};

/** 上期所/上期能源 JSON 里出现的品种代码集合（用于展示层分组与校验）。 */
export const SHFE_PRODUCTS = [
  'cu',
  'al',
  'zn',
  'pb',
  'ni',
  'sn',
  'au',
  'ag',
  'rb',
  'wr',
  'hc',
  'ss',
  'bu',
  'fu',
  'ru',
  'sp',
  'br',
  'nr',
  'lu',
  'bc',
  'sc',
  'ao',
  'ad',
  'op',
  'ec',
] as const;

export async function seedSeriesSources(db: BeeDb): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const item of SERIES_SOURCES) {
    const [row] = await db
      .insert(dbSchema.source)
      .values({
        code: item.code,
        name: item.name,
        type: 'api',
        baseUrl: item.baseUrl,
        tosUrl: `${item.baseUrl}/`,
        robotsStatus: 'allowed',
        robotsCheckedAt: new Date('2026-10-27T00:00:00Z'),
        robotsNote:
          'https://' +
          new URL(item.baseUrl).host +
          '/robots.txt 返回 404（无 robots 文件，未声明限制）；日行情为交易所公开发布数据，无登录墙。',
        trustWeight: '95.0',
        trustNote: '交易所官方日行情（结算价/成交量/持仓量），全市场唯一权威来源。',
        crawlFrequencyPerDay: 2,
        rateLimitSeconds: 2,
        fetcherKind: 'json_api',
        status: 'active',
        statusReason: '零采购期唯一可用的天频官方源；使用须注明出处。',
      })
      .onConflictDoUpdate({
        target: dbSchema.source.code,
        set: {
          name: item.name,
          baseUrl: item.baseUrl,
          robotsStatus: 'allowed',
          status: 'active',
          fetcherKind: 'json_api',
          updatedAt: new Date(),
        },
      })
      .returning({ id: dbSchema.source.id });
    ids.set(item.code, row!.id);
  }
  return ids;
}

export async function unitIdByCode(db: BeeDb, code: string): Promise<string> {
  const [row] = await db.select({ id: dbSchema.unit.id }).from(dbSchema.unit).where(eq(dbSchema.unit.code, code));
  if (!row) throw new Error(`单位字典缺少 ${code}`);
  return row.id;
}