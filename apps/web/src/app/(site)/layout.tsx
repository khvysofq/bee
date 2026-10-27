import { SiteHeader } from '@/components/SiteHeader';
import { loadSearchIndex, type SearchItem } from '@/lib/market-overview';

/**
 * 用户侧页面外壳：品牌 + 三大功能导航 + 全局搜索 + 右侧问答抽屉。
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

  return (
    <>
      <SiteHeader searchItems={searchItems} />
      {children}
    </>
  );
}