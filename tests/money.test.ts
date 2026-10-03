import { describe, expect, it } from 'vitest';
import { formatCents, parseAmountToCents, signedCents } from '../src/money.ts';

describe('parseAmountToCents', () => {
  it.each([
    ['12.34', 1234],
    ['12.3', 1230],
    ['12', 1200],
    ['0.05', 5],
    ['-7.50', -750],
    ['+3.00', 300],
    ['1,25', 125],
    ['1.005', 101],
    ['1.004', 100],
    [' 42.00 ', 4200],
  ])('%s → %i', (input, expected) => {
    expect(parseAmountToCents(input)).toBe(expected);
  });

  it('rejects garbage', () => {
    expect(() => parseAmountToCents('12.3.4')).toThrow(/Unparseable/);
    expect(() => parseAmountToCents('')).toThrow(/Unparseable/);
  });
});

describe('signedCents', () => {
  it('makes debits negative and credits positive regardless of the raw sign', () => {
    expect(signedCents('10.00', 'DBIT')).toBe(-1000);
    expect(signedCents('-10.00', 'DBIT')).toBe(-1000);
    expect(signedCents('10.00', 'CRDT')).toBe(1000);
    expect(signedCents('-10.00', 'CRDT')).toBe(1000);
  });

  it('falls back to the amount sign without an indicator', () => {
    expect(signedCents('-10.00', undefined)).toBe(-1000);
  });
});

describe('formatCents', () => {
  it.each([
    [1234, '12.34'],
    [-5, '-0.05'],
    [0, '0.00'],
    [-100000, '-1000.00'],
  ])('%i → %s', (cents, expected) => {
    expect(formatCents(cents)).toBe(expected);
  });
});
