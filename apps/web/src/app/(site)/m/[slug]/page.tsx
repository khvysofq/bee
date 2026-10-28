import { notFound } from 'next/navigation';
import { DetailView } from '@/components/DetailView';
import { SiteFooter, emptyFooterInfo, type FooterInfo } from '@/components/SiteFooter';
import { loadMarketDetail } from '@/lib/market-detail';

export const dynamic = 'force-dynamic';

function footerFromDetail(
  detail: Awaited<ReturnType<typeof loadMarketDetail>>,
): FooterInfo {
  if (!detail) {
    return {
      hasFixtureSource: false,
      hasStatsSource: false,
      statsSourceUrl: null,
      latestQuoteDate: null,
      updatedAt: null,
    };
  }
  const statsSource = detail.quote?.sources.find((source) => source.code === 'stats-cn');
  return {
    hasFixtureSource: false,
    hasStatsSource: Boolean(statsSource),
    statsSourceUrl: statsSource?.url ?? null,
    latestQuoteDate: detail.latestDate,
    updatedAt: detail.latestDate,
  };
}

/** 单品页：/m/p-<category>-<region>-<spec|all>-<priceType>。 */
export default async function MarketDetailPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  let detail: Awaited<ReturnType<typeof loadMarketDetail>> = null;
  try {
    detail = await loadMarketDetail(slug);
  } catch (error) {
    console.error('[detail] loadMarketDetail failed', { slug, error });
    return (
      <main className="terminal">
        <div className="shell">
          <div className="t-not-found">
            <h1>行情数据暂时无法读取</h1>
            <p>数据库不可达。页面不会用估算值替代真实报价；恢复后刷新即可。</p>
          </div>
        </div>
        <SiteFooter info={emptyFooterInfo()} />
      </main>
    );
  }
  if (!detail) notFound();
  return <DetailView detail={detail} footer={footerFromDetail(detail)} />;
}