import { QaView } from '@/components/QaView';
import { emptyFooterInfo, footerInfoFromLanding } from '@/components/SiteFooter';
import { loadLandingData } from '@/lib/landing-data';

export const dynamic = 'force-dynamic';

/** 行业问答（筹备中）：正文不依赖数据库；页脚数据说明按当前数据来源状态呈现。 */
export default async function QaPage() {
  const info = await loadLandingData()
    .then(footerInfoFromLanding)
    .catch(() => emptyFooterInfo());
  return <QaView info={info} />;
}