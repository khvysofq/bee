import { db } from '@/db';
import { authorizeAdmin, errorResponse } from '@/lib/internal-auth';
import { toggleJob } from '@/lib/jobs-admin';
import { getBoss } from '@/lib/jobs-queue';
import { deleteJobSchedule } from '@bee/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ code: string }> }): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;
  const { code } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_json', '请求体不是合法 JSON', 400);
  }
  const enabled = (body as { enabled?: unknown })?.enabled;
  if (typeof enabled !== 'boolean') {
    return errorResponse('invalid_request', 'body 需要 { enabled: boolean }', 400);
  }
  const job = await toggleJob(db, code, enabled);
  if (!job) return errorResponse('not_found', `任务不存在：${code}`, 404);

  // 立即收敛 schedule；失败也不影响库状态，scheduler 会在 60s 内兜底。
  if (!enabled) {
    try {
      const boss = await getBoss();
      if (boss) await deleteJobSchedule(boss, code);
    } catch (error) {
      console.warn('[jobs] 停用时移除 schedule 失败，等待 scheduler 对账', error);
    }
  }

  return Response.json({ job: { code: job.code, enabled: job.enabled, schedule: job.schedule } });
}