'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { dbSchema } from '@bee/db';
import { computeDictionaryHash, finishRun, startRun } from '@bee/pipeline';
import { db } from '@/db';
import { inspectionIdempotencyKey, loadOpsData, todayInShanghai } from '@/lib/ops';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function recordDailyInspection(formData: FormData): Promise<void> {
  const noteRaw = formData.get('note');
  const note = typeof noteRaw === 'string' ? noteRaw.trim().slice(0, 500) : '';
  const today = todayInShanghai();
  const snapshot = await loadOpsData(db);
  const pins = {
    gitSha: process.env.GIT_SHA ?? 'workspace',
    rulesVersion: 'ops-inspection@v1',
    dictionaryHash: await computeDictionaryHash(db),
  };

  const started = await startRun(db, {
    kind: 'maintenance',
    triggeredBy: 'human:local-board',
    idempotencyKey: inspectionIdempotencyKey(today),
    configJson: {
      inspectionDate: today,
      timeZone: 'Asia/Shanghai',
      actor: 'human:local-board（单人运营）',
      aiPrecheck: 'loadOpsData checklist',
      note,
      openExceptions: snapshot.summary.open,
      highPriorityExceptions: snapshot.summary.high,
      checklist: snapshot.checklist,
    },
    pins,
  });

  if (started.claimed) {
    await finishRun(db, started.run.id, { status: 'succeeded' });
  }

  revalidatePath('/ops');
  revalidatePath('/briefing');
}

export async function resolveException(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  if (!UUID.test(id)) throw new Error('非法异常 ID');
  const resolutionRaw = formData.get('resolution');
  const resolution =
    typeof resolutionRaw === 'string' && resolutionRaw.trim().length > 0
      ? resolutionRaw.trim().slice(0, 500)
      : '人工巡检确认：已处理';

  await db
    .update(dbSchema.exceptionQueue)
    .set({
      status: 'resolved',
      resolution,
      resolvedBy: 'human:local-board',
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(dbSchema.exceptionQueue.id, id), eq(dbSchema.exceptionQueue.status, 'open')));

  revalidatePath('/ops');
  revalidatePath('/briefing');
}
