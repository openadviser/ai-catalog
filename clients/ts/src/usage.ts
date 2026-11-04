// Usage reports (Section 7).

import { fail } from "./errors.ts";
import { decodeUtf8, JsonSyntaxError, readJson } from "./json.ts";
import { type Component, isComponent, TWO_53 } from "./vocab.ts";

export type Completeness = "complete" | "totals-only" | "partial" | "unknown";

/** A usage report (USAGE-4). A quantity is an integer below 2^53, as a `number` or a `bigint`. */
export interface UsageReport {
  completeness: Completeness;
  quantities: { [component in Component]?: number | bigint };
}

/** A checked usage report. */
export interface ReadUsage {
  readonly completeness: Completeness;
  readonly quantities: ReadonlyMap<Component, bigint>;
}

const COMPLETENESS: readonly string[] = ["complete", "totals-only", "partial", "unknown"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PRICE-2 step 3: the shape (USAGE-4), then the bound (NUM-3). A shape fault anywhere in the report
 * is reported before an out-of-range quantity.
 */
export function readUsage(value: unknown): ReadUsage {
  if (!isRecord(value)) return fail("invalid-usage", "a usage report is an object");
  for (const name of Object.keys(value)) {
    if (name !== "completeness" && name !== "quantities") {
      fail("invalid-usage", `unknown member "${name}"`);
    }
  }
  const completeness = value.completeness;
  if (typeof completeness !== "string" || !COMPLETENESS.includes(completeness)) {
    fail("invalid-usage", "completeness is not complete, totals-only, partial or unknown");
  }
  const raw = value.quantities;
  if (!isRecord(raw)) return fail("invalid-usage", "quantities is an object");

  const quantities = new Map<Component, bigint>();
  let outOfRange: string | undefined;
  for (const key of Object.keys(raw)) {
    if (!isComponent(key)) fail("invalid-usage", `"${key}" is not a component`);
    const q = raw[key];
    let big: bigint;
    if (typeof q === "bigint") {
      big = q;
    } else if (typeof q === "number" && Number.isInteger(q) && !Object.is(q, -0)) {
      // An integer-valued finite number, except negative zero (NUM-3, JSON-2).
      big = BigInt(q);
    } else {
      return fail("invalid-usage", `${key}: expected a nonnegative integer`);
    }
    if (big < 0n) fail("invalid-usage", `${key}: expected a nonnegative integer`);
    if (big >= TWO_53) outOfRange ??= key;
    quantities.set(key, big);
  }
  if (outOfRange !== undefined) {
    fail("quantity-out-of-range", `${outOfRange}: a quantity must be below 2^53`);
  }
  return { completeness: completeness as Completeness, quantities };
}

/**
 * Reads a usage report from JSON text, holding it to JSON-1 and JSON-2: a duplicate member or a
 * quantity written with a fraction or an exponent (`1e-999`) is refused with `invalid-json`.
 * A quantity of 2^53 or more is kept exactly, as a `bigint`, so that `price` refuses it with
 * `quantity-out-of-range`.
 */
export function parseUsage(source: string | Uint8Array): UsageReport {
  let reading: ReturnType<typeof readJson>;
  try {
    reading = readJson(typeof source === "string" ? source : decodeUtf8(source));
  } catch (error) {
    if (error instanceof JsonSyntaxError || error instanceof TypeError) {
      return fail("invalid-json", `the usage report is not JSON: ${error.message}`);
    }
    throw error;
  }
  if (reading.defect !== undefined) {
    return fail("invalid-json", `usage report: ${reading.defect.kind} at ${reading.defect.at}`);
  }
  return reading.value as unknown as UsageReport;
}
