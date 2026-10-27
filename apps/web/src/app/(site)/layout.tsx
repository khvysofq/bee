import { SiteHeader } from '@/components/SiteHeader';

/** 用户侧页面外壳：品牌 + 三大功能导航。内部运维页走 /internal/*，不套用此壳。 */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
    </>
  );
}