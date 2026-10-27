import { describe, expect, it } from 'vitest';
import type { IngestQuoteRow } from '@bee/pipeline';
import {
  decideDuplicate,
  JUMP_THRESHOLD,
  midOf,
  validateQuoteRow,
  VALIDATOR_VERSION,
} from '../src/validator';

const TODAY = '2026-10-27';

function row(overrides: Partial<IngestQuoteRow> = {}): IngestQuoteRow {
  return {
    dedupe_key: 'quote:demo|广东|佛山|废铜|光亮铜线|参考价|2026-10-26',
    jump_key: 'quote:demo|广东|佛山|废铜|光亮铜线|参考价',
    source_row_index: 0,
    raw_text: '废铜 | 光亮铜线 | 广东 | 佛山 | 62000 | 元/吨 | +200 | 2026-10-26',
    raw_category_text: '废铜',
    raw_spec_text: '光亮铜线',
    raw_region_text: '佛山',
    raw_province_text: '广东',
    raw_price_type_text: '参考价',
    raw_unit: '元/吨',
    price_low: 62000,
    price_high: 62000,
    quote_date: '2026-10-26',
    observed_at: null,
    change_text: '+200',
    ...overrides,
  };
}

describe('jobs validator（纯函数）', () => {
  it('合法行通过，并返回规范中值', () => {
    const outcome = validateQuoteRow(row(), { today: TODAY });
    expect(outcome.status).toBe('accept');
    expect(outcome.schemaOk).toBe(true);
    expect(outcome.code).toBeNull();
    expect(midOf(outcome.row!)).toBe(62000);
    expect(VALIDATOR_VERSION).toBe('jobs-validator@1.0.0');
  });

  it('单位未知 → unknown_unit', () => {
    const outcome = validateQuoteRow(row({ raw_unit: '元/手' }), { today: TODAY });
    expect(outcome.status).toBe('reject');
    expect(outcome.code).toBe('unknown_unit');
    expect(outcome.reason).toContain('元/手');
  });

  it('越界与区间倒置 → value_out_of_range', () => {
    expect(validateQuoteRow(row({ price_low: 0, price_high: 0 }), { today: TODAY }).code).toBe('value_out_of_range');
    expect(validateQuoteRow(row({ price_low: 1e7, price_high: 1e7 }), { today: TODAY }).code).toBe('value_out_of_range');
    expect(validateQuoteRow(row({ price_low: 100, price_high: 90 }), { today: TODAY }).code).toBe('value_out_of_range');
  });

  it('日期晚于今天或早于 2000-01-01 → invalid_date', () => {
    expect(validateQuoteRow(row({ quote_date: '2026-10-28' }), { today: TODAY }).code).toBe('invalid_date');
    expect(validateQuoteRow(row({ quote_date: '1999-12-31' }), { today: TODAY }).code).toBe('invalid_date');
  });

  it('同 key 跳变 ≥ 50% → jump_suspicious；allowJump 放行并留痕', () => {
    const previousMidByKey = { [row().jump_key]: 40000 };
    const rejected = validateQuoteRow(row(), { today: TODAY, previousMidByKey });
    expect(rejected.status).toBe('reject');
    expect(rejected.code).toBe('jump_suspicious');
    expect(rejected.reason).toContain('55.0%');

    const allowed = validateQuoteRow(row(), { today: TODAY, previousMidByKey, allowJump: true });
    expect(allowed.status).toBe('accept');
    expect(allowed.warnings.join(' ')).toContain('allow-jump');
    expect(JUMP_THRESHOLD).toBe(0.5);

    const small = validateQuoteRow(row(), {
      today: TODAY,
      previousMidByKey: { [row().jump_key]: 50000 },
    });
    expect(small.status).toBe('accept');
  });

  it('schema 不合法 → schema_invalid（不抛异常）', () => {
    const outcome = validateQuoteRow({ dedupe_key: 'x' }, { today: TODAY });
    expect(outcome.status).toBe('reject');
    expect(outcome.code).toBe('schema_invalid');
    expect(outcome.schemaOk).toBe(false);
  });

  it('去重裁决：accepted 幂等、pending/rejected 跳过、无记录继续', () => {
    expect(decideDuplicate({ status: 'accepted' })).toBe('idempotent_accepted');
    expect(decideDuplicate({ status: 'pending' })).toBe('skip');
    expect(decideDuplicate({ status: 'rejected' })).toBe('skip');
    expect(decideDuplicate(null)).toBe('proceed');
    expect(decideDuplicate(undefined)).toBe('proceed');
  });
});