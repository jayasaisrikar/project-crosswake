/**
 * Exact USDC amounts. Every settlement figure in this subsystem is an integer
 * number of minor units (1 USDC = 1_000_000). Floating point never touches a
 * monetary value: it is parsed to bigint at the boundary, stored as a decimal
 * string in JSON, and compared with bigint arithmetic.
 */
export const USDC_DECIMALS = 6;
export const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);
export type UsdcAmount = bigint;

const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

export function isValidUsdcText(value: string): boolean {
  return AMOUNT_PATTERN.test(value);
}

export function parseUsdc(value: string): UsdcAmount {
  if (!AMOUNT_PATTERN.test(value))
    throw new Error(`Not a valid non-negative USDC amount: ${value}`);
  const [whole, fraction = ''] = value.split('.') as [string, string?];
  return (
    BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(USDC_DECIMALS, '0'))
  );
}

export function formatUsdc(amount: UsdcAmount): string {
  if (amount < 0n) throw new Error('USDC amounts are non-negative');
  const whole = amount / USDC_SCALE,
    fraction = (amount % USDC_SCALE).toString().padStart(USDC_DECIMALS, '0');
  return fraction === '0'.repeat(USDC_DECIMALS)
    ? whole.toString()
    : `${whole}.${fraction.replace(/0+$/, '')}`;
}

export function addUsdc(...amounts: UsdcAmount[]): UsdcAmount {
  return amounts.reduce((sum, a) => sum + a, 0n);
}

export function compareUsdc(a: UsdcAmount, b: UsdcAmount): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function atMostUsdc(value: UsdcAmount, limit: UsdcAmount): boolean {
  return value <= limit;
}
