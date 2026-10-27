import { QaAnswerBlock } from '@/components/QaAnswerView';
import { SiteFooter, type FooterInfo } from '@/components/SiteFooter';
import { EXAMPLE_QUESTIONS } from '@/lib/qa/examples';
import type { QaAnswer } from '@/lib/qa/types';

/**
 * 行业问答页（GUA-35）。
 *
 * 渲染层只做一件事：把 `QaAnswer` 里已经算好的文字与数字原样输出。
 *  - 数字只出现在 `facts` / `scope` 的行里，每行都带 daily_quote / derived_indicator 出处；
 *  - 叙事段落（模板或模型）不含数字，模型输出在 answer 层已被扫描过；
 *  - 越界问题渲染代码常量话术，稳定可测；
 *  - 表单是普通 GET，不依赖 JS，也不保存提问（问答默认不公开）。
 */

const CAPABILITIES = [
  {
    title: '解释行情',
    body: '报价为什么有区间、中值怎么得到、涨跌和哪一天比较 —— 每个回答都指向具体报价日。',
  },
  {
    title: '找到数据',
    body: '哪个品类、规格、地域在什么日期有报价；没有覆盖的地方直接说明，不拿相近数据顶替。',
  },
  {
    title: '划清边界',
    body: '没有依据的问题直接说不知道；不把生成内容伪装成行情事实，也不给交易建议。',
  },
];

export function QaView(props: { info: FooterInfo; answer?: QaAnswer | null }) {
  const { info, answer } = props;
  return (
    <main>
      <div className="shell">
        <header className="qa-hero">
          <h1 className="page-title">行业问答</h1>
          <p className="page-sub">
            只回答两类问题：报价库里真实存在的价格事实，以及站内说明里的行业常识。未来价位、买卖建议、收益承诺与法律税务等专业意见一律不回答。
          </p>

          <form className="qa-form" method="get" action="/qa" aria-describedby="qa-availability">
            <div className="qa-input-wrap">
              <label htmlFor="qa-question">你的问题</label>
              <input
                id="qa-question"
                className="qa-input"
                type="text"
                name="q"
                defaultValue={answer?.question ?? ''}
                placeholder="例如：今天苏州重废多少"
                autoComplete="off"
                maxLength={200}
              />
            </div>
            <button className="qa-submit" type="submit">
              提问
            </button>
          </form>
          <p className="qa-note" id="qa-availability">
            提问不保存、不公开；价格数字一律来自报价库，不由模型生成，没有依据就说没有。
          </p>

          <div className="qa-examples">
            <span className="qa-examples-label">可以问</span>
            {EXAMPLE_QUESTIONS.map((example) => (
              <a key={example} href={`/qa?q=${encodeURIComponent(example)}`}>
                {example}
              </a>
            ))}
          </div>
        </header>

        {answer ? (
          <QaAnswerBlock answer={answer} />
        ) : (
          <section className="section qa-empty" aria-labelledby="qa-empty-title">
            <div className="section-head">
              <h2 id="qa-empty-title">输入问题后开始查询</h2>
              <p>
                事实型问题给出报价日、当日区间与真实变化；常识型问题引自站内说明并给出处；越界问题会被明确拒绝。
              </p>
            </div>
          </section>
        )}

        <section className="section" aria-labelledby="capability-title">
          <div className="section-head">
            <h2 id="capability-title">能做什么</h2>
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
                没有依据的问题明确说不知道，不用生成内容补空，也不用估算值填数字。
              </li>
              <li>
                <strong>不作交易建议</strong>
                不提供买卖指令、价格目标或收益承诺；问答只解释数据与行业常识。
              </li>
              <li>
                <strong>标明报价日与范围</strong>
                回答引用行情时，同时给出报价日与数据范围；缺失不当作持平。
              </li>
            </ul>
          </div>
        </section>
      </div>

      <SiteFooter info={info} />
    </main>
  );
}
