import { redirect } from 'next/navigation';

/**
 * 旧「趋势推演」入口保留：307 重定向到「商机」频道。
 * 由 Next 的 redirect() 返回，旧链接不会 404。
 */
export default function OutlookPage() {
  redirect('/opportunities');
}