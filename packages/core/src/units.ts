/**
 * 计价单位（口径字典 · 计价口径的代码侧契约）。
 *
 * 规范单位恒为 元/吨（CNY_per_ton）。来源原文单位通过 UNIT_CONVERSIONS 换算；
 * 换算动作本身会冻结在 price_observation.conversion_applied —— 换算依据可回放。
 */
export const CANONICAL_UNIT_CODE = 'CNY_per_ton';

export type UnitCode =
  | 'CNY_per_ton'
  | 'CNY_per_kg'
  | 'CNY_per_jin'
  | 'CNY_wan_per_ton';

/** from → 元/吨 的换算因子（乘法）。 */
export const TO_CANONICAL_FACTOR: Record<UnitCode, number> = {
  CNY_per_ton: 1,
  CNY_per_kg: 1000,
  CNY_per_jin: 2000,
  CNY_wan_per_ton: 10000,
};

/** 把原文单位价格换算成 元/吨。未知单位返回 null（调用方必须把观测留在 pending/异常队列，不许猜）。 */
export function toCanonicalPerTon(value: number, fromUnit: string): number | null {
  const factor = TO_CANONICAL_FACTOR[fromUnit as UnitCode];
  if (factor === undefined) return null;
  return Math.round(value * factor * 100) / 100;
}

/** 生成冻结在观测行上的换算记录。 */
export function conversionRecord(fromUnit: string): { from: string; factor: number } {
  const factor = TO_CANONICAL_FACTOR[fromUnit as UnitCode] ?? null;
  if (factor === null) {
    throw new Error(`未知计价单位：${fromUnit}（禁止猜测换算，进异常队列）`);
  }
  return { from: fromUnit, factor };
}
