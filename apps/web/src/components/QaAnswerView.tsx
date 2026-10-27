import type { QaAnswer, QaFactCard, QaKnowledgeCard } from '@/lib/qa/types';

/**
 * 问答回答渲染（/qa 页面与右侧抽屉共用）。
 * 只把 `QaAnswer` 里已经算好的文字与数字原样输出；不做二次计算。
 */

function FactCard(props: { card: QaFactCard }) {
  const { card } = props;
  return (
    <article className={`qa-fact qa-fact-${card.kind}`}>
      <h3 className="qa-fact-title">{card.title}</h3>
      <dl className="qa-fact-rows">
        {card.rows.map((row, index) => (
          <div className="qa-fact-row" key={`${row.label}-${index}`}>
            <dt>{row.label}</dt>
            <dd className={row.hasNumber ? 'is-figure' : undefined}>{row.text}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function KnowledgeCard(props: { card: QaKnowledgeCard }) {
  const { card } = props;
  return (
    <article className="qa-knowledge-card">
      <h3>{card.title}</h3>
      <p className="qa-knowledge-summary">{card.summary}</p>
      <ul>
        {card.body.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="qa-citation">出处：{card.citation}</p>
    </article>
  );
}

export function QaAnswerBlock(props: { answer: QaAnswer; compact?: boolean }) {
  const { answer, compact } = props;
  const isRefusal = answer.intent === 'refusal';
  const titleId = compact ? 'qa-drawer-answer-title' : 'qa-answer-title';
  return (
    <section
      className={`section qa-answer qa-answer-${answer.intent}`}
      aria-labelledby={titleId}
      data-intent={answer.intent}
    >
      <div className="section-head">
        <h2 id={titleId}>{answer.headline}</h2>
        <p className="qa-echo">你问的是：{answer.question}</p>
      </div>

      {answer.refusal ? (
        <div className="qa-refusal" role="note">
          <h3>{answer.refusal.title}</h3>
          <ul>
            {answer.refusal.body.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {answer.aiAssisted ? (
        <p className="qa-ai-flag">本次叙事由 AI 辅助生成；页面里的数字来自报价库，不由模型生成。</p>
      ) : null}

      <div className="qa-narrative">
        {answer.narrative.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>

      {answer.facts.length > 0 ? (
        <div className="qa-facts">
          {answer.facts.map((card) => (
            <FactCard key={`${card.refTable}-${card.refId}-${card.title}`} card={card} />
          ))}
        </div>
      ) : null}

      {answer.knowledge.length > 0 ? (
        <div className="qa-knowledge">
          {answer.knowledge.map((card) => (
            <KnowledgeCard key={card.id} card={card} />
          ))}
        </div>
      ) : null}

      {answer.missing.length > 0 ? (
        <div className={compact ? 'qa-drawer-missing' : 'qa-missing'}>
          <h3>{isRefusal ? '说明' : '没有查到的部分'}</h3>
          <ul>
            {answer.missing.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {answer.scope ? (
        <div className="qa-scope">
          <h3>数据范围</h3>
          <dl className="qa-scope-rows">
            {answer.scope.rows.map((row) => (
              <div className="qa-scope-row" key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.text}</dd>
              </div>
            ))}
          </dl>
          {answer.scope.available.length > 0 ? (
            <div className="qa-available">
              <p className="qa-available-label">当天可以看的组合</p>
              <ul>
                {answer.scope.available.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {!isRefusal && !compact ? (
        <p className="qa-next">
          想看全量数据：
          <a href="/">行情</a>
          <span aria-hidden="true">·</span>
          <a href="/outlook">推演</a>
        </p>
      ) : null}
    </section>
  );
}