import Link from 'next/link';
import { CompanyMiniCard, DemoFlag, OpportunityCard, kindLabel } from '@/components/OpportunityCards';
import { SiteFooter, emptyFooterInfo } from '@/components/SiteFooter';
import { db } from '@/db';
import {
  loadCompaniesByRegion,
  loadOpportunities,
  loadOpportunityFacets,
  loadOpportunityStats,
} from '@/lib/opportunities-data';

export const dynamic = 'force-dynamic';

interface PageSearchParams {
  category?: string;
  kind?: string;
  region?: string;
}

const KINDS = ['purchase', 'supply', 'cooperation'] as const;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** 保留当前过滤条件，只替换一个维度；空值表示「全部」。 */
function filterHref(current: PageSearchParams, patch: PageSearchParams): string {
  const merged = { ...current, ...patch };
  const params = new URLSearchParams();
  if (merged.category) params.set('category', merged.category);
  if (merged.kind) params.set('kind', merged.kind);
  if (merged.region) params.set('region', merged.region);
  const query = params.toString();
  return query ? `/opportunities?${query}` : '/opportunities';
}

export default async function OpportunitiesPage(props: {
  searchParams: Promise<PageSearchParams>;
}) {
  const raw = await props.searchParams;
  const facets = await loadOpportunityFacets(db);

  // 只接受已知 code，未知参数按「全部」处理，不把任意字符串带进查询。
  const categoryCode = facets.categories.some((item) => item.code === first(raw.category))
    ? first(raw.category)
    : undefined;
  const kind = KINDS.includes(first(raw.kind) as (typeof KINDS)[number])
    ? first(raw.kind)
    : undefined;
  const regionCode = facets.regions.some((item) => item.code === first(raw.region))
    ? first(raw.region)
    : undefined;

  const filters = { categoryCode, kind, regionCode };
  const [stats, opportunities, companyGroups] = await Promise.all([
    loadOpportunityStats(db),
    loadOpportunities(db, filters),
    loadCompaniesByRegion(db, { categoryCode }),
  ]);

  const current: PageSearchParams = {};
  if (categoryCode) current.category = categoryCode;
  if (kind) current.kind = kind;
  if (regionCode) current.region = regionCode;

  return (
    <>
      <main className="terminal">
        <div className="shell">
          <header className="opp-head">
            <div className="opp-head-main">
              <h1 className="opp-title">商机</h1>
              <p className="opp-sub">
                按品类和地区查看采购需求、供应信息与典型企业。演示数据中的企业名称与联系方式均为虚构。
              </p>
            </div>
            <div className="opp-head-note">
              <span className="opp-live-dot" aria-hidden="true" />
              公开信息 · 只读展示
            </div>
          </header>

          <dl className="opp-stats" aria-label="商机统计">
            <div className="opp-stat">
              <dt>企业</dt>
              <dd>{stats.companyCount}</dd>
              <small>家地区典型企业</small>
            </div>
            <div className="opp-stat">
              <dt>采购需求</dt>
              <dd>{stats.purchaseCount}</dd>
              <small>条进行中</small>
            </div>
            <div className="opp-stat">
              <dt>供应信息</dt>
              <dd>{stats.supplyCount}</dd>
              <small>条进行中</small>
            </div>
            <div className="opp-stat">
              <dt>覆盖地区</dt>
              <dd>{stats.regionCount}</dd>
              <small>个主要城市</small>
            </div>
          </dl>

          <section className="opp-filters" aria-label="筛选商机">
            <div className="opp-filter-row">
              <span className="opp-filter-label">品类</span>
              <div className="opp-filter-options">
                <Link
                  className={`opp-filter${categoryCode ? '' : ' is-active'}`}
                  href={filterHref(current, { category: undefined })}
                >
                  全部
                </Link>
                {facets.categories.map((item) => (
                  <Link
                    key={item.code}
                    className={`opp-filter${categoryCode === item.code ? ' is-active' : ''}`}
                    href={filterHref(current, { category: item.code })}
                  >
                    {item.name}
                  </Link>
                ))}
              </div>
            </div>

            <div className="opp-filter-row">
              <span className="opp-filter-label">类型</span>
              <div className="opp-filter-options">
                <Link
                  className={`opp-filter${kind ? '' : ' is-active'}`}
                  href={filterHref(current, { kind: undefined })}
                >
                  全部
                </Link>
                {KINDS.map((item) => (
                  <Link
                    key={item}
                    className={`opp-filter${kind === item ? ' is-active' : ''}`}
                    href={filterHref(current, { kind: item })}
                  >
                    {kindLabel(item)}
                  </Link>
                ))}
              </div>
            </div>

            <div className="opp-filter-row">
              <span className="opp-filter-label">地区</span>
              <div className="opp-filter-options">
                <Link
                  className={`opp-filter${regionCode ? '' : ' is-active'}`}
                  href={filterHref(current, { region: undefined })}
                >
                  全部
                </Link>
                {facets.regions.map((item) => (
                  <Link
                    key={item.code}
                    className={`opp-filter${regionCode === item.code ? ' is-active' : ''}`}
                    href={filterHref(current, { region: item.code })}
                  >
                    {item.name}
                  </Link>
                ))}
              </div>
            </div>
          </section>

          <div className="opp-layout">
            <section className="opp-main" aria-labelledby="opp-list-title">
              <div className="opp-list-head">
                <h2 id="opp-list-title">商机信息流</h2>
                <span className="opp-list-count">{opportunities.length} 条</span>
              </div>

              {opportunities.length === 0 ? (
                <div className="opp-empty">
                  <h3>暂无符合条件的商机</h3>
                  <p>可以放宽品类、类型或地区筛选，查看全部进行中的商机。</p>
                  <Link className="text-link" href="/opportunities">
                    查看全部商机
                  </Link>
                </div>
              ) : (
                <div className="opp-list">
                  {opportunities.map((item) => (
                    <OpportunityCard key={item.id} item={item} />
                  ))}
                </div>
              )}
            </section>

            <aside className="opp-side" aria-labelledby="opp-side-title">
              <div className="opp-side-head">
                <h2 id="opp-side-title">地区典型企业</h2>
                <DemoFlag isDemo />
              </div>
              <p className="opp-side-note">
                按城市汇总，每组展示 3 家。认证标记表示演示数据中的资质状态，不代表真实工商核验。
              </p>

              {companyGroups.length === 0 ? (
                <div className="opp-side-empty">该品类暂无企业信息</div>
              ) : (
                <div className="company-groups">
                  {companyGroups.map((group) => (
                    <section className="company-group" key={group.regionCode}>
                      <header className="company-group-head">
                        <h3>
                          {group.provinceName ? `${group.provinceName} · ` : ''}
                          {group.regionName}
                        </h3>
                        <span>{group.total} 家</span>
                      </header>
                      <div className="company-group-list">
                        {group.companies.map((company) => (
                          <CompanyMiniCard key={company.id} company={company} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}

              <div className="opp-side-foot">
                <Link className="text-link" href="/">
                  ← 返回行情
                </Link>
              </div>
            </aside>
          </div>
        </div>
      </main>
      <SiteFooter info={emptyFooterInfo()} />
    </>
  );
}