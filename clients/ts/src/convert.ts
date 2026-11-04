// UNIT-4: converting a rate into a consumer's unit and per. Exact, never rounded.

import { AMOUNT_PATTERN, amountToRational, canonicalAmount, pow10 } from "./decimal.ts";
import { fail } from "./errors.ts";
import { isPer, isUnit, unitInfo } from "./vocab.ts";

export interface RateToConvert {
  unit: string;
  per: number;
  /** An amount string (NUM-1). */
  amount: string;
}

export interface ConversionTarget {
  unit: string;
  per: number;
  /** The fractional digits the consumer can hold: an integer from 0 to 12. */
  scale: number;
}

/**
 * Converts `rate` into the unit and per of `to` so that a quantity costs the same under both.
 * Refuses with `invalid-per`, `dimension-mismatch`, `unsupported-unit` or `inexact-conversion`.
 * The amount is returned in canonical form (NUM-4).
 */
export function convertRate(rate: RateToConvert, to: ConversionTarget): { amount: string } {
  if (!isUnit(rate.unit)) fail("unknown-unit", `rate.unit: "${String(rate.unit)}" is not a unit`);
  if (!isUnit(to.unit)) fail("unknown-unit", `to.unit: "${String(to.unit)}" is not a unit`);
  if (typeof rate.amount !== "string" || !AMOUNT_PATTERN.test(rate.amount)) {
    fail("invalid-amount", "rate.amount is not an amount string");
  }
  if (!Number.isInteger(to.scale) || to.scale < 0 || to.scale > 12) {
    throw new RangeError("to.scale is an integer from 0 to 12");
  }
  // 1. NUM-2 for the target per (and for the source's, which a catalog rate always satisfies).
  if (!isPer(rate.per)) fail("invalid-per", "rate.per is not a power of ten from 1 to 10^9");
  if (!isPer(to.per)) fail("invalid-per", "to.per is not a power of ten from 1 to 10^9");

  // 2. The same dimension.
  const from = unitInfo(rate.unit);
  const target = unitInfo(to.unit);
  if (from.dimension !== target.dimension) {
    fail("dimension-mismatch", `${rate.unit} and ${to.unit} are not in the same dimension`);
  }
  // 3. A compound unit cannot be converted.
  if (from.factor === null || target.factor === null) {
    fail("unsupported-unit", "a compound unit cannot be converted");
  }

  // 4. a2 = a * p2 * f(u2) / (p1 * f(u1)), exactly.
  const a = amountToRational(rate.amount);
  const numerator = a.n * BigInt(to.per) * BigInt(target.factor);
  const denominator = a.d * BigInt(rate.per) * BigInt(from.factor);

  // 5. Exact at the target scale, or refused.
  const scaled = numerator * pow10(to.scale);
  if (scaled % denominator !== 0n) {
    fail(
      "inexact-conversion",
      `${rate.amount} per ${rate.per} ${rate.unit} is not exact at scale ${to.scale}`,
    );
  }
  const units = scaled / denominator;

  // 6. Canonical form.
  const digits = units.toString().padStart(to.scale + 1, "0");
  const whole = digits.slice(0, digits.length - to.scale);
  const fraction = digits.slice(digits.length - to.scale);
  return { amount: canonicalAmount(to.scale === 0 ? whole : `${whole}.${fraction}`) };
}
