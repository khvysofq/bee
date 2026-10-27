import { SiteHeader } from '@/components/SiteHeader';
import { Ticker, type TickerEntry } from '@/components/Ticker';
import { loadLandingData } from '@/lib/landing-data';
import { loadSearchIndex, type SearchItem } from '@/lib/market-overview';
import { arrowOf, directionOf, formatNumber, signedPct } from '@/lib/presentation';

/**
 * 用户侧页面外壳：品牌 + 三大功能导航 + 全局搜索 + 右侧问答抽屉。
 * 头部下方信号条复用已发布报价（服务端直出），不额外发前端请求。
 * 内部运维页走 /internal/*，不套用此壳。
 */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  let searchItems: SearchItem[] = [];
  try {
    searchItems = await loadSearchIndex();
  } catch {
    // 数据库不可达时搜索索引为空；页面本身仍按各自的错误态处理，不虚构条目。
    searchItems = [];
  }

  let tickerEntries: TickerEntry[] = [];
  let tickerDate: string | null = null;
  try {
    const landing = await loadLandingData();
    tickerDate = landing.latestQuoteDate;
    tickerEntries = landing.categories
      .filter((category) => category.representative !== null)
      .slice(0, 5)
      .map((category) => {
        const quote = category.representative!;
        const change = quote.dailyChange;
        const direction = change ? directionOf(change.pct) : 'flat';
        return {
          name: category.name,
          spec: quote.specName,
          value: formatNumber(quote.valueMid),
          unit: '元/吨',
          direction,
          change: change ? signedPct(change.pct) : '—',
          arrow: change ? arrowOf(direction) : '◆',
        };
      });
  } catch {
    // 报价不可达时信号条显示真实空态；不编造价格，也不影响页面本身。
    tickerEntries = [];
  }

  return (
    <>
      <SiteHeader searchItems={searchItems} />
      <Ticker entries={tickerEntries} quoteDate={tickerDate} />
      {children}
    </>
  );
}