import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadArchivePageData } from '@/lib/archive';

export const dynamic = 'force-dynamic';

function fmtDateTime(value: string | null): string {
  if (!value) return '—';
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function fmtNumber(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

export default async function RawArchivePage(props: { params: Promise<{ fetchId: string }> }) {
  const { fetchId } = await props.params;
  const data = await loadArchivePageData(fetchId);
  if (!data) notFound();

  return (
    <main className="container container-wide">
      <p className="eyebrow">原始存档查看器</p>
      <h1>抓取原文与抽取链</h1>
      <p className="sub">
        抓取 <code>{data.fetch.id}</code> · 存档内容按纯文本渲染，不执行页面脚本。
      </p>

      <section className={`archive-verify ${data.archive.sha256Matches ? 'ok' : 'bad'}`}>
        <strong>{data.archive.sha256Matches ? '内容指纹校验通过' : '内容指纹校验失败'}</strong>
        <span>
          登记 sha256 <code>{data.fetch.contentSha256}</code> · 实际读取 {data.archive.bytes} bytes
        </span>
      </section>

      <section className="archive-grid">
        <article className="archive-card">
          <h2>来源与抓取</h2>
          <dl className="trace-kv">
            <div>
              <dt>来源</dt>
              <dd>
                {data.source.name} <code>{data.source.code}</code>
              </dd>
            </div>
            <div>
              <dt>类型 / 可信权重</dt>
              <dd>
                {data.source.type} · {data.source.trustWeight}
              </dd>
            </div>
            <div>
              <dt>抓取 URL</dt>
              <dd>
                <code>{data.fetch.url}</code>
              </dd>
            </div>
            <div>
              <dt>抓取时间</dt>
              <dd>{fmtDateTime(data.fetch.fetchedAt)}</dd>
            </div>
            <div>
              <dt>HTTP / 内容类型</dt>
              <dd>
                {data.fetch.httpStatus} · {data.fetch.contentType ?? '—'}
              </dd>
            </div>
            <div>
              <dt>页面发布时间</dt>
              <dd>{fmtDateTime(data.fetch.pagePublishedAt)}</dd>
            </div>
            <div>
              <dt>内容引用</dt>
              <dd>
                <code>{data.fetch.contentRef}</code>
              </dd>
            </div>
            <div>
              <dt>robots / ToS</dt>
              <dd>
                {data.source.robotsStatus} ·{' '}
                {data.source.tosUrl ? (
                  <a href={data.source.tosUrl} rel="noreferrer noopener" target="_blank">
                    许可/条款
                  </a>
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
          {data.source.trustNote ? <p className="muted">权重说明：{data.source.trustNote}</p> : null}
          {data.source.robotsNote ? <p className="muted">robots 说明：{data.source.robotsNote}</p> : null}
        </article>

        <article className="archive-card">
          <h2>抓取上下文</h2>
          <pre className="json-block">{JSON.stringify(data.fetch.fetchMeta, null, 2)}</pre>
        </article>
      </section>

      <section className="archive-card">
        <h2>存档原文</h2>
        <p className="muted">
          存储根 <code>{data.archive.storeRoot}</code> · 只读查看 ·{' '}
          {data.archive.truncated ? '内容过大，以下仅为前 2MB' : '完整内容'}
        </p>
        <pre className="archive-body">{data.archive.body}</pre>
      </section>

      <section className="archive-card">
        <h2>抽取 / 规范化 / 校验留痕（{data.observations.length} 条）</h2>
        {data.observations.length === 0 ? <p className="empty-row">该次抓取没有产生观测。</p> : null}
        {data.observations.map((observation) => (
          <article className="archive-observation" key={observation.id}>
            <header>
              <strong>
                行 #{observation.sourceRowIndex} · revision {observation.revision}
              </strong>
              <span className={`tag tag-${observation.validationStatus}`}>{observation.validationStatus}</span>
              <span>
                {observation.categoryName ?? observation.rawCategoryText} ·{' '}
                {observation.specName ?? observation.rawSpecText ?? '—'} ·{' '}
                {observation.regionName ?? observation.rawRegionText ?? '—'}
              </span>
            </header>
            <dl className="trace-kv">
              <div>
                <dt>原文</dt>
                <dd>
                  <q>{observation.rawText}</q> {observation.rawUnit ?? ''}
                </dd>
              </div>
              <div>
                <dt>原文数值</dt>
                <dd>
                  {fmtNumber(observation.rawValueLow)} – {fmtNumber(observation.rawValueHigh)}
                </dd>
              </div>
              <div>
                <dt>规范化（元/吨）</dt>
                <dd>
                  {fmtNumber(observation.normValueLow)} – {fmtNumber(observation.normValueHigh)}
                </dd>
              </div>
              <div>
                <dt>换算依据</dt>
                <dd>
                  <code>{JSON.stringify(observation.conversionApplied)}</code>
                </dd>
              </div>
              <div>
                <dt>观测 ID</dt>
                <dd>
                  <code>{observation.id}</code>
                </dd>
              </div>
            </dl>
            <div className="trace-trail">
              <p className="trace-trail-title">校验留痕</p>
              <ul>
                {observation.validationTrail.map((validation, index) => (
                  <li key={`${validation.performedByRef}-${index}`}>
                    <strong>{validation.checkKind}</strong> → {validation.verdict} ·{' '}
                    <code>{validation.performedByRef}</code> · {fmtDateTime(validation.at)}
                    <details>
                      <summary>判断依据</summary>
                      <pre>{JSON.stringify(validation.detail, null, 2)}</pre>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </section>

      <p className="foot">
        <Link href="/internal/ops">← 返回内部运维</Link>
      </p>
    </main>
  );
}
