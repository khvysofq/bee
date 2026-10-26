import { describe, expect, it } from 'vitest';
import { CANONICAL_UNIT_CODE, conversionRecord, toCanonicalPerTon } from '../src/units';

describe('计价单位换算', () => {
  it('规范单位恒为 元/吨', () => {
    expect(CANONICAL_UNIT_CODE).toBe('CNY_per_ton');
    expect(toCanonicalPerTon(2350, 'CNY_per_ton')).toBe(2350);
  });

  it('常见来源单位换算到 元/吨', () => {
    // 元/公斤：1 元/公斤 = 1000 元/吨
    expect(toCanonicalPerTon(2.35, 'CNY_per_kg')).toBe(2350);
    // 元/斤：1 元/斤 = 2000 元/吨
    expect(toCanonicalPerTon(1.175, 'CNY_per_jin')).toBe(2350);
    // 万元/吨
    expect(toCanonicalPerTon(0.235, 'CNY_wan_per_ton')).toBe(2350);
  });

  it('未知单位禁止猜测，返回 null（调用方必须进异常队列）', () => {
    expect(toCanonicalPerTon(100, '元/立方')).toBeNull();
    expect(() => conversionRecord('元/立方')).toThrow(/未知计价单位/);
  });

  it('换算记录可冻结回观测行', () => {
    expect(conversionRecord('CNY_per_jin')).toEqual({ from: 'CNY_per_jin', factor: 2000 });
  });
});
