// Amount arithmetic on decimal strings. Catalog amounts are decimal strings; a
// derivation multiplies them exactly (a stated multiplier times a stated base), never
// through floating point.
import { NeedsReview } from "./evidence.ts";

function parts(amount: string): { num: bigint; scale: number } {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(amount);
  if (m === null)
    throw new NeedsReview("bad-amount", `${JSON.stringify(amount)}: not a decimal amount`);
  const frac = m[2] ?? "";
  return { num: BigInt(`${m[1]}${frac}`), scale: frac.length };
}

/** The exact product of two decimal strings, at the product's natural scale. */
export function mulDecimal(a: string, b: string): string {
  const x = parts(a);
  const y = parts(b);
  const num = x.num * y.num;
  const scale = x.scale + y.scale;
  return formatDecimal(num, scale);
}

function formatDecimal(num: bigint, scale: number): string {
  const digits = num.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

/** Decimal equality ignoring trailing zeros: "12.50" is "12.5". */
export function eqDecimal(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  if (x.scale === y.scale) return x.num === y.num;
  const [lo, hi] = x.scale < y.scale ? [x, y] : [y, x];
  return lo.num * 10n ** BigInt(hi.scale - lo.scale) === hi.num;
}

/**
 * The exact product `factor × base`, formatted to `scale` decimals. Throws NeedsReview
 * when the product does not fit that scale exactly — a derived amount is never rounded
 * into a wrong price.
 */
export function mulDecimalToScale(factor: string, base: string, scale: number): string {
  const product = parts(mulDecimal(factor, base));
  const diff = scale - product.scale;
  if (diff < 0) {
    const divisor = 10n ** BigInt(-diff);
    if (product.num % divisor !== 0n) {
      throw new NeedsReview(
        "bad-amount",
        `the derived amount ${mulDecimal(factor, base)} does not fit ${scale} decimals exactly`,
      );
    }
    return formatDecimal(product.num / divisor, scale);
  }
  return formatDecimal(product.num * 10n ** BigInt(diff), scale);
}
