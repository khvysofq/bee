import { redirect } from 'next/navigation';

/** 旧行情入口合并到行情总览 `/`（头部导航只保留 行情 / 推演 / 问答）。 */
export default function LegacyMarketPage() {
  redirect('/');
}