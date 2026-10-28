import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SiteFooter, emptyFooterInfo } from '@/components/SiteFooter';
import { db } from '@/db';
import { getContent, readMarkdown, stripFrontmatter } from '@/lib/content-data';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  news_digest: '日报',
  analysis: '行业分析',
  forecast: '预测研报',
  news_item: '新闻',
};

/** 正文开头若与页面标题重复（生成时写了同名 H1），去掉，避免标题出现两次。 */
function stripLeadingTitle(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  const index = lines.findIndex((line) => line.trim().startsWith('# '));
  if (index < 0 || index > 8) return markdown;
  const heading = lines[index]!.replace(/^#\s+/, '').trim();
  if (heading !== title && !heading.includes(title)) return markdown;
  lines.splice(index, 1);
  if (lines[index]?.trim() === '') lines.splice(index, 1);
  return lines.join('\n');
}

/** 内容阅读页：/content/<id>，正文从 Garage / S3 的 Markdown 对象读取。 */
export default async function ContentPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  let detail: Awaited<ReturnType<typeof getContent>> = null;
  try {
    detail = await getContent(db, id);
  } catch (error) {
    console.error('[content] getContent failed', { id, error });
    return (
      <main className="terminal">
        <div className="shell">
          <div className="t-not-found">
            <h1>内容暂时无法读取</h1>
            <p>数据库不可达。恢复后刷新即可。</p>
          </div>
        </div>
        <SiteFooter info={emptyFooterInfo()} />
      </main>
    );
  }

  if (!detail) notFound();

  const markdown = await readMarkdown(detail.bodyMdKey);
  const body = markdown ? stripLeadingTitle(stripFrontmatter(markdown), detail.title) : null;

  return (
    <>
      <main className="terminal">
        <div className="shell">
          <article className="content-page">
            <nav className="cd-crumbs" aria-label="面包屑">
              <Link href="/">行情</Link>
              <span aria-hidden="true">/</span>
              <Link href={`/c/${detail.categoryCode}`}>{detail.categoryName}</Link>
              <span aria-hidden="true">/</span>
              <span>{KIND_LABEL[detail.kind] ?? detail.kind}</span>
            </nav>

            <header className="content-head">
              <span className="content-kind">{KIND_LABEL[detail.kind] ?? detail.kind}</span>
              <h1>{detail.title}</h1>
              <p className="content-meta">
                {detail.categoryName}
                {detail.regionName ? ` · ${detail.regionName}` : ''}
                {' · '}
                {detail.contentDate}
                {detail.periodStart && detail.periodEnd
                  ? ` · 预测期间 ${detail.periodStart} ~ ${detail.periodEnd}`
                  : ''}
              </p>
              {detail.summary ? <p className="content-summary">{detail.summary}</p> : null}
            </header>

            {body ? (
              <div className="content-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
              </div>
            ) : (
              <p className="content-unavailable">正文暂不可用：对象存储中的 Markdown 读取失败。</p>
            )}

            <footer className="content-foot">
              <Link href={`/c/${detail.categoryCode}`}>← 返回 {detail.categoryName}</Link>
              <span>{detail.publishedAt ? `发布于 ${detail.publishedAt.slice(0, 10)}` : ''}</span>
            </footer>
          </article>
        </div>
      </main>
      <SiteFooter info={emptyFooterInfo()} />
    </>
  );
}