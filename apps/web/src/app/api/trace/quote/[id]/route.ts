import { NextResponse } from 'next/server';
import { loadQuoteTrace } from '@/lib/trace';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'invalid_quote_id' }, { status: 400 });
  }
  try {
    const trace = await loadQuoteTrace(id);
    if (!trace) return NextResponse.json({ error: 'quote_not_found' }, { status: 404 });
    return NextResponse.json(trace, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: 'trace_unavailable', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
