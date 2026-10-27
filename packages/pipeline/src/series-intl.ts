import { eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import type { SeriesRowInput } from './series';

/**
 * 国际层（L1）：FRED 月频序列。
 *
 * 为什么是月频：FRED 的金属/矿价序列本身是月均（底层多为 IMF 大宗商品价格）。
 * 天频国际价（LME/CME）需授权且对非浏览器 403 —— 零采购期不做，位置留空。
 *
 * 合规：FRED 由圣路易斯联储提供，允许引用并署名；底层序列版权归原始机构（IMF/世界银行等）。
 * 展示层固定署名「来源：FRED（Federal Reserve Bank of St. Louis）」+ 原始序列 id。
 */

export interface FredSeriesDef {
  id: string;
  code: string;
  nameCn: string;
  instrumentCode: string;
  unitCode: string;
  categoryCode?: string;
  note: string;
}

export const FRED_SERIES: FredSeriesDef[] = [
  {
    id: 'PCOPPUSDM',
    code: 'fred.PCOPPUSDM',
    nameCn: '国际铜价（月均，美元/吨）',
    instrumentCode: 'PCOPPUSDM',
    unitCode: 'USD_per_ton',
    categoryCode: 'scrap-copper',
    note: 'IMF 大宗商品价格：铜，美元/公吨，月均。',
  },
  {
    id: 'PALUMUSDM',
    code: 'fred.PALUMUSDM',
    nameCn: '国际铝价（月均，美元/吨）',
    instrumentCode: 'PALUMUSDM',
    unitCode: 'USD_per_ton',
    categoryCode: 'scrap-aluminum',
    note: 'IMF 大宗商品价格：铝，美元/公吨，月均。',
  },
  {
    id: 'PNICKUSDM',
    code: 'fred.PNICKUSDM',
    nameCn: '国际镍价（月均，美元/吨）',
    instrumentCode: 'PNICKUSDM',
    unitCode: 'USD_per_ton',
    note: 'IMF 大宗商品价格：镍，美元/公吨，月均。',
  },
  {
    id: 'PIORECRUSDM',
    code: 'fred.PIORECRUSDM',
    nameCn: '铁矿石价格（月均，美元/干吨，cfr 中国）',
    instrumentCode: 'PIORECRUSDM',
    unitCode: 'USD_per_ton',
    categoryCode: 'scrap-steel',
    note: '铁矿石 62% Fe，cfr 中国，美元/干吨，月均。',
  },
  {
    id: 'PCOALAUUSDM',
    code: 'fred.PCOALAUUSDM',
    nameCn: '澳洲动力煤价（月均，美元/吨）',
    instrumentCode: 'PCOALAUUSDM',
    unitCode: 'USD_per_ton',
    note: '澳大利亚动力煤，FOB，美元/公吨，月均。',
  },
];

export const FRED_SOURCE_CODE = 'fred';

/** 解析 FRED CSV：首行表头，缺失值写作 "."。 */
export function parseFredCsv(body: string, seriesId: string): SeriesRowInput[] {
  const lines = body.trim().split(/\r?\n/);
  const rows: SeriesRowInput[] = [];
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',');
    if (!date || !raw) continue;
    const value = raw.trim();
    if (!value || value === '.') continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    rows.push({
      instrumentCode: seriesId,
      contractCode: seriesId,
      nameCn: seriesId,
      obsDate: normalizeMonth(date.trim()),
      value: String(n),
      detail: { fredSeries: seriesId },
    });
  }
  return rows;
}

/** 统一成当月 1 日（月频序列的 obs_date 约定）。 */
export function normalizeMonth(date: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date.slice(0, 7)}-01`;
  if (/^\d{4}-\d{2}$/.test(date)) return `${date}-01`;
  throw new Error(`无法识别的日期格式：${date}`);
}

/** 国际层需要的单位（幂等）。 */
export async function seedIntlUnits(db: BeeDb): Promise<void> {
  await db
    .insert(dbSchema.unit)
    .values([
      { code: 'USD_per_ton', nameCn: '美元/吨', isCanonical: 0 },
      { code: 'index_point', nameCn: '指数点', isCanonical: 0 },
    ])
    .onConflictDoNothing({ target: dbSchema.unit.code });
}

export async function seedFredSource(db: BeeDb): Promise<string> {
  const [row] = await db
    .insert(dbSchema.source)
    .values({
      code: FRED_SOURCE_CODE,
      name: 'FRED（Federal Reserve Bank of St. Louis）',
      type: 'api',
      baseUrl: 'https://fred.stlouisfed.org',
      tosUrl: 'https://fred.stlouisfed.org/legal/',
      robotsStatus: 'allowed',
      robotsCheckedAt: new Date('2026-10-27T00:00:00Z'),
      robotsNote: 'CSV 下载端点对公开请求返回 200，无登录墙；使用须署名并保留原始序列 id。',
      trustWeight: '90.0',
      trustNote: '央行研究机构发布的公开序列，底层为 IMF/世界银行等官方口径；月频，历史可回溯到 1960 年代。',
      crawlFrequencyPerDay: 1,
      rateLimitSeconds: 5,
      fetcherKind: 'json_api',
      status: 'active',
      statusReason: '国际层唯一零授权成本的月频官方源。',
    })
    .onConflictDoUpdate({
      target: dbSchema.source.code,
      set: { robotsStatus: 'allowed', status: 'active', updatedAt: new Date() },
    })
    .returning({ id: dbSchema.source.id });
  return row!.id;
}

export async function unitIdByCodeSafe(db: BeeDb, code: string): Promise<string | null> {
  const [row] = await db.select({ id: dbSchema.unit.id }).from(dbSchema.unit).where(eq(dbSchema.unit.code, code));
  return row?.id ?? null;
}