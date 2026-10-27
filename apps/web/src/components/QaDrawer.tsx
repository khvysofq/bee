'use client';

import { useEffect, useRef, useState } from 'react';
import { QaAnswerBlock } from '@/components/QaAnswerView';
import { EXAMPLE_QUESTIONS } from '@/lib/qa/examples';
import type { QaAnswer } from '@/lib/qa/types';

/**
 * 全站右侧问答抽屉。
 *
 * 检索与回答逻辑复用 /qa：请求 /api/qa/answer，服务端调用同一个 answerQuestion。
 * 桌面固定 380px 覆盖在右侧；移动端全屏。提问不保存、不公开。
 */
export function QaDrawer(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<QaAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  async function ask(raw: string) {
    const value = raw.trim().slice(0, 200);
    if (!value || loading) return;
    setQuestion(value);
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      const response = await fetch(`/api/qa/answer?q=${encodeURIComponent(value)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`问答服务暂时不可用（${response.status}）`);
      const data = (await response.json()) as { answer: QaAnswer | null };
      setAnswer(data.answer);
    } catch (reason) {
      setAnswer(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <div className="qa-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="qa-drawer" role="dialog" aria-modal="true" aria-label="行业问答">
        <header className="qa-drawer-head">
          <span className="qa-drawer-title">
            行业问答
            <small>Q&amp;A / 走库取数</small>
          </span>
          <div>
            <a className="qa-drawer-close" href="/qa" title="打开完整问答页" aria-label="打开完整问答页">
              ↗
            </a>{' '}
            <button className="qa-drawer-close" type="button" onClick={onClose} aria-label="关闭问答">
              ✕
            </button>
          </div>
        </header>

        <div className="qa-drawer-body">
          <form
            className="qa-drawer-form"
            onSubmit={(event) => {
              event.preventDefault();
              void ask(question);
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：今天苏州重废多少"
              maxLength={200}
              aria-label="你的问题"
            />
            <button type="submit" disabled={loading || question.trim().length === 0}>
              {loading ? '查询中' : '提问'}
            </button>
          </form>

          <div className="qa-drawer-examples">
            {EXAMPLE_QUESTIONS.map((example) => (
              <button key={example} type="button" onClick={() => void ask(example)}>
                {example}
              </button>
            ))}
          </div>

          <p className="qa-drawer-note">
            提问不保存、不公开；价格数字一律来自报价库，不由模型生成。没有依据就说没有。
          </p>

          {loading ? <p className="t-trace-loading">正在检索报价库与站内说明…</p> : null}
          {error ? <p className="t-trace-error">{error}</p> : null}

          {answer ? (
            <div className="qa-drawer-answer">
              <QaAnswerBlock answer={answer} compact />
            </div>
          ) : null}

          <p className="qa-drawer-foot">
            分析参考，非投资建议。完整页面的能力说明与边界见 <a href="/qa">/qa</a>。
          </p>
        </div>
      </aside>
    </>
  );
}