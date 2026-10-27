'use client';

import { useState } from 'react';
import type { RecentRow } from '@/lib/market-detail';
import { formatNumber } from '@/lib/presentation';
import { TracePanel } from './TracePanel';

/**
 * 最近 30 期数据表；每行可展开溯源。
 * 数字原样来自 RSC 传入的库查询结果，展开时才请求 /api/trace/*。
 */

function num(value: number | null): string {
  return value === null ? '—' : formatNumber(value);
}

export function DetailTable(props: { rows: RecentRow[]; kind: 'series' | 'quote'; unit: string }) {
  const { rows, kind, unit } = props;
  const [expanded, setExpanded] = useState<string | null>(null);
  const columns = kind === 'series' ? 8 : 5;

  if (rows.length === 0) {
    return <p className="t-trace-loading">没有可展示的历史记录；不补点、不插值。</p>;
  }

  return (
    <table className="t-table t-table-compact">
      <thead>
        <tr>
          <th scope="col">日期</th>
          <th scope="col" className="num">
            {kind === 'series' ? '结算 / 主值' : '中值'}
          </th>
          {kind === 'series' ? (
            <>
              <th scope="col" className="num t-optional">
                开
              </th>
              <th scope="col" className="num t-optional">
                高
              </th>
              <th scope="col" className="num t-optional">
                低
              </th>
              <th scope="col" className="num t-optional">
                成交 / 持仓
              </th>
            </>
          ) : (
            <th scope="col" className="num">
              区间
            </th>
          )}
          {kind === 'quote' ? <th scope="col">状态</th> : <th scope="col" className="num t-optional">版本</th>}
          <th scope="col">
            <span className="sr-only">溯源</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const open = expanded === row.id;
          const traceId = kind === 'series' ? row.id : row.quoteId;
          return (
            <RowGroup
              key={row.id}
              row={row}
              open={open}
              columns={columns}
              kind={kind}
              unit={unit}
              traceId={traceId}
              onToggle={() => setExpanded(open ? null : row.id)}
            />
          );
        })}
      </tbody>
    </table>
  );
}

function RowGroup(props: {
  row: RecentRow;
  open: boolean;
  columns: number;
  kind: 'series' | 'quote';
  unit: string;
  traceId: string | undefined;
  onToggle: () => void;
}) {
  const { row, open, columns, kind, unit, traceId, onToggle } = props;
  return (
    <>
      <tr>
        <td className="t-date">{row.date}</td>
        <td className="num">
          {num(row.value)}
          <small className="t-muted"> {unit}</small>
        </td>
        {kind === 'series' ? (
          <>
            <td className="num t-optional">{num(row.open)}</td>
            <td className="num t-optional">{num(row.high)}</td>
            <td className="num t-optional">{num(row.low)}</td>
            <td className="num t-optional">
              {num(row.volume)} / {num(row.openInterest)}
            </td>
            <td className="num t-optional">r{row.revision ?? 1}</td>
          </>
        ) : (
          <>
            <td className="num">
              {row.valueLow === null || row.valueLow === undefined
                ? '—'
                : `${formatNumber(row.valueLow)} – ${formatNumber(row.valueHigh ?? row.valueLow)}`}
            </td>
            <td className="t-muted">{row.status === 'published' ? '已发布' : (row.status ?? '—')}</td>
          </>
        )}
        <td>
          {traceId ? (
            <button className="t-trace-btn" type="button" onClick={onToggle} aria-expanded={open}>
              {open ? '收起' : '溯源'}
            </button>
          ) : (
            <span className="t-muted">—</span>
          )}
        </td>
      </tr>
      {open && traceId ? (
        <tr className="t-trace-row">
          <td colSpan={columns}>
            <TracePanel kind={kind} id={traceId} />
          </td>
        </tr>
      ) : null}
    </>
  );
}