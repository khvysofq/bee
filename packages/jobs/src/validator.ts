import { z } from 'zod';
import { UNIT_TEXT_TO_CODE, type IngestQuoteRow } from '@bee/pipeline';

/**
 * 候选校验器（纯函数，不碰数据库）。
 *
 * 职责边界（ADR-0010）：数字来自原文确定性解析；这里只判断「能不能进业务表」。
 *  - schema：字段齐全、类型正确；
 *  - 数值：0 < price < 1e7，单位必须已知，日期不晚于今天、不早于 2000-01-01；
 *  - 跳变：同 key 上一期值 ±50% 以上 → jump_suspicious（默认拒绝，allowJump 时放行并留痕）；
 *  - 去重：dedupe_key 冲突由调用方查库后用 decideDuplicate 决定（accepted 幂等返回，pending 跳过）。
 *
 * 纯函数意味着：同一输入永远同一结论，便于单测与回放。
 */

export const VALIDATOR_VERSION = 'jobs-validator@1.0.0';
export const MIN_QUOTE_DATE = '2000-01-01';
export const MAX_PRICE = 1e7;
export const JUMP_THRESHOLD = 0.5;

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const ingestQuoteRowSchema = z.object({
  dedupe_key: z.string().min(1).max(500),
  jump_key: z.string().min(1).max(500),
  source_row_index: z.number().int().min(0),
  raw_text: z.string().min(1),
  raw_category_text: z.string().min(1),
  raw_spec_text: z.string().nullable(),
  raw_region_text: z.string().nullable(),
  raw_province_text: z.string().nullable().optional(),
  raw_price_type_text: z.string().nullable(),
  raw_unit: z.string().min(1),
  price_low: z.number().finite(),
  price_high: z.number().finite(),
  quote_date: z.string().regex(isoDate),
  observed_at: z.string().nullable(),
  change_text: z.string().nullable().optional(),
});

export type ValidationCode =
  | 'schema_invalid'
  | 'unknown_unit'
  | 'value_out_of_range'
  | 'invalid_date'
  | 'jump_suspicious';

export interface ValidationOutcome {
  row: IngestQuoteRow | null;
  schemaOk: boolean;
  status: 'accept' | 'reject';
  code: ValidationCode | null;
  reason: string | null;
  /** 通过但需要留痕的说明（如人工放行的跳变）。 */
  warnings: string[];
}

export interface ValidateOptions {
  /** 今天（Asia/Shanghai，YYYY-MM-DD）。由调用方传入，纯函数不读时钟。 */
  today: string;
  allowJump?: boolean;
  /** jump_key → 上一期规范中值；缺省表示没有历史。 */
  previousMidByKey?: Record<string, number | null | undefined>;
}

function reject(row: IngestQuoteRow | null, schemaOk: boolean, code: ValidationCode, reason: string): ValidationOutcome {
  return { row, schemaOk, status: 'reject', code, reason, warnings: [] };
}

export function todayInShanghai(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function midOf(row: Pick<IngestQuoteRow, 'price_low' | 'price_high'>): number {
  return (row.price_low + row.price_high) / 2;
}

export function validateQuoteRow(input: unknown, options: ValidateOptions): ValidationOutcome {
  const parsed = ingestQuoteRowSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return reject(null, false, 'schema_invalid', `schema_invalid: ${detail}`);
  }
  const row = parsed.data as IngestQuoteRow;
  const warnings: string[] = [];

  if (!(row.raw_unit in UNIT_TEXT_TO_CODE)) {
    return reject(row, true, 'unknown_unit', `unknown_unit: 单位「${row.raw_unit}」不在换算表，禁止猜测`);
  }
  if (
    !Number.isFinite(row.price_low) ||
    !Number.isFinite(row.price_high) ||
    row.price_low <= 0 ||
    row.price_high <= 0 ||
    row.price_low >= MAX_PRICE ||
    row.price_high >= MAX_PRICE ||
    row.price_low > row.price_high
  ) {
    return reject(
      row,
      true,
      'value_out_of_range',
      `value_out_of_range: ${row.price_low}–${row.price_high} 超出 (0, ${MAX_PRICE}) 或区间倒置`,
    );
  }
  if (!isoDate.test(row.quote_date) || Number.isNaN(Date.parse(`${row.quote_date}T00:00:00Z`))) {
    return reject(row, true, 'invalid_date', `invalid_date: ${row.quote_date} 不是合法日期`);
  }
  if (row.quote_date > options.today) {
    return reject(row, true, 'invalid_date', `invalid_date: ${row.quote_date} 晚于今天 ${options.today}`);
  }
  if (row.quote_date < MIN_QUOTE_DATE) {
    return reject(row, true, 'invalid_date', `invalid_date: ${row.quote_date} 早于 ${MIN_QUOTE_DATE}`);
  }

  const previous = options.previousMidByKey?.[row.jump_key];
  if (previous !== undefined && previous !== null && previous > 0) {
    const current = midOf(row);
    const deviation = Math.abs(current - previous) / previous;
    if (deviation >= JUMP_THRESHOLD) {
      const reason =
        `jump_suspicious: 同 key 上一期 ${previous.toFixed(2)}，本期 ${current.toFixed(2)}，` +
        `偏离 ${(deviation * 100).toFixed(1)}% ≥ ${JUMP_THRESHOLD * 100}%`;
      if (!options.allowJump) return reject(row, true, 'jump_suspicious', reason);
      warnings.push(`${reason}（已按 --allow-jump 人工放行）`);
    }
  }

  return { row, schemaOk: true, status: 'accept', code: null, reason: null, warnings };
}

export function validateQuoteRows(inputs: unknown[], options: ValidateOptions): ValidationOutcome[] {
  return inputs.map((input) => validateQuoteRow(input, options));
}

export type DuplicateDecision = 'idempotent_accepted' | 'skip' | 'proceed';

/**
 * dedupe_key 冲突裁决：
 *  - 已 accepted → 幂等返回，不写第二条业务行；
 *  - pending / rejected → 跳过（同一份数据重复投递只留一条，人工已拒绝的不自动翻案）。
 */
export function decideDuplicate(existing: { status: 'pending' | 'accepted' | 'rejected' } | null | undefined): DuplicateDecision {
  if (!existing) return 'proceed';
  return existing.status === 'accepted' ? 'idempotent_accepted' : 'skip';
}