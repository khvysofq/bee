'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TraceIndicatorResponse, TraceQuoteResponse } from '@bee/core';

export type TraceKind = 'quote' | 'indicator';

const CHECK_KIND_LABEL: Record<string, string> = {
  cross_source: '跨源对照',
  time_series: '时序阈值',
  caliber_consistency: '口径一致性',
  dedupe: '去重',
  threshold_rule: '阈值规则',
  llm_judgment: 'Agent 判断',
  human_override: '人工覆盖',
};

const VERDICT_LABEL: Record<string, string> = {
  pass: '通过',
  flag: '标记',
  isolate: '隔离',
  needs_human: '需人工',
  reject: '拒绝',
};

const SOURCE_TYPE_LABEL: Record<string, string> = {
  webpage: '网页',
  rss: 'RSS',
  api: 'API',
};

const METHOD_LABEL: Record<string, string> = {
  single_source: '单源直取',
  median_multi_source: '多源中位',
  weighted_multi_source: '多源加权',
};

function fmt(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function fmtTime(value: string | null): string {
  if (!value) return '—';
  return value.replace('T', ' ').replace('.000Z', 'Z');
}

function priceText(value: number | null): string {
  return value === null ? '—' : fmt(value);
}

function errorDetail(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as { detail?: unknown; error?: unknown };
    if (typeof record.detail === 'string') return record.detail;
    if (typeof record.error === 'string') return record.error;
  }
  return `HTTP ${status}`;
}

export function TraceNumber(props: {
  kind: TraceKind;
  id: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`trace-number ${props.className ?? ''}`.trim()}
        data-trace-kind={props.kind}
        data-trace-id={props.id}
        aria-label={props.label}
        title={props.label}
        onClick={() => setOpen(true)}
      >
        {props.children}
      </button>
      {open ? <TraceDialog kind={props.kind} id={props.id} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function TraceDialog(props: { kind: TraceKind; id: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [quoteTrace, setQuoteTrace] = useState<TraceQuoteResponse | null>(null);
  const [indicatorTrace, setIndicatorTrace] = useState<TraceIndicatorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drillQuote, setDrillQuote] = useState<{ id: string; trace: TraceQuoteResponse | null; loading: boolean } | null>(
    null,
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [props]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/trace/${props.kind}/${props.id}`, { cache: 'no-store' })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(errorDetail(payload, response.status));
        if (cancelled) return;
        if (props.kind === 'quote') setQuoteTrace(payload as TraceQuoteResponse);
        else setIndicatorTrace(payload as TraceIndicatorResponse);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.kind, props.id]);

  const loadQuote = (quoteId: string) => {
    setDrillQuote({ id: quoteId, trace: null, loading: true });
    fetch(`/api/trace/quote/${quoteId}`, { cache: 'no-store' })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(errorDetail(payload, response.status));
        setDrillQuote({ id: quoteId, trace: payload as TraceQuoteResponse, loading: false });
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setDrillQuote({ id: quoteId, trace: null, loading: false });
      });
  };

  return (
    <div className="trace-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <section className="trace-panel" role="dialog" aria-modal="true" aria-label="数字溯源面板">
        <header className="trace-head">
          <div>
            <p className="trace-eyebrow">数据溯源</p>
            <h2>{props.kind === 'quote' ? '定档报价 → 原始存档' : '加工指标 → 贡献报价'}</h2>
          </div>
          <button ref={closeRef} type="button" className="trace-close" onClick={props.onClose} aria-label="关闭溯源面板">
            关闭
          </button>
        </header>

        {loading ? <p className="trace-muted">加载溯源链…</p> : null}
        {error ? <p className="trace-error">溯源不可用：{error}</p> : null}

        {quoteTrace ? <QuoteTraceView trace={quoteTrace} /> : null}
        {indicatorTrace ? (
          <IndicatorTraceView
            trace={indicatorTrace}
            onOpenQuote={loadQuote}
            drillQuote={drillQuote}
          />
        ) : null}
      </section>
    </div>
  );
}

function QuoteTraceView(props: { trace: TraceQuoteResponse }) {
  const { quote, observations } = props.trace;
  return (
    <div className="trace-body">
      <p className="trace-title">
        {quote.categoryName} · {quote.specName} · {quote.regionName}
        <span className="tag">{quote.regionLevel === 'city' ? '城市' : '市场'}</span>
      </p>
      <dl className="trace-kv">
        <div>
          <dt>报价日</dt>
          <dd>{quote.quoteDate}</dd>
        </div>
        <div>
          <dt>价格</dt>
          <dd className="trace-price">
            {fmt(quote.valueLow)} – {fmt(quote.valueHigh)} <small>元/吨</small>
          </dd>
        </div>
        <div>
          <dt>中值</dt>
          <dd>
            {fmt(quote.valueMid)} 元/吨
          </dd>
        </div>
        <div>
          <dt>定档方法</dt>
          <dd>
            {METHOD_LABEL[quote.method] ?? quote.method}
            <code>{quote.methodVersion}</code>
          </dd>
        </div>
        <div>
          <dt>置信度</dt>
          <dd>{quote.confidence}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{quote.status}</dd>
        </div>
      </dl>
      {quote.coverageNote ? <p className="trace-note">覆盖说明：{quote.coverageNote}</p> : null}

      <h3>参与定档的观测（{observations.length}）</h3>
      {observations.length === 0 ? <p className="trace-error">该报价没有贡献观测，数字不可发布。</p> : null}
      {observations.map((observation, index) => (
        <article className="trace-observation" key={observation.observationId}>
          <header>
            <strong>
              #{index + 1} {observation.source.name}
            </strong>
            <span className="tag">可信权重 {observation.source.trustWeight}</span>
            <span className="tag">{SOURCE_TYPE_LABEL[observation.source.type] ?? observation.source.type}</span>
            <span className={`tag tag-${observation.validationStatus}`}>{observation.validationStatus}</span>
          </header>
          <dl className="trace-kv">
            <div>
              <dt>抓取 URL</dt>
              <dd>
                <code>{observation.url}</code>
              </dd>
            </div>
            <div>
              <dt>抓取时间</dt>
              <dd>{fmtTime(observation.fetchedAt)}</dd>
            </div>
            <div>
              <dt>内容指纹</dt>
              <dd>
                <code title={observation.contentSha256}>{observation.contentSha256.slice(0, 16)}…</code>
              </dd>
            </div>
            <div>
              <dt>原文读数</dt>
              <dd>
                <q>{observation.rawText}</q> {observation.rawUnit ?? ''}
              </dd>
            </div>
            <div>
              <dt>规范化</dt>
              <dd>
                {priceText(observation.normValueLow)} – {priceText(observation.normValueHigh)} 元/吨
              </dd>
            </div>
            <div>
              <dt>报价日</dt>
              <dd>{observation.quoteDate ?? '来源未标注'}</dd>
            </div>
          </dl>
          <div className="trace-trail">
            <p className="trace-trail-title">抽取 / 校验留痕</p>
            <ul>
              <li>
                <strong>抽取</strong>：原文 “{observation.rawText}” → 数值{' '}
                {observation.rawValueLow ?? '—'} – {observation.rawValueHigh ?? '—'} {observation.rawUnit ?? ''} → 元/吨{' '}
                {priceText(observation.normValueLow)} – {priceText(observation.normValueHigh)}
              </li>
              {observation.validationTrail.map((validation, trailIndex) => (
                <li key={`${validation.performedByRef}-${trailIndex}`}>
                  <strong>{CHECK_KIND_LABEL[validation.checkKind] ?? validation.checkKind}</strong>
                  {' → '}
                  <span className={`verdict verdict-${validation.verdict}`}>
                    {VERDICT_LABEL[validation.verdict] ?? validation.verdict}
                  </span>
                  {' · '}
                  <code>{validation.performedByRef}</code> · {fmtTime(validation.at)}
                  {validation.detail ? (
                    <details>
                      <summary>判断依据</summary>
                      <pre>{JSON.stringify(validation.detail, null, 2)}</pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          <a className="trace-archive-link" href={observation.archiveViewerUrl}>
            查看原始存档与完整抽取链 →
          </a>
        </article>
      ))}
    </div>
  );
}

function IndicatorTraceView(props: {
  trace: TraceIndicatorResponse;
  onOpenQuote: (quoteId: string) => void;
  drillQuote: { id: string; trace: TraceQuoteResponse | null; loading: boolean } | null;
}) {
  const { indicator, quotes } = props.trace;
  return (
    <div className="trace-body">
      <p className="trace-title">
        {indicator.categoryName} · {indicator.regionName}
        <span className="tag tag-aggregate">加工指标</span>
      </p>
      <dl className="trace-kv">
        <div>
          <dt>指标类型</dt>
          <dd>{indicator.kind}</dd>
        </div>
        <div>
          <dt>基准日</dt>
          <dd>{indicator.basisDate}</dd>
        </div>
        <div>
          <dt>指标值</dt>
          <dd className="trace-price">
            {fmt(indicator.value)} <small>元/吨</small>
          </dd>
        </div>
        <div>
          <dt>口径说明</dt>
          <dd>
            {typeof indicator.methodJson === 'object' &&
            indicator.methodJson !== null &&
            'note' in indicator.methodJson &&
            typeof (indicator.methodJson as { note?: unknown }).note === 'string'
              ? (indicator.methodJson as { note: string }).note
              : '见 method_json'}
          </dd>
        </div>
        <div>
          <dt>方法版本</dt>
          <dd>
            <code>{indicator.methodVersion}</code>
          </dd>
        </div>
      </dl>
      <p className="trace-note">这是加工指标，不是全国统一观测价；由下列定档报价计算得出。</p>
      <h3>贡献报价（{quotes.length}）</h3>
      <ul className="trace-contributions">
        {quotes.map((quote) => (
          <li key={quote.quoteId}>
            <span>
              <code>{quote.quoteId.slice(0, 8)}…</code> · 聚合时值 {fmt(quote.valueAtAggregation)} 元/吨
            </span>
            <button type="button" className="inline-link" onClick={() => props.onOpenQuote(quote.quoteId)}>
              查看该定档报价溯源 →
            </button>
          </li>
        ))}
      </ul>
      {props.drillQuote ? (
        <section className="trace-drill">
          <h3>贡献报价详情</h3>
          {props.drillQuote.loading ? <p className="trace-muted">加载中…</p> : null}
          {props.drillQuote.trace ? <QuoteTraceView trace={props.drillQuote.trace} /> : null}
          {!props.drillQuote.loading && !props.drillQuote.trace ? (
            <p className="trace-error">该贡献报价溯源不可用（{props.drillQuote.id}）。</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
