import { db } from '@/db';
import { authorizeAdmin } from '@/lib/internal-auth';
import { listContents } from '@/lib/content-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') ?? undefined;
  const status = url.searchParams.get('status') ?? undefined;
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;

  const data = await listContents(db, {
    kind: kind || undefined,
    status: status || undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return Response.json({ data });
}