import { db } from '@/db';
import { AdminInputError } from '@/lib/admin-audit';
import { authorizeAdmin, errorResponse } from '@/lib/internal-auth';
import { listSources, sourceInputSchema, upsertSource } from '@/lib/sources-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;
  const data = await listSources(db);
  return Response.json({ data });
}

/** 新建/更新来源：body 带 id 为更新，否则新建。 */
export async function POST(request: Request): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_json', '请求体不是合法 JSON', 400);
  }

  const parsed = sourceInputSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      'invalid_source',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      422,
    );
  }

  try {
    const data = await upsertSource(db, parsed.data);
    return Response.json({ data });
  } catch (error) {
    if (error instanceof AdminInputError) {
      return errorResponse(error.code, error.message, error.status);
    }
    throw error;
  }
}