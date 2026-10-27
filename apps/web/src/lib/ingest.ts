import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { dbSchema, type BeeDb } from '@bee/db';
import {
  aggregateDailyQuotes,
  applyValidation,
  createFixtureReviewer,
  JOBS_EXTRACT_VERSION,
  normalizeRows,
  observationFromNormalized,
  planValidation,
  promptSha,
  readContent,
  sha256Hex,
  type ExtractedRow,
  type IngestPayload,
  type IngestQuoteRow,
} from '@bee/pipeline';
import {
  decideDuplicate,
  midOf,
  todayInShanghai,
  validateQuoteRows,
  VALIDATOR_VERSION,
  type ValidationOutcome,
} from '@bee/jobs/validator';
import { resolveWebStoreRoot } from './store-root';

/**
 * POST /internal/ingest 的业务实现：候选 → 校验 → 业务表。
 *
 * 这是 worker/agent 唯一能触达业务数据的路径。顺序：
 *  1. 顶层 schema 校验 + source 登记检查；
 *  2. 去重（dedupe_key）与跳变基线（同 jump_key 最近一次 accepted）查询；
 *  3. 纯函数校验器给出 accept/reject；
 *  4. 同一事务：登记存档 → 写候选 → 复用既有 normalize/validate/aggregate 链路写业务表。
 *
 * 「数字来自库」：这里写进 price_observation 的数字全部来自候选 payload（原文确定性解析），
 * 没有任何模型生成的值。
 */

const rawschema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  ref: z.string().min(1),
  url: z.string().min(1),
  fetched_at: z.string().min(1),
  http_status: z.number().int().min(0).max(599),
  content_type: z.string().nullable().optional(),
  bytes: z.number().int().min(0).nullable().optional(),
});

export const ingestPayloadSchema = z.object({
  job_run_id: z.string().uuid().nullable().optional(),
  kind: z.literal('quote'),
  source_code: z.string().min(1),
  rows: z.array(z.unknown()).min(1),
  evidence: z.object({
    raw: rawschema,
    adapter: z.string().optional(),
    selector: z.string().optional(),
  }),
  allow_jump: z.boolean().optional(),
});

export class IngestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  skipped: number;
  ids: string[];
  raw_fetch_id?: string;
}

export interface IngestOptions {
  /** 测试注入：固定「今天」。 */
  today?: string;
  allowJump?: boolean;
  storeRoot?: string;
  /** 测试/调试：跳过存档内容 sha 复核。 */
  skipArchiveCheck?: boolean;
}

function fallbackDedupeKey(sourceCode: string, index: number, row: unknown): string {
  return `invalid:${sourceCode}:${index}:${sha256Hex(JSON.stringify(row)).slice(0, 16)}`;
}

function toExtractedRow(row: IngestQuoteRow): ExtractedRow {
  return {
    sourceRowIndex: row.source_row_index,
    rawText: row.raw_text,
    rawValueLow: row.price_low,
    rawValueHigh: row.price_high,
    rawUnit: row.raw_unit,
    rawCategoryText: row.raw_category_text,
    rawSpecText: row.raw_spec_text,
    rawRegionText: row.raw_region_text,
    rawPriceTypeText: row.raw_price_type_text,
    quoteDate: row.quote_date,
    observedAt: row.observed_at ? new Date(row.observed_at) : null,
    rawChangeValue: null,
  };
}

function dedupeKeyOf(row: unknown, sourceCode: string, index: number): string {
  if (row && typeof row === 'object' && typeof (row as { dedupe_key?: unknown }).dedupe_key === 'string') {
    const key = (row as { dedupe_key: string }).dedupe_key;
    if (key.length > 0) return key;
  }
  return fallbackDedupeKey(sourceCode, index, row);
}

function jumpKeyOf(row: unknown): string | null {
  if (row && typeof row === 'object' && typeof (row as { jump_key?: unknown }).jump_key === 'string') {
    return (row as { jump_key: string }).jump_key;
  }
  return null;
}

export async function ingestPayload(
  db: BeeDb,
  input: unknown,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const parsed = ingestPayloadSchema.safeParse(input);
  if (!parsed.success) {
    throw new IngestError(
      'invalid_payload',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      400,
    );
  }
  const payload = parsed.data as unknown as IngestPayload;
  const today = options.today ?? todayInShanghai();
  const allowJump = options.allowJump ?? payload.allow_jump ?? false;

  const [source] = await db
    .select()
    .from(dbSchema.source)
    .where(eq(dbSchema.source.code, payload.source_code))
    .limit(1);
  if (!source) {
    throw new IngestError('unknown_source', `source 未登记：${payload.source_code}`, 422);
  }

  // 存档完整性：worker 已写 RAW_STORE_DIR；这里按 sha 复核，确保 evidence 不是编造的。
  if (!options.skipArchiveCheck) {
    let body: string;
    try {
      body = await readContent(resolveWebStoreRoot(options.storeRoot), payload.evidence.raw.ref);
    } catch (error) {
      throw new IngestError('archive_missing', `存档不存在：${payload.evidence.raw.ref}（${String(error)}）`, 422);
    }
    if (sha256Hex(body) !== payload.evidence.raw.sha256) {
      throw new IngestError('archive_mismatch', '存档内容与 evidence.sha256 不一致', 422);
    }
  }

  const keys = payload.rows.map((row, index) => dedupeKeyOf(row, payload.source_code, index));
  const existing = keys.length
    ? await db
        .select({ id: dbSchema.ingestCandidate.id, dedupeKey: dbSchema.ingestCandidate.dedupeKey, status: dbSchema.ingestCandidate.status })
        .from(dbSchema.ingestCandidate)
        .where(inArray(dbSchema.ingestCandidate.dedupeKey, keys))
    : [];
  const existingByKey = new Map(existing.map((row) => [row.dedupeKey, row]));

  // 跳变基线：同 jump_key 最近一次 accepted 的候选值。P0 只看候选缓冲，不回查业务表。
  const acceptedHistory = await db
    .select({ payload: dbSchema.ingestCandidate.payload })
    .from(dbSchema.ingestCandidate)
    .where(eq(dbSchema.ingestCandidate.status, 'accepted'))
    .orderBy(desc(dbSchema.ingestCandidate.createdAt))
    .limit(500);
  const previousMidByKey: Record<string, number> = {};
  for (const entry of acceptedHistory) {
    const held = entry.payload as IngestQuoteRow;
    if (!held?.jump_key || previousMidByKey[held.jump_key] !== undefined) continue;
    if (typeof held.price_low === 'number' && typeof held.price_high === 'number') {
      previousMidByKey[held.jump_key] = midOf(held);
    }
  }

  const outcomes = validateQuoteRows(payload.rows, { today, allowJump, previousMidByKey });

  const jobRejected: Array<{ index: number; outcome: ValidationOutcome; key: string }> = [];
  const idempotent: Array<{ index: number; id: string; key: string }> = [];
  const newAccepted: Array<{ index: number; outcome: ValidationOutcome; key: string }> = [];
  const newRejected: Array<{ index: number; outcome: ValidationOutcome; key: string }> = [];
  const skippedKeys = new Set<string>();

  outcomes.forEach((outcome, index) => {
    const key = keys[index]!;
    const prior = existingByKey.get(key);
    const decision = decideDuplicate(prior as { status: 'pending' | 'accepted' | 'rejected' } | undefined);
    if (decision === 'idempotent_accepted' && prior) {
      idempotent.push({ index, id: prior.id, key });
      return;
    }
    if (decision === 'skip') {
      skippedKeys.add(key);
      return;
    }
    if (outcome.status === 'reject') {
      if (outcome.code === 'jump_suspicious') jobRejected.push({ index, outcome, key });
      else newRejected.push({ index, outcome, key });
      return;
    }
    newAccepted.push({ index, outcome, key });
  });

  const raw = payload.evidence.raw;
  const fetchedAt = new Date(raw.fetched_at);
  if (Number.isNaN(fetchedAt.getTime())) throw new IngestError('invalid_payload', 'evidence.raw.fetched_at 非法', 400);

  const result = await db.transaction(async (tx) => {
    let rawFetchId: string | undefined;
    await tx
      .insert(dbSchema.rawContent)
      .values({ contentSha256: raw.sha256, contentRef: raw.ref })
      .onConflictDoNothing({ target: dbSchema.rawContent.contentSha256 });
    const [fetch] = await tx
      .insert(dbSchema.rawFetch)
      .values({
        sourceId: source.id,
        runId: null,
        url: raw.url,
        fetchedAt,
        httpStatus: raw.http_status,
        contentSha256: raw.sha256,
        contentType: raw.content_type ?? null,
        contentSizeBytes: raw.bytes ?? null,
        fetchMeta: { adapter: payload.evidence.adapter ?? null, selector: payload.evidence.selector ?? null },
      })
      .returning();
    rawFetchId = fetch!.id;

    const evidenceRef = {
      raw,
      adapter: payload.evidence.adapter ?? null,
      selector: payload.evidence.selector ?? null,
    };

    const candidateIdByKey = new Map<string, string>();
    const ids: string[] = idempotent.map((item) => item.id);
    let accepted = idempotent.length;
    let rejected = 0;
    let skipped = skippedKeys.size;

    for (const item of [...newAccepted, ...newRejected, ...jobRejected]) {
      const [row] = await tx
        .insert(dbSchema.ingestCandidate)
        .values({
          jobRunId: payload.job_run_id ?? null,
          kind: payload.kind,
          payload: {
            ...(typeof payload.rows[item.index] === 'object' && payload.rows[item.index] !== null
              ? (payload.rows[item.index] as unknown as Record<string, unknown>)
              : {}),
            source_code: payload.source_code,
            row_index: item.index,
          },
          schemaOk: item.outcome.schemaOk,
          dedupeKey: item.key,
          evidenceRef: { ...evidenceRef, row_index: item.index },
          status: 'pending',
          validatorVersion: VALIDATOR_VERSION,
        })
        .onConflictDoNothing({ target: dbSchema.ingestCandidate.dedupeKey })
        .returning({ id: dbSchema.ingestCandidate.id });
      if (!row) {
        skipped += 1;
        continue;
      }
      ids.push(row.id);
      candidateIdByKey.set(item.key, row.id);
    }

    // 先记录校验器拒绝的候选，它们不进入业务链。
    for (const item of [...newRejected, ...jobRejected]) {
      const candidateId = candidateIdByKey.get(item.key);
      if (!candidateId) continue;
      await tx
        .update(dbSchema.ingestCandidate)
        .set({ status: 'rejected', rejectReason: item.outcome.reason })
        .where(eq(dbSchema.ingestCandidate.id, candidateId));
      rejected += 1;
    }

    if (newAccepted.length > 0) {
      const rows = newAccepted.map((item) => toExtractedRow(item.outcome.row!));
      const normalized = await normalizeRows(tx, {
        sourceId: source.id,
        sourceCode: payload.source_code,
        fetchId: rawFetchId,
        fetchedAt,
        runId: null,
        extractVersion: JOBS_EXTRACT_VERSION,
        rows,
      });
      const reviewer = createFixtureReviewer();
      const plan = await planValidation(tx, {
        observations: normalized.map((item) => observationFromNormalized(item)),
        reviewer,
      });
      await applyValidation(tx, {
        plan,
        runId: null,
        stepId: null,
        rulesVersion: 'jobs-ingest@v1',
        reviewer,
        promptSha: promptSha(reviewer),
      });

      const statusById = new Map(plan.items.map((item) => [item.observationId, item.status]));
      const validatedIds: string[] = [];
      // normalizeRows 按输入顺序返回；newAccepted 与 rows 一一对应。
      for (const [position, item] of newAccepted.entries()) {
        const observation = normalized[position];
        const candidateId = candidateIdByKey.get(item.key);
        if (!observation || !candidateId) continue;
        const finalStatus = statusById.get(observation.observationId) ?? observation.status;
        const warn = item.outcome.warnings.length > 0 ? item.outcome.warnings.join('; ') : null;
        if (finalStatus === 'validated') {
          validatedIds.push(observation.observationId);
          await tx
            .update(dbSchema.ingestCandidate)
            .set({ status: 'accepted', acceptedRowId: observation.observationId, rejectReason: warn })
            .where(eq(dbSchema.ingestCandidate.id, candidateId));
          accepted += 1;
        } else {
          await tx
            .update(dbSchema.ingestCandidate)
            .set({
              status: 'rejected',
              rejectReason: `existing_validator:${finalStatus}${warn ? `; ${warn}` : ''}`,
            })
            .where(eq(dbSchema.ingestCandidate.id, candidateId));
          rejected += 1;
        }
      }

      if (validatedIds.length > 0) {
        await aggregateDailyQuotes(tx, {
          runId: null,
          observationIds: validatedIds,
          rulesVersion: 'jobs-ingest@v1',
        });
      }
    }

    return { accepted, rejected, skipped, ids, raw_fetch_id: rawFetchId } satisfies IngestResult;
  });

  return result;
}