import { isValidCron } from '@bee/jobs/cron';
import { hasAdapter } from '@bee/jobs/adapters';
import { db } from '@/db';
import { authorizeAdmin, errorResponse } from '@/lib/internal-auth';
import { loadJobsData } from '@/lib/jobs-data';
import { jobDefinitionSchema, registerJob } from '@/lib/jobs-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;
  const data = await loadJobsData(db);
  return Response.json(data);
}

/** 新建/更新任务：按 code upsert。校验 cron 合法、adapter 存在。 */
export async function POST(request: Request): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_json', '请求体不是合法 JSON', 400);
  }
  const parsed = jobDefinitionSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      'invalid_job',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      422,
    );
  }
  const job = parsed.data;
  if (!isValidCron(job.schedule.cron)) {
    return errorResponse('invalid_cron', `cron 非法：${job.schedule.cron}`, 422);
  }
  if (job.adapter && !hasAdapter(job.adapter)) {
    return errorResponse('unknown_adapter', `adapter 未注册：${job.adapter}`, 422);
  }
  const saved = await registerJob(db, job);
  return Response.json({ job: saved });
}