// Section 13: building the basis (BASIS-1, BASIS-2) and checking one before it prices (BASIS-4).

import { type CanonicalValue, canonicalize, sha256Hex } from "./canonical.ts";
import { AMOUNT_PATTERN, amountToRational, isCanonicalAmount } from "./decimal.ts";
import type { BuiltSchedule, Slot } from "./engine.ts";
import { fail } from "./errors.ts";
import { decodeUtf8, JsonSyntaxError, type JsonValue, readJson } from "./json.ts";
import type { Condition } from "./model.ts";
import { parseInstant } from "./time.ts";
import {
  type Component,
  type Currency,
  dimensionOfComponent,
  exponentOf,
  FACTORS,
  isComponent,
  isCurrency,
  isPer,
  isProviderId,
  isTier,
  isUnit,
  MAX_SAFE,
  METERS,
  type Unit,
  unitInfo,
} from "./vocab.ts";

/** What a basis names, as far as pricing from it needs. */
export interface ReadBasis {
  readonly currency: Currency;
  readonly exponent: number;
  readonly conditionInputs: readonly Component[] | null;
  readonly schedules: readonly BuiltSchedule[];
}

export interface BuildInput {
  readonly origin: { readonly version: string; readonly sha256: string };
  readonly provider: string;
  readonly modelId: string;
  readonly requested: string;
  readonly tier: string;
  readonly currency: Currency;
  readonly settlement: "estimate" | "booked";
  readonly conditionInputs: readonly Component[] | null;
  /** Each schedule's entries are in force at the instant priced, sorted by component. */
  readonly schedules: readonly {
    readonly condition: Condition | null;
    readonly entries: readonly BasisEntry[];
  }[];
}

export type BasisEntry =
  | {
      readonly component: Component;
      readonly kind: "priced";
      readonly unit: Unit;
      readonly per: number;
      readonly amount: string;
      readonly validFrom: string | null;
      readonly validUntil: string | null;
    }
  | { readonly component: Component; readonly kind: "unsupported" | "inapplicable" | "no-rate" };

function conditionValue(condition: Condition | null): CanonicalValue {
  if (condition === null) return null;
  const bounds: { [key: string]: CanonicalValue } = {};
  if (condition.gt !== null) bounds.gt = condition.gt;
  if (condition.lte !== null) bounds.lte = condition.lte;
  return { inputTokens: bounds };
}

/** BASIS-1 and BASIS-2: the canonical text of the basis, and its sha256. */
export function buildBasis(input: BuildInput): { text: string; sha256: string } {
  const document: CanonicalValue = {
    basisVersion: 1,
    origin: { kind: "catalog", version: input.origin.version, sha256: input.origin.sha256 },
    provider: input.provider,
    model: { id: input.modelId, requested: input.requested },
    tier: input.tier,
    currency: input.currency,
    rounding: {
      rule: "half-up-once-on-total",
      exponent: exponentOf(input.currency),
      settlement: input.settlement,
    },
    conditionInputs:
      input.conditionInputs === null ? {} : { inputTokens: [...input.conditionInputs].sort() },
    schedules: input.schedules.map((schedule) => ({
      condition: conditionValue(schedule.condition),
      components: schedule.entries.map((entry): CanonicalValue => {
        if (entry.kind !== "priced") return { component: entry.component, disposition: entry.kind };
        const info = unitInfo(entry.unit);
        return {
          component: entry.component,
          disposition: "priced",
          unit: entry.unit,
          per: entry.per,
          amount: entry.amount,
          meter: info.meter,
          factor: info.factor,
          validFrom: entry.validFrom,
          validUntil: entry.validUntil,
        };
      }),
    })),
  };
  const text = canonicalize(document);
  return { text, sha256: sha256Hex(new TextEncoder().encode(text)) };
}

// ---------------------------------------------------------------------------------------------
// Reading a basis (BASIS-4).
// ---------------------------------------------------------------------------------------------

type Obj = { [key: string]: JsonValue };

function invalid(detail: string): never {
  return fail("invalid-basis", detail);
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with exactly `required` and any of `optional`. */
function exact(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Obj {
  if (!isObj(value)) return invalid(`${path}: expected an object`);
  for (const name of required)
    if (!Object.hasOwn(value, name)) invalid(`${path}: missing "${name}"`);
  for (const name of Object.keys(value)) {
    if (!required.includes(name) && !optional.includes(name))
      invalid(`${path}: unknown member "${name}"`);
  }
  return value;
}

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9]{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])\.[1-9][0-9]*$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const INSTANT =
  /^(19[7-9][0-9]|[2-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;

function modelId(value: unknown, path: string): string {
  if (typeof value !== "string" || !MODEL_ID.test(value) || value.length > 200) {
    return invalid(`${path}: not a model id`);
  }
  return value;
}

function nullableInstant(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !INSTANT.test(value)) return invalid(`${path}: not an instant`);
  return value;
}

function bound(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_SAFE) {
    return invalid(`${path}: expected an integer in [0, 2^53)`);
  }
  return value;
}

function conditionOf(value: unknown, path: string): Condition {
  const outer = exact(value, path, ["inputTokens"]);
  const inner = exact(outer.inputTokens, `${path}/inputTokens`, [], ["gt", "lte"]);
  if (inner.gt === undefined && inner.lte === undefined)
    invalid(`${path}: expected gt, lte or both`);
  return {
    gt: inner.gt === undefined ? null : bound(inner.gt, `${path}/inputTokens/gt`),
    lte: inner.lte === undefined ? null : bound(inner.lte, `${path}/inputTokens/lte`),
  };
}

function entryOf(
  value: unknown,
  path: string,
): {
  component: Component;
  slot: Slot & { kind: string };
  /** Epoch milliseconds of the window's bounds, for a priced entry; `null` when open. */
  fromMs: number | null;
  untilMs: number | null;
} {
  if (!isObj(value)) return invalid(`${path}: expected an object`);
  if (value.disposition === "priced") {
    const e = exact(value, path, [
      "component",
      "disposition",
      "unit",
      "per",
      "amount",
      "meter",
      "factor",
      "validFrom",
      "validUntil",
    ]);
    if (!isComponent(e.component)) invalid(`${path}/component: not a component`);
    if (!isUnit(e.unit)) invalid(`${path}/unit: not a unit`);
    if (!isPer(e.per)) invalid(`${path}/per: not a per`);
    if (typeof e.amount !== "string" || !AMOUNT_PATTERN.test(e.amount))
      invalid(`${path}/amount: not an amount`);
    const meter = e.meter;
    if (meter !== null && !(METERS as readonly unknown[]).includes(meter))
      invalid(`${path}/meter: not a meter`);
    const factor = e.factor;
    if (factor !== null && !(FACTORS as readonly unknown[]).includes(factor))
      invalid(`${path}/factor: not a factor`);
    const validFrom = nullableInstant(e.validFrom, `${path}/validFrom`);
    const validUntil = nullableInstant(e.validUntil, `${path}/validUntil`);

    // BASIS-4 step 5: what UNIT-1 and NUM-4 give, not what the basis claims.
    const info = unitInfo(e.unit);
    if (meter !== info.meter || factor !== info.factor) {
      invalid(`${path}: meter and factor are not those of unit "${e.unit}"`);
    }
    if (info.dimension !== dimensionOfComponent(e.component)) {
      invalid(`${path}: unit "${e.unit}" is not in the dimension of "${e.component}"`);
    }
    if (!isCanonicalAmount(e.amount)) invalid(`${path}/amount: "${e.amount}" is not canonical`);
    const from = validFrom === null ? null : parseInstant(validFrom);
    const until = validUntil === null ? null : parseInstant(validUntil);
    if (from === undefined || until === undefined) invalid(`${path}: a window bound is not a date`);
    if (from !== null && until !== null && (from as number) >= (until as number)) {
      invalid(`${path}: validFrom is not before validUntil`);
    }
    return {
      component: e.component,
      slot: {
        kind: "priced",
        rate: amountToRational(e.amount),
        per: e.per,
        factor: info.factor,
      },
      fromMs: from as number | null,
      untilMs: until as number | null,
    };
  }
  const e = exact(value, path, ["component", "disposition"]);
  if (!isComponent(e.component)) invalid(`${path}/component: not a component`);
  if (
    e.disposition !== "inapplicable" &&
    e.disposition !== "unsupported" &&
    e.disposition !== "no-rate"
  ) {
    invalid(`${path}/disposition: not a disposition`);
  }
  return {
    component: e.component,
    slot: { kind: e.disposition },
    fromMs: null,
    untilMs: null,
  };
}

/** The schema (`schema/basis.schema.json`) and BASIS-4 step 5 on the parsed document. */
function checkDocument(document: Obj): ReadBasis {
  const top = exact(document, "", [
    "basisVersion",
    "origin",
    "provider",
    "model",
    "tier",
    "currency",
    "rounding",
    "conditionInputs",
    "schedules",
  ]);
  if (top.basisVersion !== 1) invalid("/basisVersion: expected 1");

  const origin = top.origin;
  if (!isObj(origin)) invalid("/origin: expected an object");
  if ((origin as Obj).kind === "catalog") {
    const o = exact(origin, "/origin", ["kind", "version", "sha256"]);
    if (typeof o.version !== "string" || !VERSION.test(o.version)) invalid("/origin/version");
    if (typeof o.sha256 !== "string" || !SHA256.test(o.sha256)) invalid("/origin/sha256");
  } else if ((origin as Obj).kind === "override") {
    const o = exact(origin, "/origin", ["kind", "revision"]);
    if (typeof o.revision !== "string" || o.revision.length === 0) invalid("/origin/revision");
  } else {
    invalid("/origin/kind: expected catalog or override");
  }

  if (!isProviderId(top.provider)) invalid("/provider");
  const model = exact(top.model, "/model", ["id", "requested"]);
  modelId(model.id, "/model/id");
  modelId(model.requested, "/model/requested");
  if (!isTier(top.tier)) invalid("/tier");
  // TIER-1: the prefix of a tier is its provider's id, which no catalog `price` reads breaks.
  if (!top.tier.startsWith(`${top.provider}:`)) invalid("/tier: not a tier of the provider");
  if (!isCurrency(top.currency)) invalid("/currency");
  const currency = top.currency as Currency;

  const rounding = exact(top.rounding, "/rounding", ["rule", "exponent", "settlement"]);
  if (rounding.rule !== "half-up-once-on-total") invalid("/rounding/rule");
  if (
    typeof rounding.exponent !== "number" ||
    !Number.isInteger(rounding.exponent) ||
    rounding.exponent < 0 ||
    rounding.exponent > 4
  ) {
    invalid("/rounding/exponent");
  }
  if (rounding.settlement !== "estimate" && rounding.settlement !== "booked")
    invalid("/rounding/settlement");
  if (rounding.exponent !== exponentOf(currency))
    invalid("/rounding/exponent: not the exponent of the currency");

  const inputs = exact(top.conditionInputs, "/conditionInputs", [], ["inputTokens"]);
  let conditionInputs: Component[] | null = null;
  if (inputs.inputTokens !== undefined) {
    const list = inputs.inputTokens;
    if (!Array.isArray(list) || list.length === 0)
      invalid("/conditionInputs/inputTokens: expected a list");
    conditionInputs = (list as JsonValue[]).map((item, i) => {
      if (!isComponent(item)) return invalid(`/conditionInputs/inputTokens/${i}: not a component`);
      return item;
    });
    if (new Set(conditionInputs).size !== conditionInputs.length)
      invalid("/conditionInputs/inputTokens: repeats");
  }

  if (!Array.isArray(top.schedules) || top.schedules.length === 0)
    invalid("/schedules: expected a list");
  const schedules: BuiltSchedule[] = [];
  const listed: string[][] = [];
  // The windows of every priced entry. `price` writes the entry in force at one instant for every
  // component of every schedule, so the windows of a basis it wrote have an instant in common.
  let latestFrom = Number.NEGATIVE_INFINITY;
  let earliestUntil = Number.POSITIVE_INFINITY;
  for (const [i, raw] of (top.schedules as JsonValue[]).entries()) {
    const p = `/schedules/${i}`;
    const s = exact(raw, p, ["condition", "components"]);
    const condition = s.condition === null ? null : conditionOf(s.condition, `${p}/condition`);
    if (!Array.isArray(s.components) || s.components.length === 0)
      invalid(`${p}/components: expected a list`);
    const slots = new Map<Component, Slot>();
    let previous: string | undefined;
    for (const [j, rawEntry] of (s.components as JsonValue[]).entries()) {
      const entry = entryOf(rawEntry, `${p}/components/${j}`);
      // Strictly ascending code-point order, so none repeats.
      if (previous !== undefined && !(previous < entry.component)) {
        invalid(`${p}/components: not in strictly ascending order`);
      }
      previous = entry.component;
      slots.set(entry.component, entry.slot);
      if (entry.fromMs !== null) latestFrom = Math.max(latestFrom, entry.fromMs);
      if (entry.untilMs !== null) earliestUntil = Math.min(earliestUntil, entry.untilMs);
    }
    listed.push([...slots.keys()]);
    schedules.push({ condition, slots });
  }

  if (latestFrom >= earliestUntil) {
    invalid("/schedules: no instant is in the window of every priced entry");
  }

  const reference = (listed[0] as string[]).join(",");
  if (listed.some((names) => names.join(",") !== reference))
    invalid("/schedules: the schedules list different components");

  if (schedules.length === 1) {
    if ((schedules[0] as BuiltSchedule).condition !== null || conditionInputs !== null) {
      invalid("/schedules: a single schedule has no condition and no conditionInputs");
    }
  } else {
    if (conditionInputs === null)
      invalid("/conditionInputs: schedules with conditions need inputTokens");
    let expectedLower: number | null = null;
    for (const [i, schedule] of schedules.entries()) {
      const c = schedule.condition;
      if (c === null) return invalid(`/schedules/${i}/condition: expected a condition`);
      if (c.gt !== null && c.lte !== null && c.gt >= c.lte)
        invalid(`/schedules/${i}/condition: gt is not below lte`);
      if (c.gt !== expectedLower)
        invalid(`/schedules/${i}/condition: the conditions do not partition [0, 2^53)`);
      expectedLower = c.lte;
      if (c.lte === null && i !== schedules.length - 1)
        invalid(`/schedules/${i}/condition: an open upper bound before the last`);
    }
    if (expectedLower !== null) invalid("/schedules: the last condition has an upper bound");
    const sorted = [...(conditionInputs as Component[])].sort();
    if (sorted.join(",") !== (conditionInputs as Component[]).join(","))
      invalid("/conditionInputs/inputTokens: not sorted");
    for (const component of conditionInputs as Component[]) {
      if (dimensionOfComponent(component) !== "tokens" || !listed[0]?.includes(component)) {
        invalid(`/conditionInputs/inputTokens: "${component}" is not a listed token component`);
      }
    }
  }

  return { currency, exponent: rounding.exponent as number, conditionInputs, schedules };
}

/**
 * BASIS-4: the checks before a basis prices. `bytes` are the basis exactly as stored.
 * Refuses with `basis-hash-mismatch`, `unsupported-basis-version` or `invalid-basis`.
 */
export function readBasis(bytes: Uint8Array, expectedSha256: string): ReadBasis {
  // 1. The digest of the bytes.
  if (typeof expectedSha256 !== "string" || sha256Hex(bytes) !== expectedSha256.toLowerCase()) {
    fail("basis-hash-mismatch", "the sha256 of the basis bytes is not the one given");
  }

  // 2. Parse, and check basisVersion.
  let reading: ReturnType<typeof readJson>;
  try {
    reading = readJson(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof JsonSyntaxError || error instanceof TypeError) {
      return invalid(`the basis is not JSON: ${error.message}`);
    }
    throw error;
  }
  const document = reading.value;
  if (!isObj(document)) return invalid("the basis is not an object");
  if (!Object.hasOwn(document, "basisVersion")) return invalid("/basisVersion is missing");
  if (document.basisVersion !== 1) {
    fail("unsupported-basis-version", "this client reads basisVersion 1 only");
  }

  // 3. The schema, with the checks that no schema expresses (step 5).
  const read = checkDocument(document);

  // 4. Canonical form: a duplicate member or a non-integer literal is not in it either.
  if (reading.defect !== undefined)
    invalid(`not canonical: ${reading.defect.kind} at ${reading.defect.at}`);
  const again = new TextEncoder().encode(canonicalize(document as CanonicalValue));
  if (again.length !== bytes.length || again.some((byte, i) => byte !== bytes[i])) {
    invalid("the basis is not in canonical form");
  }
  return read;
}
