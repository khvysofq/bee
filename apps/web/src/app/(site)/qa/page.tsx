import { QaView } from '@/components/QaView';
import { emptyFooterInfo, footerInfoFromLanding } from '@/components/SiteFooter';
import { db } from '@/db';
import { answerQuestion } from '@/lib/qa/answer';
import { loadLandingData } from '@/lib/landing-data';
import type { QaAnswer } from '@/lib/qa/types';

export const dynamic = 'force-dynamic';

/** 问题长度上限：够写清楚一个组合，也避免把整段文章塞进查询串。 */
const MAX_QUESTION_CHARS = 200;

interface QaSearchParams {
  q?: string | string[];
}

function readQuestion(params: QaSearchParams): string {
  const raw = Array.isArray(params.q) ? params.q[0] : params.q;
  return (raw ?? '').trim().slice(0, MAX_QUESTION_CHARS);
}

/**
 * 行业问答页（GUA-35）。
 *
 * 普通 GET 表单：`/qa?q=…` 直接渲染答案，不依赖 JS，也不落库保存提问
 * （问答默认不公开，见 docs/compliance/content-boundary-v1.md §6）。
 * 回答失败不 500：数据库不可达时降级为只答站内说明里的行业常识。
 */
export default async function QaPage(props: { searchParams: Promise<QaSearchParams> }) {
  const params = await props.searchParams;
  const question = readQuestion(params);

  const [info, answer] = await Promise.all([
    loadLandingData()
      .then(footerInfoFromLanding)
      .catch(() => emptyFooterInfo()),
    question
      ? answerQuestion(question, { db }).catch((): QaAnswer | null => null)
      : Promise.resolve(null),
  ]);

  return <QaView info={info} answer={answer} />;
}
