import { describe, expect, it } from 'vitest';
import {
  flagToBoolean,
  numericToNumber,
  timestampToIso,
  traceIndicatorResponseSchema,
  traceQuoteResponseSchema,
} from '../src';

describe('trace 转换层：numeric → number', () => {
  it('pg numeric 的 string 形态显式转 number', () => {
    expect(numericToNumber('2200.00')).toBe(2200);
    expect(numericToNumber('2200.50')).toBe(2200.5);
    expect(numericToNumber(3)).toBe(3);
  });

  it('null/undefined 透传为 null（契约的可空字段）', () => {
    expect(numericToNumber(null)).toBeNull();
    expect(numericToNumber(undefined)).toBeNull();
  });

  it('不可解析的值抛 TypeError，不悄悄变 NaN', () => {
    expect(() => numericToNumber('abc')).toThrow(TypeError);
    expect(() => numericToNumber('')).toThrow(TypeError);
  });
});

describe('trace 转换层：标志位 → boolean', () => {
  it('integer 0/1 与 boolean 都正确映射', () => {
    expect(flagToBoolean(1)).toBe(true);
    expect(flagToBoolean(0)).toBe(false);
    expect(flagToBoolean(true)).toBe(true);
    expect(flagToBoolean(false)).toBe(false);
    expect(flagToBoolean(null)).toBe(false);
  });

  it('非法值抛 TypeError', () => {
    expect(() => flagToBoolean(2 as never)).toThrow(TypeError);
    expect(() => flagToBoolean('1' as never)).toThrow(TypeError);
  });
});

describe('trace 转换层：timestamp → ISO', () => {
  it('Date 与 ISO 字符串都归一为 ISO 字符串', () => {
    expect(timestampToIso(new Date('2026-10-26T08:00:00Z'))).toBe('2026-10-26T08:00:00.000Z');
    expect(timestampToIso('2026-10-26T08:00:00Z')).toBe('2026-10-26T08:00:00.000Z');
  });

  it('无效时间抛 TypeError', () => {
    expect(() => timestampToIso('not-a-date')).toThrow(TypeError);
  });
});

/**
 * 契约锁定的两个方向：
 *  1) DB 行（numeric=string、时间=Date）直接塞 schema.parse 必须失败 —— 锁死「必须过转换层」；
 *  2) 过转换层后必须通过 —— 锁死「转换层是充分的」，DB 行形态的任何合法组合都能进契约。
 */
describe('trace 契约锁定：转换层是 DB 行 → 契约的必要且充分通道', () => {
  const dbShapedQuote = {
    id: 'q1',
    categoryName: '废钢',
    specName: '重废',
    regionName: '临沂',
    regionLevel: 'market' as const,
    quoteDate: new Date('2026-10-25T00:00:00Z'), // ← DB 给 Date
    priceType: 'purchase' as const,
    valueLow: '2200.00', // ← DB 给 numeric string
    valueHigh: '2210.00',
    valueMid: '2205.00',
    method: 'single_source' as const,
    methodVersion: 'v1',
    confidence: 'high' as const,
    coverageNote: null,
    status: 'published',
  };
  const dbShapedObservation = {
    observationId: 'o1',
    source: { code: 's1', name: '测试来源', trustWeight: '80.0', type: 'webpage' as const },
    url: 'https://example.com/price',
    fetchedAt: new Date('2026-10-25T08:00:00Z'),
    contentSha256: 'a'.repeat(64),
    rawText: '2200-2210 元/吨',
    rawValueLow: '2200.00',
    rawValueHigh: '2210.00',
    rawUnit: '元/吨',
    normValueLow: '2200.00',
    normValueHigh: '2210.00',
    quoteDate: new Date('2026-10-25T00:00:00Z'),
    validationStatus: 'validated',
    validationTrail: [
      {
        checkKind: 'threshold_rule' as const,
        verdict: 'pass' as const,
        performedByRef: 'rule:scrap-range@v1',
        detail: null,
        at: new Date('2026-10-25T08:00:05Z'),
      },
    ],
    archiveViewerUrl: '/raw/f1',
  };

  it('直接把 DB 行塞进契约必须失败', () => {
    expect(() =>
      traceQuoteResponseSchema.parse({ kind: 'daily_quote', quote: dbShapedQuote, observations: [dbShapedObservation] }),
    ).toThrow();
  });

  it('过转换层后必须通过契约', () => {
    const converted = {
      kind: 'daily_quote' as const,
      quote: {
        ...dbShapedQuote,
        quoteDate: timestampToIso(dbShapedQuote.quoteDate),
        valueLow: numericToNumber(dbShapedQuote.valueLow)!,
        valueHigh: numericToNumber(dbShapedQuote.valueHigh)!,
        valueMid: numericToNumber(dbShapedQuote.valueMid)!,
      },
      observations: [
        {
          ...dbShapedObservation,
          source: { ...dbShapedObservation.source, trustWeight: numericToNumber(dbShapedObservation.source.trustWeight)! },
          fetchedAt: timestampToIso(dbShapedObservation.fetchedAt),
          quoteDate: timestampToIso(dbShapedObservation.quoteDate),
          rawValueLow: numericToNumber(dbShapedObservation.rawValueLow),
          rawValueHigh: numericToNumber(dbShapedObservation.rawValueHigh),
          normValueLow: numericToNumber(dbShapedObservation.normValueLow),
          normValueHigh: numericToNumber(dbShapedObservation.normValueHigh),
          validationTrail: dbShapedObservation.validationTrail.map((v) => ({ ...v, at: timestampToIso(v.at) })),
        },
      ],
    };
    expect(traceQuoteResponseSchema.parse(converted)).toBeTruthy();
  });

  it('指标契约：is_aggregate=1 经 flagToBoolean 满足 z.literal(true)，value 经 numericToNumber 满足 z.number()', () => {
    const convertedIndicator = {
      kind: 'derived_indicator' as const,
      indicator: {
        id: 'i1',
        kind: 'national_median' as const,
        categoryName: '废钢',
        regionName: '中国',
        basisDate: timestampToIso(new Date('2026-10-25T00:00:00Z')),
        value: numericToNumber('2205.00')!,
        methodJson: { weights: 'by_trust' },
        methodVersion: 'v1',
        // derived_indicator.is_aggregate 在 DB 是 integer 1 —— 契约要求恒为 true。
        isAggregate: flagToBoolean(1),
      },
      quotes: [{ quoteId: 'q1', valueAtAggregation: numericToNumber('2205.00')! }],
    };
    expect(traceIndicatorResponseSchema.parse(convertedIndicator)).toBeTruthy();
  });
});
