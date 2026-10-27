import { LandingView } from '@/components/LandingView';
import { loadLandingData, type LandingData } from '@/lib/landing-data';

export const dynamic = 'force-dynamic';

/** 首页（GUA-33）：三区首屏。数据读取失败时仍保留三大功能入口，数字不虚构。 */
function emptyLandingData(): LandingData {
  return {
    generatedAt: new Date().toISOString(),
    latestQuoteDate: null,
    dataCutoffAt: null,
    categories: [],
    hasFixtureSource: false,
    hasStatsSource: false,
    statsSourceUrl: null,
    stats: { categoryCount: 0, categoriesWithQuotes: 0, quoteCount: 0, sourceCount: 0 },
    empty: true,
  };
}

export default async function HomePage() {
  let data: LandingData | null = null;
  let unavailable = false;
  try {
    data = await loadLandingData();
  } catch {
    unavailable = true;
  }

  return <LandingView data={data ?? emptyLandingData()} dataUnavailable={unavailable} />;
}