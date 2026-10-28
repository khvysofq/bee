import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteFooter, emptyFooterInfo } from '@/components/SiteFooter';
import { db } from '@/db';
import {
  countCategoryContents,
  getCategoryByCode,
  listCategoryContents,
  type ContentSummary,
} from '@/lib/content-data';

export const dynamic = 'force-dynamic';

const TABS = [
  { kind: 'news_digest', label: '重大新闻' },
  { kind: 'analysis', label: '行业分析' },
  { kind: 'forecast', label: '预测研报' },
] as const;

type ArchiveKind = (typeof TABS)[number]['kind'];

function parseKind(value: string | string[] | undefined): ArchiveKind {
  const raw = Array.isArray(value) ? value[0] : value;
  return TABS.some((tab) => tab.kind === raw) ? (raw as ArchiveKind) : 'news_digest';
}

function ArchiveList(props: { items: ContentSummary[] }) {
  if (props.items.length === 0) {
    return <p className="archive-empty">暂无记录。</p>;
  }
  return (
    <ol className="archive-list">
      {props.items.map((item) => (
        <li className="archive-item" key={item.id}>
          <Link className="archive-item-link" href={`/content/${item.id}`}>
            <span className="archive-date">{item.contentDate}</span>
            <h2 className="archive-title">{item.title}</h2>
            {item.summary ? <p className="archive-summary">{item.summary}</p> : null}
            <span className="archive-read">阅读 →</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

/** 品类历史内容归档：/c/<categoryCode>/archive?kind=news_digest|analysis|forecast。 */
export default async function ArchivePage(props: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { code } = await props.params;
  const search = await props.searchParams;
  const kind = parseKind(search.kind);

  let category: Awaited<ReturnType<typeof getCategoryByCode>> = null;
  try {
    category = await getCategoryByCode(db, code);
  } catch (error) {
    console.error('[archive] getCategoryByCode failed', { code, error });
    return (
      <main className="terminal">
        <div className="shell">
          <div className="t-not-found">
            <h1>行情数据暂时无法读取</h1>
            <p>数据库不可达。恢复后刷新即可。</p>
          </div>
        </div>
        <SiteFooter info={emptyFooterInfo()} />
      </main>
    );
  }

  if (!category) notFound();

  let items: ContentSummary[] = [];
  let counts: Record<ArchiveKind, number> = { news_digest: 0, analysis: 0, forecast: 0 };
  try {
    const [list, digestCount, analysisCount, forecastCount] = await Promise.all([
      listCategoryContents(db, category.id, kind, 200),
      countCategoryContents(db, category.id, 'news_digest'),
      countCategoryContents(db, category.id, 'analysis'),
      countCategoryContents(db, category.id, 'forecast'),
    ]);
    items = list;
    counts = {
      news_digest: digestCount,
      analysis: analysisCount,
      forecast: forecastCount,
    };
  } catch (error) {
    console.error('[archive] load contents failed', { code, kind, error });
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

  const activeLabel = TABS.find((tab) => tab.kind === kind)?.label ?? '重大新闻';

  return (
    <>
      <main className="terminal">
        <div className="shell">
          <nav className="cd-crumbs" aria-label="面包屑">
            <Link href="/">行情</Link>
            <span aria-hidden="true">/</span>
            <Link href={`/c/${category.code}`}>{category.name}</Link>
            <span aria-hidden="true">/</span>
            <span>历史内容</span>
          </nav>

          <header className="archive-head">
            <p className="t-eyebrow">ARCHIVE / {category.code}</p>
            <h1>
              {category.name}
              <span className="archive-head-sub">历史内容</span>
            </h1>
            <p className="archive-head-meta">
              按日期倒序展示已发布的{activeLabel}。演示数据标注来源为「离线新闻样例」与「演示历史价格」。
            </p>
          </header>

          <nav className="archive-tabs" aria-label="内容类型">
            {TABS.map((tab) => (
              <Link
                key={tab.kind}
                className={`archive-tab${tab.kind === kind ? ' active' : ''}`}
                href={`/c/${category.code}/archive?kind=${tab.kind}`}
                aria-current={tab.kind === kind ? 'page' : undefined}
              >
                {tab.label}
                <span className="archive-tab-count">{counts[tab.kind]}</span>
              </Link>
            ))}
          </nav>

          <ArchiveList items={items} />
        </div>
      </main>
      <SiteFooter info={emptyFooterInfo()} />
    </>
  );
}