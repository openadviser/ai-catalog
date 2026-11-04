// PRICE-2 steps 5 to 9, on schedules already built (step 4). `price` builds them from a catalog at an
// instant and `priceFromBasis` reads them from a basis, so both judge a report the same way.

import { add, compare, type Rational, rational } from "./decimal.ts";
import { fail } from "./errors.ts";
import type { Condition } from "./model.ts";
import type { ReadUsage } from "./usage.ts";
import { type Component, isPerCall } from "./vocab.ts";

export type Slot =
  | {
      readonly kind: "priced";
      readonly rate: Rational;
      readonly per: number;
      /** `null` for a compound unit. */
      readonly factor: number | null;
    }
  | { readonly kind: "unsupported" | "inapplicable" | "no-rate" };

export interface BuiltSchedule {
  readonly condition: Condition | null;
  /** Every component the offering lists, sorted by code point. */
  readonly slots: ReadonlyMap<Component, Slot>;
}

export interface Chosen {
  readonly schedule: number;
  readonly total: Rational;
}

function holds(condition: Condition, input: bigint): boolean {
  return (
    (condition.gt === null || input > BigInt(condition.gt)) &&
    (condition.lte === null || input <= BigInt(condition.lte))
  );
}

/** USAGE-2: the components a complete report must contain. */
function required(
  schedules: readonly BuiltSchedule[],
  conditionInputs: readonly Component[] | null,
): Component[] {
  const set = new Set<Component>(conditionInputs ?? []);
  for (const schedule of schedules) {
    for (const [component, slot] of schedule.slots) {
      if (isPerCall(component) && slot.kind !== "inapplicable") set.add(component);
    }
  }
  return [...set].sort();
}

function priceSchedule(
  schedule: BuiltSchedule,
  positive: readonly Component[],
  usage: ReadUsage,
): Rational {
  let total = rational(0n, 1n);
  for (const component of positive) {
    const slot = schedule.slots.get(component);
    if (slot === undefined) return fail("component-not-offered", component);
    switch (slot.kind) {
      case "unsupported":
        return fail("unsupported-component", `${component} is unsupported`);
      case "inapplicable":
        return fail("inapplicable-component-used", `${component} is inapplicable`);
      case "no-rate":
        return fail("no-rate-in-force", `${component} has no rate in force`);
      case "priced": {
        if (slot.factor === null)
          return fail("unsupported-unit", `${component} is priced in a compound unit`);
        const quantity = usage.quantities.get(component) as bigint;
        // q * a / (p * f), exactly (UNIT-2).
        total = add(
          total,
          rational(quantity * slot.rate.n, slot.rate.d * BigInt(slot.per) * BigInt(slot.factor)),
        );
      }
    }
  }
  return total;
}

/**
 * Steps 5 to 9. `conditionInputs` is `null` for an offering without conditions. `unknownInput` is
 * COND-7's `conditionInputs: { inputTokens: "unknown" }`.
 */
export function choose(
  schedules: readonly BuiltSchedule[],
  conditionInputs: readonly Component[] | null,
  usage: ReadUsage,
  unknownInput: boolean,
): Chosen {
  // Step 5: completeness (USAGE-1, USAGE-2).
  const missing = required(schedules, conditionInputs).filter((c) => !usage.quantities.has(c));
  if (usage.completeness !== "complete") {
    fail("usage-incomplete", `the report is ${usage.completeness}, not complete`, missing);
  }
  if (missing.length > 0) {
    fail("usage-incomplete", `the report omits ${missing.join(", ")}`, missing);
  }

  // Step 6: a positive quantity for a component the offering does not list.
  const positive = [...usage.quantities]
    .filter(([, q]) => q > 0n)
    .map(([c]) => c)
    .sort();
  const first = schedules[0] as BuiltSchedule;
  for (const component of positive) {
    if (!first.slots.has(component)) {
      fail("component-not-offered", `${component} is not listed by the offering`);
    }
  }

  // Step 7: the candidate schedules.
  let candidates: number[];
  if (conditionInputs === null) {
    candidates = [0];
  } else if (unknownInput) {
    candidates = schedules.map((_, i) => i);
  } else {
    let input = 0n;
    for (const component of conditionInputs) input += usage.quantities.get(component) as bigint;
    const index = schedules.findIndex((s) => s.condition !== null && holds(s.condition, input));
    if (index < 0) throw new Error("internal error: the schedules do not partition the input");
    candidates = [index];
  }

  // Step 8, then step 9: the greatest exact total, the lowest interval on a tie.
  let best: Chosen | undefined;
  for (const index of candidates) {
    const total = priceSchedule(schedules[index] as BuiltSchedule, positive, usage);
    if (best === undefined || compare(total, best.total) > 0) best = { schedule: index, total };
  }
  return best as Chosen;
}
