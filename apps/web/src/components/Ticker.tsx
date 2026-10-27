import type { Direction } from '@/lib/presentation';

/**
 * 头部信号条（服务端渲染）：品类 · 最新价 · 涨跌。
 *
 * 数字全部来自 Layout 传入的已发布报价（loadLandingData），不轮询、不请求、
 * 不补点。往返滚动只靠 CSS translateX；副本 aria-hidden，避免重复朗读。
 */
export interface TickerEntry {
  name: string;
  spec: string;
  value: string;
  unit: string;
  direction: Direction;
  change: string;
  arrow: string;
}

export function Ticker(props: { entries: TickerEntry[]; quoteDate: string | null }) {
  const { entries, quoteDate } = props;

  if (entries.length === 0) {
    return (
      <div className="w-ticker" role="status">
        <p className="w-ticker-empty">暂无已发布报价 · 缺失不当作持平</p>
      </div>
    );
  }

  const group = (hidden: boolean) => (
    <div className="w-ticker-group" aria-hidden={hidden || undefined}>
      {quoteDate ? <span className="w-ticker-date">报价日 {quoteDate}</span> : null}
      {entries.map((entry) => (
        <span className="w-ticker-item" key={`${entry.name}-${entry.spec}`}>
          <span className="w-ticker-sep" aria-hidden="true">
            ▮
          </span>
          <span className="w-ticker-name">{entry.name}</span>
          <span className="w-ticker-price">
            {entry.value}
            <span className="w-ticker-name"> {entry.unit}</span>
          </span>
          <span className={`w-ticker-change ${entry.direction}`}>
            <span aria-hidden="true">{entry.arrow}</span> {entry.change}
          </span>
        </span>
      ))}
    </div>
  );

  return (
    <div className="w-ticker" role="region" aria-label="品类最新价与涨跌">
      <div
        className="w-ticker-track"
        tabIndex={0}
        aria-label="品类最新价与涨跌，悬停或聚焦暂停"
      >
        {group(false)}
        {group(true)}
      </div>
    </div>
  );
}