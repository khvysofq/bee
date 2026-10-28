import { V4_INGEST_MESSAGE } from '../../../lib/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /internal/ingest —— 采集写业务表的唯一入口。
 *
 * v4 的校验/入库链路尚未实现：保留入口，明确返回 501，不写任何表。
 */
export async function POST(_request?: Request): Promise<Response> {
  return Response.json({ error: V4_INGEST_MESSAGE }, { status: 501 });
}