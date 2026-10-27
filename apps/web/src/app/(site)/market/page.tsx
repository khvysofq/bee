import { MarketView } from '@/components/MarketView';
import { SiteFooter, emptyFooterInfo } from '@/components/SiteFooter';
import { loadBriefing, type BriefingData } from '@/lib/briefing-data';

export const dynamic = 'force-dynamic';

export default async function MarketPage() {
  let data: BriefingData | null = null;
  try {
    data = await loadBriefing();
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <main>
        <div className="shell">
          <div className="empty">
            <h1>行情数据暂时无法读取</h1>
            <p>请稍后刷新。页面不会用估算值替代真实报价，也不会隐藏数据缺口。</p>
            <p>
              <a className="text-link" href="/">
                返回首页
              </a>
            </p>
          </div>
        </div>
        <SiteFooter info={emptyFooterInfo()} />
      </main>
    );
  }

  return <MarketView data={data} />;
}