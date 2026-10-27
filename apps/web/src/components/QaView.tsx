import { SiteFooter, type FooterInfo } from '@/components/SiteFooter';

/**
 * 行业问答页（GUA-33）。
 * 尚未开放：不接问答模型、不展示演示答案、不伪造问答内容。
 * 明确说明能力、边界和「没有数据支撑就不回答」的规则。
 */

const CAPABILITIES = [
  {
    title: '解释行情',
    body: '报价为什么有区间、中值怎么得到、涨跌和哪一天比较 —— 每个回答都指向具体报价日。',
  },
  {
    title: '找到数据',
    body: '哪个品类、规格、地域在什么日期有报价；没有覆盖的地方会直接说明，不拿相近数据顶替。',
  },
  {
    title: '划清边界',
    body: '没有数据支撑的问题直接说不知道；不把生成内容伪装成行情事实，也不给交易建议。',
  },
];

const EXAMPLES = ['品类与规格怎么分', '报价为什么有区间', '涨跌和哪一天比'];

export function QaView(props: { info: FooterInfo }) {
  return (
    <main>
      <div className="shell">
        <header className="qa-hero">
          <h1 className="page-title">行业问答</h1>
          <p className="page-sub">
            把行业里的常识问清楚。问答能力筹备中：开放后只回答有数据支撑的问题，不编造答案。
          </p>

          <form className="qa-form" aria-describedby="qa-availability">
            <div className="qa-input-wrap">
              <label htmlFor="qa-question">你的问题</label>
              <input
                id="qa-question"
                className="qa-input"
                type="text"
                placeholder="例如：废钢的报价区间为什么有高低？"
                disabled
              />
            </div>
            <button className="qa-submit" type="button" disabled>
              即将开放
            </button>
          </form>
          <p className="qa-note" id="qa-availability">
            筹备中的功能不接收提问，也不展示演示答案；开放时间以站内更新为准。
          </p>

          <div className="qa-examples">
            <span className="qa-examples-label">可以问</span>
            {EXAMPLES.map((example) => (
              <span key={example}>{example}</span>
            ))}
          </div>
        </header>

        <section className="section" aria-labelledby="capability-title">
          <div className="section-head">
            <h2 id="capability-title">开放后能做什么</h2>
            <p>每个回答都会给出依据的报价日与数据范围；没有依据就不回答。</p>
          </div>
          <div className="capability-grid">
            {CAPABILITIES.map((capability, index) => (
              <article className="capability" key={capability.title}>
                <p className="mono-label">{`0${index + 1}`}</p>
                <h3>{capability.title}</h3>
                <p>{capability.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section" aria-labelledby="boundary-title">
          <div className="boundary">
            <h2 id="boundary-title">问答边界</h2>
            <ul>
              <li>
                <strong>不编造</strong>
                没有数据支撑的问题，明确说明暂不能回答，不用生成内容补空。
              </li>
              <li>
                <strong>不作交易建议</strong>
                不提供买卖指令、价格目标或收益承诺；问答只解释数据与行业常识。
              </li>
              <li>
                <strong>标明更新日期</strong>
                回答引用行情时，同时给出报价日与数据范围；缺失不当作持平。
              </li>
            </ul>
          </div>
        </section>

        <p className="qa-next">
          先看数据：
          <a href="/market">行情数据</a>
          <span aria-hidden="true">·</span>
          <a href="/outlook">趋势推演</a>
        </p>
      </div>

      <SiteFooter info={props.info} />
    </main>
  );
}