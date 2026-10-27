import { NextResponse } from 'next/server';
import { db } from '@/db';
import { answerQuestion } from '@/lib/qa/answer';

export const dynamic = 'force-dynamic';

const MAX_QUESTION_CHARS = 200;

/**
 * 右侧问答抽屉的数据入口：与 /qa 页面复用同一套 answerQuestion 检索与回答逻辑。
 * 不落库、不保存提问；价格数字只来自报价库。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const question = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUESTION_CHARS);
  if (question.length === 0) {
    return NextResponse.json({ answer: null }, { headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const answer = await answerQuestion(question, { db });
    return NextResponse.json({ answer }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { answer: null, error: 'answer_unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}