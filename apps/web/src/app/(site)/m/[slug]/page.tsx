import { notFound } from 'next/navigation';
import { DetailView } from '@/components/DetailView';
import type { FooterInfo } from '@/components/SiteFooter';
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

/** 单品页：/m/s-<series.code> 或 /m/q-<daily_quote.id>。 */
export default async function MarketDetailPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const detail = await loadMarketDetail(slug);
  if (!detail) notFound();
  return <DetailView detail={detail} footer={footerFromDetail(detail)} />;
}