import { isValidCron } from '@bee/jobs/cron';
import { db } from '@/db';
import { authorizeAdmin, errorResponse } from '@/lib/internal-auth';
import { loadJobsData } from '@/lib/jobs-data';
import { jobSchema, registerJob } from '@/lib/jobs-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;
  const data = await loadJobsData(db);
  return Response.json(data);
}

/** 新建/更新任务：按 code upsert。校验 cron 合法；品类/来源 code 必须已登记。 */
export async function POST(request: Request): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_json', '请求体不是合法 JSON', 400);
  }
  const parsed = jobSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      'invalid_job',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      422,
    );
  }
  const job = parsed.data;
  const schedule = job.schedule as {
    mode?: string;
    cron?: string;
    windowStart?: string;
    windowEnd?: string;
  };
  if (schedule.mode === 'random_window') {
    const toMinutes = (value: string): number => {
      const [hour, minute] = value.split(':').map(Number);
      return (hour ?? 0) * 60 + (minute ?? 0);
    };
    if (
      !schedule.windowStart ||
      !schedule.windowEnd ||
      toMinutes(schedule.windowEnd) <= toMinutes(schedule.windowStart)
    ) {
      return errorResponse('invalid_window', `随机窗口非法：${schedule.windowStart}–${schedule.windowEnd}`, 422);
    }
  } else if (schedule.cron && !isValidCron(schedule.cron)) {
    return errorResponse('invalid_cron', `cron 非法：${schedule.cron}`, 422);
  }

  try {
    const saved = await registerJob(db, job);
    return Response.json({ job: saved });
  } catch (error) {
    return errorResponse(
      'invalid_reference',
      error instanceof Error ? error.message : String(error),
      422,
    );
  }
}