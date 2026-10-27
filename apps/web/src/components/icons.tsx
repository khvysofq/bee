/**
 * 三大功能的图形符号。线性、几何、单色 currentColor：
 * 行情 = 读数柱；趋势 = 已发生的折线；问答 = 对话刻度。
 */
type IconProps = { size?: number };

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

export function MarketIcon(props: IconProps) {
  const size = props.size ?? 22;
  return (
    <svg {...base(size)}>
      <path d="M4 20V4M4 20h16" />
      <path d="M8 20v-7M12.5 20V8M17 20v-4" />
    </svg>
  );
}

export function OutlookIcon(props: IconProps) {
  const size = props.size ?? 22;
  return (
    <svg {...base(size)}>
      <path d="M3 17.5 8.5 11l4 3.5L21 5.5" />
      <path d="M15.5 5.5H21v5.5" />
      <path d="M3 20.5h18" strokeDasharray="1 3" />
    </svg>
  );
}

export function QaIcon(props: IconProps) {
  const size = props.size ?? 22;
  return (
    <svg {...base(size)}>
      <path d="M3.5 5.5h17v11h-9.5L6 20v-3.5H3.5v-11Z" />
      <path d="M8 10.5h8M8 13.5h5" />
    </svg>
  );
}

export function ArrowRight(props: { size?: number }) {
  const size = props.size ?? 15;
  return (
    <svg {...base(size)} className="arrow">
      <path d="M4 12h15M13.5 6.5 19 12l-5.5 5.5" />
    </svg>
  );
}