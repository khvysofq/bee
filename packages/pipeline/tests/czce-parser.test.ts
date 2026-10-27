/**
 * 郑商所日行情文本解析（纯函数，无 DB）。
 *
 * 回归点：真实文件是 UTF-8 + 制表符填充 + 管道分隔，数字带千分位逗号；
 * 表头、空行、非合约行都必须被跳过，不能把「合约代码」当成一行数据。
 */
import { describe, expect, it } from 'vitest';
import { parseCzceDaily } from '../src/series-sources';

const SAMPLE = [
  '\t\t\t\t\t郑州商品交易所期货每日行情表(2026-10-23)',
  '合约代码|昨结算    |今开盘    |最高价    |最低价    |今收盘    |今结算    |涨跌1    |涨跌2    |成交量(手)|持仓量    |增减量    |成交额(万元)|交割结算价',
  'SM701 |5,880.00  |5,900.00  |5,940.00  |5,860.00  |5,910.00  |5,908.00  |28.00    |-2.00    |382,858  |382,858   |1,234     |1,130,000  |5,908.00',
  'SF701 |5,400.00  |5,380.00  |5,420.00  |5,360.00  |5,390.00  |5,392.00  |12.00    |-1.00    |120,000  |120,000   |-500      |330,000    |5,392.00',
  'AP611 |6,890.00  |6,850.00  |6,910.00  |6,840.00  |6,900.00  |6,898.00  |8.00     |2.00     |10,000   |10,000    |100       |68,000     |6,898.00',
].join('\n');

describe('parseCzceDaily', () => {
  it('跳过表头与标题，只取合约行', () => {
    const rows = parseCzceDaily(SAMPLE, '2026-10-23');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.contractCode)).toEqual(['SM701', 'SF701', 'AP611']);
  });

  it('千分位逗号被去掉，结算价作主值', () => {
    const [sm] = parseCzceDaily(SAMPLE, '2026-10-23');
    expect(sm!.instrumentCode).toBe('SM');
    expect(sm!.nameCn).toBe('锰硅');
    expect(sm!.value).toBe('5908');
    expect(sm!.settlePrice).toBe('5908');
    expect(sm!.openPrice).toBe('5900');
    expect(sm!.volume).toBe('382858');
    expect(sm!.openInterest).toBe('382858');
  });

  it('观测日取自调用方（文件本身不含日期列）', () => {
    const rows = parseCzceDaily(SAMPLE, '2026-10-20');
    expect(rows.every((r) => r.obsDate === '2026-10-20')).toBe(true);
  });

  it('空文本返回空数组', () => {
    expect(parseCzceDaily('', '2026-10-23')).toEqual([]);
  });
});