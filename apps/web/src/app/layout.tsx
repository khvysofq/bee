import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'bee · 报废品行情信息平台',
  description: '每天可信的日频报价与行情简报 —— 数据底座',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
