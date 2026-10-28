import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  DemoFlag,
  KindBadge,
  VerifiedMark,
  companyTypeLabel,
  priceText,
  quantityText,
} from '@/components/OpportunityCards';
import { SiteFooter, emptyFooterInfo } from '@/components/SiteFooter';
import { db } from '@/db';
import { getOpportunity } from '@/lib/opportunities-data';

export const dynamic = 'force-dynamic';

/** 商机详情：/opportunities/<id>。 */
export default async function OpportunityDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  let detail: Awaited<ReturnType<typeof getOpportunity>> = null;
  try {
    detail = await getOpportunity(db, id);
  } catch (error) {
    console.error('[opportunity] getOpportunity failed', { id, error });
    return (
      <main className="terminal">
        <div className="shell">
          <div className="t-not-found">
            <h1>商机暂时无法读取</h1>
            <p>数据库不可达。恢复后刷新即可。</p>
          </div>
        </div>
        <SiteFooter info={emptyFooterInfo()} />
      </main>
    );
  }

  if (!detail) notFound();

  const price = priceText(detail);
  const quantity = quantityText(detail);

  return (
    <>
      <main className="terminal">
        <div className="shell">
          <nav className="opp-crumbs" aria-label="面包屑">
            <Link href="/opportunities">商机</Link>
            <span aria-hidden="true">/</span>
            <Link href={`/opportunities?category=${detail.categoryCode}`}>
              {detail.categoryName}
            </Link>
            <span aria-hidden="true">/</span>
            <span className="opp-crumb-current">{detail.title}</span>
          </nav>

          <div className="opp-detail-layout">
            <article className="opp-detail">
              <header className="opp-detail-head">
                <div className="opp-detail-badges">
                  <KindBadge kind={detail.kind} status={detail.status} />
                  <DemoFlag isDemo={detail.isDemo} />
                </div>
                <h1>{detail.title}</h1>
                <p className="opp-detail-meta">
                  {detail.categoryName} · {detail.provinceName ? `${detail.provinceName} · ` : ''}
                  {detail.regionName}
                </p>
              </header>

              <dl className="opp-facts">
                <div>
                  <dt>品类</dt>
                  <dd>{detail.categoryName}</dd>
                </div>
                <div>
                  <dt>地区</dt>
                  <dd>
                    {detail.provinceName ? `${detail.provinceName} · ` : ''}
                    {detail.regionName}
                  </dd>
                </div>
                <div>
                  <dt>数量</dt>
                  <dd>{quantity ?? '—'}</dd>
                </div>
                <div>
                  <dt>参考价</dt>
                  <dd className="opp-price">{price ?? '面议'}</dd>
                </div>
                <div>
                  <dt>截止日期</dt>
                  <dd>{detail.deadline ?? '—'}</dd>
                </div>
                <div>
                  <dt>发布时间</dt>
                  <dd>{detail.publishedAt.slice(0, 10)}</dd>
                </div>
              </dl>

              <section className="opp-detail-body" aria-labelledby="opp-detail-desc">
                <h2 id="opp-detail-desc">需求说明</h2>
                <p>{detail.description ?? '暂无补充说明。'}</p>
                <p className="opp-disclaimer">
                  演示数据：企业名称、联系人、联系方式与价格区间均为虚构或按行情生成的展示值，不构成交易邀约或成交承诺。
                </p>
              </section>

              <footer className="opp-detail-foot">
                <Link className="text-link" href="/opportunities">
                  ← 返回商机列表
                </Link>
              </footer>
            </article>

            <aside className="opp-company-panel" aria-labelledby="opp-company-title">
              <header className="opp-company-panel-head">
                <h2 id="opp-company-title">发布企业</h2>
                <VerifiedMark verified={detail.company.verified} />
              </header>

              <Link className="opp-company-name" href={`/companies/${detail.company.id}`}>
                {detail.company.name}
              </Link>

              <dl className="opp-company-facts">
                <div>
                  <dt>类型</dt>
                  <dd>{companyTypeLabel(detail.company.type)}</dd>
                </div>
                <div>
                  <dt>地区</dt>
                  <dd>
                    {detail.company.provinceName ? `${detail.company.provinceName} · ` : ''}
                    {detail.company.regionName}
                  </dd>
                </div>
                <div>
                  <dt>规模</dt>
                  <dd>{detail.company.scale ?? '—'}</dd>
                </div>
                <div>
                  <dt>主营</dt>
                  <dd>{detail.company.mainProducts ?? '—'}</dd>
                </div>
                <div>
                  <dt>联系人</dt>
                  <dd>{detail.company.contactName ?? detail.company.name}</dd>
                </div>
                <div>
                  <dt>电话</dt>
                  <dd>{detail.company.contactPhone ?? '—'}</dd>
                </div>
              </dl>

              {detail.company.description ? (
                <p className="opp-company-desc">{detail.company.description}</p>
              ) : null}

              <Link className="opp-company-link" href={`/companies/${detail.company.id}`}>
                查看该公司其它商机
                {detail.otherOpenCount > 0 ? `（${detail.otherOpenCount} 条）` : ''} →
              </Link>
            </aside>
          </div>
        </div>
      </main>
      <SiteFooter info={emptyFooterInfo()} />
    </>
  );
}