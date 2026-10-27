/**
 * 品牌标识（GUA-33）：六边形校准靶 —— 石墨底 + 信号绿十字。
 * 和「校准台」设计语言同源：仪器、刻度、可校准。
 */
export function BrandMark(props: { size?: number }) {
  const size = props.size ?? 26;
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 26 26"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="24" height="24" fill="var(--color-ink)" />
      <path
        d="M13 5.4 20.2 9.6v7.6L13 21.4 5.8 17.2V9.6L13 5.4Z"
        stroke="var(--color-signal)"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M13 10v6M10 13h6" stroke="var(--color-signal)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark(props: { showSub?: boolean }) {
  const showSub = props.showSub ?? true;
  return (
    <span className="brand">
      <BrandMark />
      <span className="brand-text">
        <span className="brand-word">bee</span>
        {showSub ? <span className="brand-sub">再生物资行情</span> : null}
      </span>
    </span>
  );
}