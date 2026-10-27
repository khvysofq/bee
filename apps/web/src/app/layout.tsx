import type { Metadata } from 'next';
import {
  AI_LABEL_ID,
  BRIEF_DISCLAIMER_ID,
  CONTENT_POLICY_ID,
} from '@/lib/compliance';
import './globals.css';

export const metadata: Metadata = {
  title: 'bee · 再生物资行情',
  description: '再生材料的日频报价、趋势推演与行业问答。数字来自已校验的报价数据。',
  applicationName: 'bee',
  other: {
    'content-policy-id': CONTENT_POLICY_ID,
    'brief-disclaimer-id': BRIEF_DISCLAIMER_ID,
    'ai-label-id': AI_LABEL_ID,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}