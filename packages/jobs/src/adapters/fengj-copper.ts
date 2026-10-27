import { parsePriceText } from '@bee/pipeline';

/**
 * fengj 废铜表格适配器（P0 示范）。
 *
 * 只认表格里出现的列与数字：品名 / 规格 / 省份 / 城市 / 价格 / 单位 / 涨跌 / 时间。
 * 不推断、不补点、不做单位猜测；页面结构不匹配时抛 schema_mismatch，让 job_run 明确失败。
 */

export const FENGJ_COPPER_ADAPTER = 'fengj-copper-v1';

const REQUIRED_COLUMNS = ['品名', '规格', '省份', '城市', '价格', '单位', '涨跌', '时间'] as const;
type ColumnName = (typeof REQUIRED_COLUMNS)[number];

export class SchemaMismatchError extends Error {
  readonly code = 'schema_mismatch';
  constructor(message: string) {
    super(message);
    this.name = 'SchemaMismatchError';
  }
}

export interface FengjCopperRow {
  sourceRowIndex: number;
  rawText: string;
  rawCategoryText: string;
  rawSpecText: string | null;
  rawProvinceText: string | null;
  rawRegionText: string;
  rawPriceTypeText: string;
  rawUnit: string;
  priceLow: number;
  priceHigh: number;
  changeText: string | null;
  quoteDate: string;
  observedAt: null;
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function textOf(html: string): string {
    return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(text: string): string | null {
  const full = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (full) {
    const value = `${full[1]}-${full[2]}-${full[3]}`;
    return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? null : value;
  }
  return null;
}

function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      cells.push(textOf(cellMatch[1] ?? ''));
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function headerIndex(header: string[]): Record<ColumnName, number> | null {
  const index = {} as Record<ColumnName, number>;
  for (const name of REQUIRED_COLUMNS) {
    const at = header.indexOf(name);
    if (at < 0) return null;
    index[name] = at;
  }
  return index;
}

export function parseFengjCopperTable(html: string): FengjCopperRow[] {
  const rows = tableRows(html);
  if (rows.length === 0) {
    throw new SchemaMismatchError('schema_mismatch: 页面里没有找到表格');
  }
  const headerAt = rows.findIndex((row) => row.includes('品名') && row.includes('价格'));
  if (headerAt < 0) {
    throw new SchemaMismatchError('schema_mismatch: 未找到「品名 / 价格」表头');
  }
  const index = headerIndex(rows[headerAt]!);
  if (!index) {
    throw new SchemaMismatchError(
      `schema_mismatch: 表头缺列，需要 ${REQUIRED_COLUMNS.join(' / ')}，实际 ${rows[headerAt]!.join(' / ')}`,
    );
  }

  const result: FengjCopperRow[] = [];
  for (const cells of rows.slice(headerAt + 1)) {
    if (cells.every((cell) => cell.length === 0)) continue;
    if (cells.length < REQUIRED_COLUMNS.length) {
      throw new SchemaMismatchError(
        `schema_mismatch: 数据行列数 ${cells.length} < ${REQUIRED_COLUMNS.length}（${cells.join(' | ')}）`,
      );
    }
    const get = (name: ColumnName): string => cells[index[name]] ?? '';
    const category = get('品名');
    const spec = get('规格');
    const province = get('省份');
    const city = get('城市');
    const priceText = get('价格');
    const unit = get('单位');
    const changeText = get('涨跌');
    const dateText = get('时间');
    if (!category || !city || !priceText || !unit) {
      throw new SchemaMismatchError(`schema_mismatch: 必填单元格为空（${cells.join(' | ')}）`);
    }
    const quoteDate = parseDate(dateText);
    if (!quoteDate) {
      throw new SchemaMismatchError(`schema_mismatch: 时间列不是合法日期（${dateText}）`);
    }
    let price: { low: number; high: number };
    try {
      price = parsePriceText(priceText);
    } catch (error) {
      throw new SchemaMismatchError(`schema_mismatch: 价格不可确定性解析（${priceText}）: ${String(error)}`);
    }
    result.push({
      sourceRowIndex: result.length,
      rawText: cells.join(' | '),
      rawCategoryText: category,
      rawSpecText: spec || null,
      rawProvinceText: province || null,
      rawRegionText: city,
      // 表格没有价类型列：统一按「参考价」声明，这是来源列表口径，不是从数字推断。
      rawPriceTypeText: '参考价',
      rawUnit: unit,
      priceLow: price.low,
      priceHigh: price.high,
      changeText: changeText || null,
      quoteDate,
      observedAt: null,
    });
  }
  if (result.length === 0) {
    throw new SchemaMismatchError('schema_mismatch: 表格有表头但没有数据行');
  }
  return result;
}

export const fengjCopperAdapter = {
  key: FENGJ_COPPER_ADAPTER,
  parse: parseFengjCopperTable,
};