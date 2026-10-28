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
import { getCompany } from '@/lib/opportunities-data';

export const dynamic = 'force-dynamic';

/** 企业详情：/companies/<id>，列出该企业全部进行中的商机。 */
export default async function CompanyPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  let company: Awaited<ReturnType<typeof getCompany>> = null;
  try {
    company = await getCompany(db, id);
  } catch (error) {
    console.error('[company] getCompany failed', { id, error });
    return (
      <main className="terminal">
        <div className="shell">
          <div className="t-not-found">
            <h1>企业信息暂时无法读取</h1>
            <p>数据库不可达。恢复后刷新即可。</p>
          </div>
        </div>
        <SiteFooter info={emptyFooterInfo()} />
      </main>
    );
  }

  if (!company) notFound();

  return (
    <>
      <main className="terminal">
        <div className="shell">
          <nav className="opp-crumbs" aria-label="面包屑">
            <Link href="/opportunities">商机</Link>
            <span aria-hidden="true">/</span>
            <Link href={`/opportunities?category=${company.categoryCode}`}>
              {company.categoryName}
            </Link>
            <span aria-hidden="true">/</span>
            <span className="opp-crumb-current">{company.name}</span>
          </nav>

          <article className="company-page">
            <header className="company-page-head">
              <div>
                <div className="company-page-badges">
                  <span className="company-type-badge">{companyTypeLabel(company.type)}</span>
                  <VerifiedMark verified={company.verified} />
                  <DemoFlag isDemo={company.isDemo} />
                </div>
                <h1>{company.name}</h1>
                <p className="company-page-meta">
                  {company.categoryName} ·{' '}
                  {company.provinceName ? `${company.provinceName} · ` : ''}
                  {company.regionName}
                </p>
              </div>
              <Link className="text-link" href="/opportunities">
                ← 返回商机列表
              </Link>
            </header>

            <dl className="company-facts">
              <div>
                <dt>企业类型</dt>
                <dd>{companyTypeLabel(company.type)}</dd>
              </div>
              <div>
                <dt>所在地区</dt>
                <dd>
                  {company.provinceName ? `${company.provinceName} · ` : ''}
                  {company.regionName}
                </dd>
              </div>
              <div>
                <dt>经营规模</dt>
                <dd>{company.scale ?? '—'}</dd>
              </div>
              <div>
                <dt>主营产品</dt>
                <dd>{company.mainProducts ?? '—'}</dd>
              </div>
              <div>
                <dt>联系人</dt>
                <dd>{company.contactName ?? '—'}</dd>
              </div>
              <div>
                <dt>联系电话</dt>
                <dd>{company.contactPhone ?? '—'}</dd>
              </div>
            </dl>

            <section className="company-about" aria-labelledby="company-about-title">
              <h2 id="company-about-title">企业简介</h2>
              <p>{company.description ?? '暂无简介。'}</p>
              <p className="opp-disclaimer">
                演示数据：企业名称、联系人、联系方式与认证状态均为虚构，不构成真实工商信息或交易背书。
              </p>
            </section>

            <section className="company-opps" aria-labelledby="company-opps-title">
              <div className="opp-list-head">
                <h2 id="company-opps-title">进行中的商机</h2>
                <span className="opp-list-count">{company.opportunities.length} 条</span>
              </div>

              {company.opportunities.length === 0 ? (
                <div className="opp-empty">
                  <h3>暂无进行中的商机</h3>
                  <p>该企业当前没有开放的采购、供应或合作信息。</p>
                </div>
              ) : (
                <div className="company-opp-list">
                  {company.opportunities.map((item) => {
                    const price = priceText(item);
                    const quantity = quantityText(item);
                    return (
                      <Link
                        className="company-opp-row"
                        key={item.id}
                        href={`/opportunities/${item.id}`}
                      >
                        <KindBadge kind={item.kind} status={item.status} />
                        <span className="company-opp-title">{item.title}</span>
                        <span className="company-opp-meta">
                          {quantity ? `${quantity} · ` : ''}
                          {price ? `参考 ${price}` : '价格面议'}
                        </span>
                        <span className="company-opp-date">{item.publishedAt.slice(0, 10)}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          </article>
        </div>
      </main>
      <SiteFooter info={emptyFooterInfo()} />
    </>
  );
}