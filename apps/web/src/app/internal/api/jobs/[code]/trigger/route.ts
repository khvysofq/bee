import { eq } from 'drizzle-orm';
import { v4 } from '@bee/db';
import { enqueueRun } from '@bee/jobs/queue';
import { db } from '@/db';
import { authorizeAdmin, errorResponse } from '@/lib/internal-auth';
import { getBoss } from '@/lib/jobs-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 立即入队一次：scheduled_for 为空，避免与 cron 时间窗冲突。重复点击在队列层幂等。 */
export async function POST(request: Request, context: { params: Promise<{ code: string }> }): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;
  const { code } = await context.params;
  const [job] = await db.select().from(v4.job).where(eq(v4.job.code, code)).limit(1);
  if (!job) return errorResponse('not_found', `任务不存在：${code}`, 404);

  let boss;
  try {
    boss = await getBoss();
  } catch (error) {
    console.error('[jobs] 队列不可用', error);
    return errorResponse('queue_unavailable', 'pg-boss 队列不可用', 503);
  }
  if (!boss) return errorResponse('queue_unavailable', '缺少 DATABASE_URL', 503);

  const jobId = await enqueueRun(boss, code, { scheduledFor: null, trigger: 'manual' });
  return Response.json(
    {
      queued: jobId !== null,
      job_id: jobId,
      job_code: code,
      reason: jobId === null ? 'already_queued' : null,
    },
    { status: jobId === null ? 200 : 202 },
  );
}