import { db } from '@/db';
import { authorizeAdmin } from '@/lib/internal-auth';
import { loadCandidates } from '@/lib/jobs-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeAdmin(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit'));
  const candidates = await loadCandidates(db, {
    status: url.searchParams.get('status') ?? undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
  });
  return Response.json({ candidates });
}