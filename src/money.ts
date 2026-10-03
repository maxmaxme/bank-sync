/**
 * Parse a decimal amount string ("12.34", "-0.5", "1000") into integer cents.
 * Extra fraction digits are rounded half-up; money never goes through floats.
 */
export function parseAmountToCents(amount: string): number {
  const m = /^\s*([+-]?)(\d+)(?:[.,](\d+))?\s*$/.exec(amount);
  if (!m) {
    throw new Error(`Unparseable amount: ${JSON.stringify(amount)}`);
  }
  const sign = m[1];
  const int = m[2] ?? '0';
  const frac = m[3] ?? '';
  let cents = Number(int) * 100 + Number(`${frac}00`.slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) {
    cents += 1;
  }
  return sign === '-' ? -cents : cents;
}

/**
 * Signed cents for a PSD2 transaction: money out is negative. Banks report the
 * amount unsigned and carry the direction in `credit_debit_indicator`; when
 * that is missing we trust whatever sign the amount itself has.
 */
export function signedCents(amount: string, indicator: string | undefined): number {
  const cents = parseAmountToCents(amount);
  if (indicator === 'DBIT') {
    return -Math.abs(cents);
  }
  if (indicator === 'CRDT') {
    return Math.abs(cents);
  }
  return cents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
