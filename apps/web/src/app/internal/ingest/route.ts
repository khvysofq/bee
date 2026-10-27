import { db } from '@/db';
import { ingestPayload, IngestError } from '@/lib/ingest';
import { authorizeIngest, errorResponse } from '@/lib/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /internal/ingest —— worker/agent 写业务表的唯一入口。
 * 鉴权：Authorization: Bearer $INGEST_TOKEN；env 缺失 → 503，绝不无鉴权放行。
 */
export async function POST(request: Request): Promise<Response> {
  const denied = authorizeIngest(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_json', '请求体不是合法 JSON', 400);
  }

  try {
    const result = await ingestPayload(db, body);
    return Response.json(result);
  } catch (error) {
    if (error instanceof IngestError) return errorResponse(error.code, error.message, error.status);
    console.error('[ingest] internal error', error);
    return errorResponse('internal_error', 'ingest 处理失败', 500);
  }
}