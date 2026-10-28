import Link from 'next/link';
import { formatNumber } from '@/lib/presentation';
import {
  COMPANY_TYPE_LABEL,
  OPPORTUNITY_KIND_LABEL,
  type CompanySummary,
  type OpportunityListItem,
  type OpportunityKind,
} from '@/lib/opportunities-data';

/**
 * 商机频道共享展示件（服务端渲染，无客户端状态）：
 * 类型徽标、演示标记、商机卡片、侧栏企业条目。
 */

export function kindLabel(kind: string): string {
  return OPPORTUNITY_KIND_LABEL[kind as OpportunityKind] ?? kind;
}

export function companyTypeLabel(type: string): string {
  return COMPANY_TYPE_LABEL[type as keyof typeof COMPANY_TYPE_LABEL] ?? type;
}

export function KindBadge(props: { kind: string; status?: string }) {
  const { kind, status } = props;
  return (
    <span className={`opp-kind opp-kind-${kind}`}>
      {kindLabel(kind)}
      {status && status !== 'open' ? <span className="opp-kind-closed">已关闭</span> : null}
    </span>
  );
}

export function DemoFlag(props: { isDemo: boolean }) {
  return props.isDemo ? <span className="opp-demo">演示数据</span> : null;
}

export function VerifiedMark(props: { verified: boolean }) {
  return props.verified ? (
    <span className="company-verified" title="已认证">
      已认证
    </span>
  ) : (
    <span className="company-unverified">未认证</span>
  );
}

export function priceText(item: {
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
}): string | null {
  if (item.priceMin === null && item.priceMax === null) return null;
  const unit = item.currency === 'CNY' ? '元/吨' : item.currency;
  if (item.priceMin !== null && item.priceMax !== null) {
    return `${formatNumber(item.priceMin)}–${formatNumber(item.priceMax)} ${unit}`;
  }
  const single = item.priceMin ?? item.priceMax;
  return single === null ? null : `${formatNumber(single)} ${unit}`;
}

export function quantityText(item: {
  quantity: number | null;
  unit: string | null;
}): string | null {
  if (item.quantity === null) return null;
  return `${formatNumber(item.quantity)} ${item.unit ?? ''}`.trim();
}

export function OpportunityCard(props: { item: OpportunityListItem }) {
  const { item } = props;
  const price = priceText(item);
  const quantity = quantityText(item);

  return (
    <Link className="opp-card" href={`/opportunities/${item.id}`}>
      <div className="opp-card-top">
        <KindBadge kind={item.kind} status={item.status} />
        <span className="opp-card-cat">
          {item.categoryName} · {item.provinceName ? `${item.provinceName} · ` : ''}
          {item.regionName}
        </span>
        <span className="opp-card-date">{item.publishedAt.slice(0, 10)}</span>
      </div>

      <h3 className="opp-card-title">{item.title}</h3>

      <dl className="opp-card-facts">
        {quantity ? (
          <div>
            <dt>数量</dt>
            <dd>{quantity}</dd>
          </div>
        ) : null}
        {price ? (
          <div>
            <dt>参考价</dt>
            <dd className="opp-price">{price}</dd>
          </div>
        ) : null}
        {item.deadline ? (
          <div>
            <dt>截止</dt>
            <dd>{item.deadline}</dd>
          </div>
        ) : null}
      </dl>

      <div className="opp-card-foot">
        <span className="opp-card-company">
          {item.companyName}
          {item.verified ? <span className="opp-card-verified">已认证</span> : null}
        </span>
        <span className="opp-card-more">查看详情 →</span>
      </div>
    </Link>
  );
}

export function CompanyMiniCard(props: { company: CompanySummary }) {
  const { company } = props;
  return (
    <Link className="company-mini" href={`/companies/${company.id}`}>
      <span className="company-mini-name">{company.name}</span>
      <span className="company-mini-meta">
        <span className="company-mini-type">{companyTypeLabel(company.type)}</span>
        <span>{company.categoryName}</span>
        {company.verified ? <span className="company-mini-verified">✓</span> : null}
      </span>
      {company.mainProducts ? (
        <span className="company-mini-products">主营：{company.mainProducts}</span>
      ) : null}
      {company.scale ? <span className="company-mini-scale">{company.scale}</span> : null}
    </Link>
  );
}