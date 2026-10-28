import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * 右侧问答抽屉的数据入口。
 *
 * v4 的问答事实检索尚未重建（旧 observation/derived_indicator 已删除），
 * 这里明确返回 503，不降级成没有依据的回答。站内 /qa 页面仍可展示常识条目与「知识库重建中」提示。
 */
export async function GET() {
  return NextResponse.json(
    {
      answer: null,
      error: 'qa_rebuilding',
      message: '知识库重建中：问答事实检索暂不可用。',
    },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}