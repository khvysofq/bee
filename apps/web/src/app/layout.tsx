import type { Metadata } from 'next';
import { SiteHeader } from '@/components/SiteHeader';
import './globals.css';

export const metadata: Metadata = {
  title: 'bee · 报废品行情信息平台',
  description: '每天可信的日频报价与行情简报 —— 数据底座',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {/* GUA-29：全站统一导航节奏（落地页 / 简报 / 巡检 / 状态） */}
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
