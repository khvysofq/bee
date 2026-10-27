import type { BriefingQuote } from './briefing-data';

/**
 * 代表报价挑选口径（确定性；仅用于「今日概览」与首页，不替代完整报价表）：
 *  1. 只取最新报价日的报价（更早的旬报锚点不当作「今日行情」）；
 *  2. 优先采购价（再生原料行情的通用口径）；
 *  3. 同池内优先有上一交易日可比值的（能真实呈现涨跌），否则取排序第一条。
 */
export function pickRepresentative(
  quotes: BriefingQuote[],
  latestQuoteDate: string | null,
): BriefingQuote | null {
  if (quotes.length === 0) return null;
  const latest = latestQuoteDate ? quotes.filter((quote) => quote.quoteDate === latestQuoteDate) : [];
  const pool = latest.length > 0 ? latest : quotes;
  const purchase = pool.filter((quote) => quote.priceType === 'purchase');
  const candidates = purchase.length > 0 ? purchase : pool;
  return candidates.find((quote) => quote.previousTradingDay !== null) ?? candidates[0] ?? null;
}