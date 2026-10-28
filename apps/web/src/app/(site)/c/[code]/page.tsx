import { notFound } from 'next/navigation';
import { CategoryDetailView } from '@/components/CategoryDetailView';
import { SiteFooter, emptyFooterInfo, type FooterInfo } from '@/components/SiteFooter';
import { db } from '@/db';
import { loadCategoryDetail, type CategoryDetail } from '@/lib/category-detail';

export const dynamic = 'force-dynamic';

function footerFrom(detail: CategoryDetail): FooterInfo {
  return {
    hasFixtureSource: detail.hasDemo,
    hasStatsSource: false,
    statsSourceUrl: null,
    latestQuoteDate: detail.latestDate,
    updatedAt: detail.latestDate,
  };
}

/** 品类详情：/c/<categoryCode>。 */
export default async function CategoryPage(props: { params: Promise<{ code: string }> }) {
  const { code } = await props.params;
  let detail: CategoryDetail | null = null;
  try {
    detail = await loadCategoryDetail(db, code);
  } catch (error) {
    console.error('[category] loadCategoryDetail failed', { code, error });
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

  return (
    <>
      <main className="terminal">
        <div className="shell">
          <CategoryDetailView detail={detail} />
        </div>
      </main>
      <SiteFooter info={footerFrom(detail)} />
    </>
  );
}