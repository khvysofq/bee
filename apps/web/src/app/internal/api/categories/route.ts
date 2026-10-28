import { db } from '@/db';
import { AdminInputError } from '@/lib/admin-audit';
import { categoryInputSchema, listCategories, upsertCategory } from '@/lib/categories-admin';
import { authorizeAdmin, errorResponse } from '@/lib/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;
  const data = await listCategories(db);
  return Response.json({ data });
}

/** 新建/更新品类：body 带 id 为更新，否则新建。 */
export async function POST(request: Request): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_json', '请求体不是合法 JSON', 400);
  }

  const parsed = categoryInputSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      'invalid_category',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      422,
    );
  }

  try {
    const data = await upsertCategory(db, parsed.data);
    return Response.json({ data });
  } catch (error) {
    if (error instanceof AdminInputError) {
      return errorResponse(error.code, error.message, error.status);
    }
    throw error;
  }
}