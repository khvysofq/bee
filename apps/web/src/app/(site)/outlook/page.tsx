import { OutlookView } from '@/components/OutlookView';
import { loadLandingData, type LandingData } from '@/lib/landing-data';

export const dynamic = 'force-dynamic';

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

export default async function OutlookPage() {
  let data: LandingData | null = null;
  try {
    data = await loadLandingData();
  } catch {
    data = null;
  }
  return <OutlookView data={data ?? emptyLandingData()} />;
}