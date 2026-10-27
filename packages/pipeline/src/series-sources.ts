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
/** 郑商所品种中文名（只列常用；未列出的用代码本身，不猜中文）。 */
export const CZCE_PRODUCT_NAMES: Record<string, string> = {
  SM: '锰硅',
  SF: '硅铁',
  TA: 'PTA',
  MA: '甲醇',
  SR: '白糖',
  CF: '棉花',
  OI: '菜籽油',
  RM: '菜籽粕',
  FG: '玻璃',
  SA: '纯碱',
  UR: '尿素',
  PF: '短纤',
  PK: '花生',
  PX: '对二甲苯',
  SH: '烧碱',
  AP: '苹果',
  CJ: '红枣',
  CY: '棉纱',
  ZC: '动力煤',
};

/**
 * 郑商所日行情文本解析。
 *
 * 格式：UTF-8 文本（实测不是 GBK），制表符 + 管道分隔；
 * 列序：合约代码|昨结算|今开盘|最高价|最低价|今收盘|今结算|涨跌1|涨跌2|成交量(手)|持仓量|增减量|成交额(万元)|交割结算价
 * 合约码形如 AP611（字母 + 3 位年月），与上期所的 rb2701 不同，这里原样保留。
 */
export function parseCzceDaily(body: string, obsDate: string): import('./series').SeriesRowInput[] {
  const rows: import('./series').SeriesRowInput[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const code = cells[0] ?? '';
    if (!/^[A-Z]{1,2}\d{3,4}$/.test(code)) continue;
    const product = code.replace(/\d+$/, '');
    const num = (v: string | undefined): string | null => {
      if (!v) return null;
      const s = v.replace(/,/g, '').trim();
      if (!s || s === '-' || s === '—') return null;
      const n = Number(s);
      return Number.isFinite(n) ? String(n) : null;
    };
    const settle = num(cells[6]);
    const close = num(cells[5]);
    const value = settle ?? close;
    if (!value) continue;
    rows.push({
      instrumentCode: product,
      contractCode: code,
      nameCn: CZCE_PRODUCT_NAMES[product] ?? product,
      obsDate,
      value,
      openPrice: num(cells[2]),
      highPrice: num(cells[3]),
      lowPrice: num(cells[4]),
      closePrice: close,
      settlePrice: settle,
      volume: num(cells[9]),
      openInterest: num(cells[10]),
      turnover: num(cells[12]),
      detail: { prevSettle: num(cells[1]), deliverySettle: num(cells[13]) },
    });
  }
  return rows;
}
