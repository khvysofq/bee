'use client';

import { useEffect, useState } from 'react';

/**
 * 溯源展开面板：报价走 /api/trace/quote/{id}，序列点走 /api/trace/series/{id}。
 * 两块契约共享同一组来源字段；面板只展示，不做任何数值加工。
 */

interface QuoteTrace {
  kind: 'daily_quote';
  quote: {
    categoryName: string;
    specName: string;
    regionName: string;
    quoteDate: string;
    valueLow: number;
    valueHigh: number;
    valueMid: number;
    method: string;
    methodVersion: string;
    confidence: string;
    status: string;
  };
  observations: Array<{
    observationId: string;
    source: { code: string; name: string; type: string; trustWeight: number };
    url: string;
    fetchedAt: string;
    contentSha256: string;
    rawText: string;
    validationStatus: string;
    validationTrail: Array<{ checkKind: string; verdict: string; performedByRef: string }>;
    archiveViewerUrl: string;
  }>;
}

interface SeriesTrace {
  kind: 'series_point';
  point: {
    id: string;
    seriesCode: string;
    seriesName: string;
    venue: string | null;
    instrumentCode: string;
    obsDate: string;
    revision: number;
    value: number;
    unit: string | null;
    currency: string;
  };
  source: { code: string; name: string; type: string; trustWeight: number };
  url: string;
  fetchedAt: string;
  contentSha256: string;
  sourceRowIndex: number;
  archiveViewerUrl: string;
}

type Trace = QuoteTrace | SeriesTrace;

function fmtTime(value: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function SourceRows(props: {
  source: { code: string; name: string; type: string; trustWeight: number };
  url: string;
  fetchedAt: string;
  contentSha256: string;
  archiveViewerUrl: string;
  extra?: Array<[string, string]>;
}) {
  const { source, url, fetchedAt, contentSha256, archiveViewerUrl, extra } = props;
  return (
    <div className="t-trace-item">
      <strong>
        {source.name} <span className="t-trace-code">{source.code}</span>
      </strong>
      <dl>
        <dt>来源类型 / 权重</dt>
        <dd>
          {source.type} · {source.trustWeight}
        </dd>
        {extra?.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <dt>抓取 URL</dt>
        <dd>
          <a href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
        </dd>
        <dt>抓取时间</dt>
        <dd>{fmtTime(fetchedAt)}</dd>
        <dt>内容指纹</dt>
        <dd className="t-trace-code">{contentSha256}</dd>
        <dt>存档原文</dt>
        <dd>
          <a href={archiveViewerUrl} target="_blank" rel="noreferrer">
            查看抓取存档
          </a>
        </dd>
      </dl>
    </div>
  );
}

export function TracePanel(props: { kind: 'quote' | 'series'; id: string }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url =
      props.kind === 'quote'
        ? `/api/trace/quote/${encodeURIComponent(props.id)}`
        : `/api/trace/series/${encodeURIComponent(props.id)}`;
    setTrace(null);
    setError(null);
    fetch(url, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`溯源接口返回 ${response.status}`);
        return (await response.json()) as Trace;
      })
      .then((data) => {
        if (!cancelled) setTrace(data);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [props.kind, props.id]);

  if (error) {
    return (
      <div className="t-trace-panel">
        <p className="t-trace-error">溯源暂时不可用：{error}。页面上的数字仍来自数据库，未作修改。</p>
      </div>
    );
  }
  if (!trace) {
    return (
      <div className="t-trace-panel">
        <p className="t-trace-loading">正在读取原始抓取记录…</p>
      </div>
    );
  }

  if (trace.kind === 'series_point') {
    return (
      <div className="t-trace-panel">
        <h3>序列点溯源 · {trace.point.seriesName}</h3>
        <p>
          观测日 {trace.point.obsDate} · 版本 r{trace.point.revision} · 值 {trace.point.value}
          {trace.point.unit ? ` ${trace.point.unit}` : ''} · 来源行号 {trace.sourceRowIndex}
        </p>
        <p className="t-trace-code">
          {trace.point.seriesCode} · {trace.point.venue ?? '—'} · {trace.point.instrumentCode}
        </p>
        <div className="t-trace-list">
          <SourceRows
            source={trace.source}
            url={trace.url}
            fetchedAt={trace.fetchedAt}
            contentSha256={trace.contentSha256}
            archiveViewerUrl={trace.archiveViewerUrl}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="t-trace-panel">
      <h3>报价溯源 · {trace.quote.specName}</h3>
      <p>
        报价日 {trace.quote.quoteDate} · 区间 {trace.quote.valueLow} – {trace.quote.valueHigh} · 中值{' '}
        {trace.quote.valueMid} 元/吨 · {trace.quote.method}@{trace.quote.methodVersion}
      </p>
      <div className="t-trace-list">
        {trace.observations.map((observation) => (
          <SourceRows
            key={observation.observationId}
            source={observation.source}
            url={observation.url}
            fetchedAt={observation.fetchedAt}
            contentSha256={observation.contentSha256}
            archiveViewerUrl={observation.archiveViewerUrl}
            extra={[
              ['原文表述', observation.rawText],
              ['校验状态', observation.validationStatus],
              [
                '校验留痕',
                observation.validationTrail.length > 0
                  ? observation.validationTrail
                      .map((item) => `${item.checkKind}/${item.verdict}（${item.performedByRef}）`)
                      .join('；')
                  : '无',
              ],
            ]}
          />
        ))}
      </div>
    </div>
  );
}