// Exact arithmetic on bigint (NUM-4, NUM-5). Nothing here touches binary floating point.

/** A nonnegative rational in lowest terms: `d >= 1`, and zero is 0/1. */
export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

export const AMOUNT_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/;

export function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

export function rational(n: bigint, d: bigint): Rational {
  if (n === 0n) return { n: 0n, d: 1n };
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

/** -1, 0 or 1. */
export function compare(a: Rational, b: Rational): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** The value of an amount string (NUM-1) as an exact rational. The caller has checked the grammar. */
export function amountToRational(amount: string): Rational {
  const point = amount.indexOf(".");
  if (point < 0) return rational(BigInt(amount), 1n);
  const fraction = amount.slice(point + 1);
  return rational(BigInt(amount.slice(0, point) + fraction), pow10(fraction.length));
}

/** NUM-4: remove trailing zeros of the fraction, and the point when no fraction remains. */
export function canonicalAmount(amount: string): string {
  const point = amount.indexOf(".");
  if (point < 0) return amount;
  const fraction = amount.slice(point + 1).replace(/0+$/, "");
  return fraction === "" ? amount.slice(0, point) : `${amount.slice(0, point)}.${fraction}`;
}

export function isCanonicalAmount(amount: string): boolean {
  return AMOUNT_PATTERN.test(amount) && canonicalAmount(amount) === amount;
}

/** `N/D`, the exact total of NUM-5. */
export function formatExact(value: Rational): string {
  return `${value.n}/${value.d}`;
}

/** A whole number of minor units written with exactly `exponent` fractional digits (ROUND-2). */
export function formatMinor(minor: bigint, exponent: number): string {
  if (exponent === 0) return minor.toString();
  const scale = pow10(exponent);
  const fraction = (minor % scale).toString().padStart(exponent, "0");
  return `${minor / scale}.${fraction}`;
}

/** ROUND-2: floor((2 * N * 10^e + D) / (2 * D)), half-up on a nonnegative value, in integers. */
export function estimateMinor(total: Rational, exponent: number): bigint {
  return (2n * total.n * pow10(exponent) + total.d) / (2n * total.d);
}

export interface Figures {
  estimate: string;
  booked: string;
}

/** ROUND-2 and ROUND-3. */
export function figures(total: Rational, exponent: number): Figures {
  const estimate = estimateMinor(total, exponent);
  const booked = total.n > 0n && estimate === 0n ? 1n : estimate;
  return { estimate: formatMinor(estimate, exponent), booked: formatMinor(booked, exponent) };
}
