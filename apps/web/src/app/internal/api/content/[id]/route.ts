import { db } from '@/db';
import { AdminInputError } from '@/lib/admin-audit';
import { contentStatusSchema, setContentStatus } from '@/lib/content-admin';
import { authorizeAdmin, errorResponse } from '@/lib/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 内容审核：只允许 published / hidden。 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_json', '请求体不是合法 JSON', 400);
  }

  const parsed = contentStatusSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse('invalid_status', 'body 需要 { status: "published" | "hidden" }', 422);
  }

  try {
    const data = await setContentStatus(db, id, parsed.data.status);
    return Response.json({ data });
  } catch (error) {
    if (error instanceof AdminInputError) {
      return errorResponse(error.code, error.message, error.status);
    }
    throw error;
  }
}