import { redirect } from 'next/navigation';

/** 旧存档地址重定向到内部路径；不进入任何用户界面。 */
export default async function LegacyRawPage(props: { params: Promise<{ fetchId: string }> }) {
  const { fetchId } = await props.params;
  redirect(`/internal/raw/${encodeURIComponent(fetchId)}`);
}