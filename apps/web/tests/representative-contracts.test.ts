/**
 * 总览「一个品种一个主力合约」的选择规则（不接数据库，纯函数）。
 *
 * 背景：交易所目录里铜有几十个交割月，逐月铺到总览等于把合约表当行情表。
 * 规则必须是可复核的：先按成交量挑主力，再按品类剔除成交明显偏薄的品种。
 */
import { describe, expect, it } from 'vitest';
import { selectRepresentativeContracts, type SeriesSqlRow } from '../src/lib/market-overview';
import type { MarketSparkPoint } from '../src/lib/market-types';

function series(partial: Partial<SeriesSqlRow> & { code: string }): {
  meta: SeriesSqlRow;
  points: MarketSparkPoint[];
} {
  const base: SeriesSqlRow = {
    id: partial.code,
    code: partial.code,
    name_cn: partial.name_cn ?? partial.code,
    layer: partial.layer ?? 'national',
    kind: partial.kind ?? 'futures',
    frequency: partial.frequency ?? 'daily',
    venue: partial.venue ?? 'SHFE',
    instrument_code: partial.instrument_code ?? 'cu',
    currency: partial.currency ?? 'CNY',
    summary: null,
    status: 'active',
    category_code: partial.category_code ?? 'scrap-copper',
    category_name: partial.category_name ?? '废铜',
    category_sort: 1,
    unit_name: partial.unit_name ?? '元/吨',
    point_count: 10,
    last_date: '2026-10-26',
    obs_date: '2026-10-26',
    value: '1000',
    volume: partial.volume ?? '100',
  };
  return { meta: { ...base, ...partial }, points: [{ date: '2026-10-26', value: 1000 }] };
}

describe('总览：主力合约选择', () => {
  it('同一品种只留成交量最大的交割月', () => {
    const rows = [
      series({ code: 'shfe.cu2610', volume: '12000' }),
      series({ code: 'shfe.cu2612', volume: '88000' }),
      series({ code: 'shfe.cu2701', volume: '30000' }),
    ];
    const kept = selectRepresentativeContracts(rows);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.meta.code).toBe('shfe.cu2612');
    expect(kept[0]!.meta.is_main).toBe(true);
  });

  it('成交量相同取先到期的合约', () => {
    const rows = [
      series({ code: 'shfe.cu2703', volume: '5000' }),
      series({ code: 'shfe.cu2611', volume: '5000' }),
    ];
    expect(selectRepresentativeContracts(rows)[0]!.meta.code).toBe('shfe.cu2611');
  });

  it('同一合约被两个场所重复登记时，认代码前缀对应的场所', () => {
    const rows = [
      series({ code: 'shfe.bc2610', venue: 'SHFE', instrument_code: 'bc', volume: '8456' }),
      series({ code: 'ine.bc2610', venue: 'INE', instrument_code: 'bc', volume: '8456' }),
    ];
    const kept = selectRepresentativeContracts(rows);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.meta.code).toBe('ine.bc2610');
  });

  it('成交明显偏薄的品种整只剔除（国际铜约为沪铜的十分之一）', () => {
    const rows = [
      series({ code: 'shfe.cu2612', instrument_code: 'cu', volume: '88952' }),
      series({ code: 'shfe.cu2701', instrument_code: 'cu', volume: '12000' }),
      series({ code: 'ine.bc2612', venue: 'INE', instrument_code: 'bc', volume: '8456' }),
    ];
    const kept = selectRepresentativeContracts(rows);
    expect(kept.map((row) => row.meta.code)).toEqual(['shfe.cu2612']);
  });

  it('成交活跃的多个品种各自保留一个主力（螺纹 / 热卷 / 不锈钢）', () => {
    const rows = [
      series({ code: 'shfe.rb2701', instrument_code: 'rb', category_code: 'scrap-steel', volume: '564567' }),
      series({ code: 'shfe.rb2705', instrument_code: 'rb', category_code: 'scrap-steel', volume: '90000' }),
      series({ code: 'shfe.hc2701', instrument_code: 'hc', category_code: 'scrap-steel', volume: '432253' }),
      series({ code: 'shfe.ss2612', instrument_code: 'ss', category_code: 'scrap-steel', volume: '137922' }),
    ];
    const kept = selectRepresentativeContracts(rows);
    expect(kept.map((row) => row.meta.code).sort()).toEqual(['shfe.hc2701', 'shfe.rb2701', 'shfe.ss2612']);
  });

  it('非期货序列（指数 / 宏观 / 库存）原样保留，不参与挑主力', () => {
    const rows = [
      series({
        code: 'fred.PCOPPUSDM',
        kind: 'index',
        layer: 'international',
        venue: 'FRED',
        category_code: 'scrap-copper',
        frequency: 'monthly',
        volume: null,
      }),
      series({ code: 'shfe.cu2612', volume: '88952' }),
    ];
    const kept = selectRepresentativeContracts(rows);
    expect(kept.map((row) => row.meta.code).sort()).toEqual(['fred.PCOPPUSDM', 'shfe.cu2612']);
  });
});