import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFengjCopperTable, SchemaMismatchError } from '../src/adapters/fengj-copper';

const fixture = fileURLToPath(new URL('../fixtures/fengj-copper.html', import.meta.url));

describe('fengj 废铜表格适配器', () => {
  it('从 fixture 解析出 4 行且字段完整', async () => {
    const html = await readFile(fixture, 'utf8');
    const rows = parseFengjCopperTable(html);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      rawCategoryText: '废铜',
      rawSpecText: '光亮铜线',
      rawProvinceText: '广东',
      rawRegionText: '佛山',
      rawUnit: '元/吨',
      priceLow: 62000,
      priceHigh: 62000,
      quoteDate: '2026-10-26',
      changeText: '+200',
    });
    expect(rows.every((row) => row.rawPriceTypeText === '参考价')).toBe(true);
    expect(rows.map((row) => row.sourceRowIndex)).toEqual([0, 1, 2, 3]);
  });

  it('表头被破坏 → schema_mismatch', async () => {
    const html = await readFile(fixture, 'utf8');
    const broken = html.replace('<th>单位</th>', '<th>计量</th>');
    try {
      parseFengjCopperTable(broken);
      throw new Error('expected schema_mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaMismatchError);
      expect((error as SchemaMismatchError).code).toBe('schema_mismatch');
      expect(String(error)).toContain('表头缺列');
    }
  });

  it('没有表格 → schema_mismatch', () => {
    expect(() => parseFengjCopperTable('<html><body>暂无数据</body></html>')).toThrow(SchemaMismatchError);
  });
});