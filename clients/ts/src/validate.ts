// Catalog validation: the structure of schema/catalog.schema.json with the codes of the rules that
// name them (VAL-4), then the semantic checks of Section 14 and the rules it points to. A candidate
// is rejected as a whole (VAL-1): nothing here returns a partial catalog.

import { AMOUNT_PATTERN, amountToRational, canonicalAmount } from "./decimal.ts";
import { fail } from "./errors.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type {
  Alias,
  CatalogData,
  Condition,
  Effort,
  Model,
  Offering,
  Provider,
  RateEntry,
  Schedule,
} from "./model.ts";
import { isCalendarDate, parseDate, parseInstant } from "./time.ts";
import {
  CAPABILITIES,
  type Component,
  dimensionOfComponent,
  EFFORT_LEVELS,
  type EffortLevel,
  isComponent,
  isCurrency,
  isPer,
  isProviderId,
  isTier,
  isUnit,
  MAX_SAFE,
  type Tier,
  type Unit,
  unitInfo,
} from "./vocab.ts";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^([0-9]{4})\.([0-9]{2})\.([0-9]{2})\.[1-9][0-9]*$/;
const SCHEMA_VERSION = /^1\.0\.(0|[1-9][0-9]*)$/;
const SOURCE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const READER = /^(manual|[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+)$/;
const HTTPS = /^https:\/\//;
const DATE_RULES = ["undated", "date-only-utc", "date-only-zoned", "stated-instant"];

// ---------------------------------------------------------------------------------------------
// Readers for the structure. Every violation without a more specific rule is `invalid-structure`.
// ---------------------------------------------------------------------------------------------

function structure(path: string, message: string): never {
  return fail("invalid-structure", `${path || "/"}: ${message}`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with exactly the required members and any of the optional ones. */
function object(
  value: JsonValue | undefined,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject {
  if (!isObject(value)) return structure(path, "expected an object");
  for (const name of required) {
    if (!Object.hasOwn(value, name)) structure(path, `missing member "${name}"`);
  }
  for (const name of Object.keys(value)) {
    if (!required.includes(name) && !optional.includes(name)) {
      structure(path, `unknown member "${name}"`);
    }
  }
  return value;
}

function array(value: JsonValue | undefined, path: string, minItems = 0): JsonValue[] {
  if (!Array.isArray(value)) return structure(path, "expected an array");
  if (value.length < minItems) structure(path, `expected at least ${minItems} item(s)`);
  return value;
}

function text(value: JsonValue | undefined, path: string): string {
  if (typeof value !== "string") return structure(path, "expected a string");
  return value;
}

function nonEmpty(value: JsonValue | undefined, path: string): string {
  const s = text(value, path);
  if (s.length === 0) structure(path, "expected a non-empty string");
  return s;
}

function matching(value: JsonValue | undefined, path: string, pattern: RegExp): string {
  const s = text(value, path);
  if (!pattern.test(s)) structure(path, "does not match its pattern");
  return s;
}

function codePoints(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

function excerpt(value: JsonValue | undefined, path: string): string {
  const s = nonEmpty(value, path);
  if (codePoints(s) > 600) structure(path, "longer than 600 characters");
  return s;
}

function offset(value: JsonValue | undefined, path: string): number {
  if (typeof value === "bigint" && value >= 0n) return Number.MAX_SAFE_INTEGER;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return structure(path, "expected a nonnegative integer");
  }
  return value;
}

/** TIME-1: an instant in whole seconds. A string that is not one is `invalid-instant`. */
function instant(value: JsonValue | undefined, path: string): { text: string; ms: number } {
  const s = text(value, path);
  const ms = parseInstant(s);
  if (ms === undefined) fail("invalid-instant", `${path}: "${s}" is not an RFC 3339 UTC instant`);
  return { text: s, ms };
}

function date(value: JsonValue | undefined, path: string): string {
  const s = text(value, path);
  if (parseDate(s) === undefined) fail("invalid-instant", `${path}: "${s}" is not a date`);
  return s;
}

function sha256(value: JsonValue | undefined, path: string): string {
  return matching(value, path, SHA256);
}

function location(value: JsonValue | undefined, path: string): void {
  const o = object(value, path, ["path", "offset", "excerpt"], ["anchors"]);
  nonEmpty(o.path, `${path}/path`);
  offset(o.offset, `${path}/offset`);
  excerpt(o.excerpt, `${path}/excerpt`);
  if (o.anchors !== undefined) {
    array(o.anchors, `${path}/anchors`, 1).forEach((anchor, i) => {
      const a = object(anchor, `${path}/anchors/${i}`, ["offset", "excerpt"]);
      offset(a.offset, `${path}/anchors/${i}/offset`);
      excerpt(a.excerpt, `${path}/anchors/${i}/excerpt`);
    });
  }
}

function derivation(value: JsonValue | undefined, path: string): void {
  const o = object(value, path, ["formula", "inputs"]);
  nonEmpty(o.formula, `${path}/formula`);
  array(o.inputs, `${path}/inputs`, 2).forEach((input, i) => {
    const p = `${path}/inputs/${i}`;
    const x = object(input, p, ["evidence", "url", "path", "offset", "excerpt"]);
    sha256(x.evidence, `${p}/evidence`);
    matching(x.url, `${p}/url`, HTTPS);
    nonEmpty(x.path, `${p}/path`);
    offset(x.offset, `${p}/offset`);
    excerpt(x.excerpt, `${p}/excerpt`);
  });
}

function provenance(value: JsonValue | undefined, path: string, requireDateRule = false): void {
  const o = object(
    value,
    path,
    ["source", "url", "readAt", "reader", "evidence"],
    ["location", "derivation", "dateRule", "note"],
  );
  matching(o.source, `${path}/source`, SOURCE);
  matching(o.url, `${path}/url`, HTTPS);
  instant(o.readAt, `${path}/readAt`);
  matching(o.reader, `${path}/reader`, READER);
  sha256(o.evidence, `${path}/evidence`);
  const hasLocation = o.location !== undefined;
  const hasDerivation = o.derivation !== undefined;
  if (hasLocation === hasDerivation) {
    structure(path, 'expected exactly one of "location" and "derivation"');
  }
  if (hasLocation) location(o.location, `${path}/location`);
  if (hasDerivation) derivation(o.derivation, `${path}/derivation`);
  if (o.dateRule !== undefined) {
    if (typeof o.dateRule !== "string" || !DATE_RULES.includes(o.dateRule)) {
      structure(`${path}/dateRule`, "not a date rule");
    }
  } else if (requireDateRule) {
    structure(path, 'missing member "dateRule"');
  }
  if (o.note !== undefined) nonEmpty(o.note, `${path}/note`);
}

/** COND-1. Any other form is `invalid-structure`. */
function condition(value: JsonValue | undefined, path: string): Condition {
  const outer = object(value, path, ["inputTokens"]);
  const inner = object(outer.inputTokens, `${path}/inputTokens`, [], ["gt", "lte"]);
  if (inner.gt === undefined && inner.lte === undefined) {
    structure(`${path}/inputTokens`, 'expected "gt", "lte" or both');
  }
  const bound = (member: "gt" | "lte"): number | null => {
    const v = inner[member];
    if (v === undefined) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_SAFE) {
      return structure(`${path}/inputTokens/${member}`, "expected an integer in [0, 2^53)");
    }
    return v;
  };
  const gt = bound("gt");
  const lte = bound("lte");
  if (gt !== null && lte !== null && gt >= lte) {
    structure(`${path}/inputTokens`, '"gt" must be below "lte"');
  }
  return { gt, lte };
}

// ---------------------------------------------------------------------------------------------
// Rates, offerings, models, providers.
// ---------------------------------------------------------------------------------------------

interface RawRate {
  readonly entry: RateEntry;
  readonly condition: Condition | null;
  /** The currency of a priced entry. */
  readonly currency: string | null;
}

function rate(value: JsonValue | undefined, path: string): RawRate {
  const o = object(
    value,
    path,
    ["component", "disposition", "provenance"],
    ["unit", "per", "amount", "currency", "condition", "validFrom", "validUntil", "reason"],
  );
  const c = o.component;
  if (!isComponent(c)) {
    if (typeof c !== "string") structure(`${path}/component`, "expected a string");
    fail("unknown-component", `${path}/component: "${String(c)}" is not a component`);
  }
  const component: Component = c as Component;
  const disposition = o.disposition;
  if (disposition !== "priced" && disposition !== "inapplicable" && disposition !== "unsupported") {
    return structure(`${path}/disposition`, "expected priced, inapplicable or unsupported");
  }

  let priced: RateEntry["priced"];
  let currency: string | null = null;
  if (disposition === "priced") {
    for (const name of ["unit", "per", "amount", "currency"] as const) {
      if (o[name] === undefined) structure(path, `a priced entry needs "${name}"`);
    }
    if (o.reason !== undefined) structure(path, 'a priced entry has no "reason"');
    const unit = o.unit;
    if (!isUnit(unit)) {
      if (typeof unit !== "string") structure(`${path}/unit`, "expected a string");
      fail("unknown-unit", `${path}/unit: "${String(unit)}" is not a unit`);
    }
    if (!isPer(o.per)) fail("invalid-per", `${path}/per: not a power of ten from 1 to 10^9`);
    if (typeof o.amount !== "string" || !AMOUNT_PATTERN.test(o.amount)) {
      fail("invalid-amount", `${path}/amount: not an amount string`);
    }
    if (!isCurrency(o.currency)) {
      if (typeof o.currency !== "string") structure(`${path}/currency`, "expected a string");
      fail("unknown-currency", `${path}/currency: "${String(o.currency)}" is not a currency`);
    }
    currency = o.currency as string;
    priced = {
      unit: unit as Unit,
      per: o.per,
      amount: canonicalAmount(o.amount),
      rate: amountToRational(o.amount),
    };
  } else {
    nonEmpty(o.reason, `${path}/reason`);
    for (const name of ["unit", "per", "amount", "currency"] as const) {
      if (o[name] !== undefined) structure(path, `a ${disposition} entry has no "${name}"`);
    }
  }

  const from = o.validFrom === undefined ? null : instant(o.validFrom, `${path}/validFrom`);
  const until = o.validUntil === undefined ? null : instant(o.validUntil, `${path}/validUntil`);
  const cond = o.condition === undefined ? null : condition(o.condition, `${path}/condition`);
  provenance(o.provenance, `${path}/provenance`, true);

  if (priced !== undefined) {
    // UNIT-1: a unit outside its component's dimension. `storage` has no unit in 1.0.0.
    if (unitInfo(priced.unit).dimension !== dimensionOfComponent(component)) {
      fail(
        "unit-mismatch",
        `${path}: unit "${priced.unit}" is not in the dimension of "${component}"`,
      );
    }
  }

  const entry: RateEntry = {
    component,
    disposition,
    validFrom: from?.text ?? null,
    validUntil: until?.text ?? null,
    fromMs: from?.ms ?? null,
    untilMs: until?.ms ?? null,
    priced,
  };
  return { entry, condition: cond, currency };
}

interface RawOffering {
  readonly tier: Tier;
  readonly path: string;
  readonly rates: readonly RawRate[];
  readonly conditionInputs: readonly Component[] | null;
}

function offering(value: JsonValue | undefined, path: string): RawOffering {
  const o = object(value, path, ["tier", "rates"], ["conditionInputs"]);
  const t = o.tier;
  if (!isTier(t)) {
    if (typeof t !== "string") structure(`${path}/tier`, "expected a string");
    fail("unknown-tier", `${path}/tier: "${String(t)}" is not a tier`);
  }
  let conditionInputs: Component[] | null = null;
  if (o.conditionInputs !== undefined) {
    const ci = object(o.conditionInputs, `${path}/conditionInputs`, ["inputTokens"]);
    const list = array(ci.inputTokens, `${path}/conditionInputs/inputTokens`, 1);
    conditionInputs = list.map((item, i) => {
      if (!isComponent(item)) {
        if (typeof item !== "string")
          structure(`${path}/conditionInputs/inputTokens/${i}`, "expected a string");
        fail("unknown-component", `${path}/conditionInputs/inputTokens/${i}: "${String(item)}"`);
      }
      return item;
    });
    if (new Set(conditionInputs).size !== conditionInputs.length) {
      structure(`${path}/conditionInputs/inputTokens`, "components must be distinct");
    }
  }
  const rawRates = array(o.rates, `${path}/rates`, 1);
  const rates = rawRates.map((r, i) => rate(r, `${path}/rates/${i}`));
  return { tier: t, path, rates, conditionInputs };
}

function effort(value: JsonValue | undefined, path: string): Effort {
  const o = object(value, path, ["levels", "default", "provenance"]);
  const list = array(o.levels, `${path}/levels`);
  const levels: EffortLevel[] = [];
  let previous = -1;
  for (const [i, level] of list.entries()) {
    if (typeof level !== "string") structure(`${path}/levels/${i}`, "expected a string");
    const rank = (EFFORT_LEVELS as readonly string[]).indexOf(level as string);
    if (rank < 0) fail("invalid-effort", `${path}/levels/${i}: "${String(level)}" is not a level`);
    if (rank <= previous) {
      fail("invalid-effort", `${path}/levels: levels must be distinct and in ascending order`);
    }
    previous = rank;
    levels.push(level as EffortLevel);
  }
  if (levels.length === 0) fail("invalid-effort", `${path}/levels: expected at least one level`);
  let def: EffortLevel | null = null;
  if (o.default !== null) {
    if (typeof o.default !== "string") structure(`${path}/default`, "expected a level or null");
    if (!levels.includes(o.default as EffortLevel)) {
      fail("invalid-effort", `${path}/default: "${String(o.default)}" is not one of the levels`);
    }
    def = o.default as EffortLevel;
  }
  provenance(o.provenance, `${path}/provenance`);
  return { levels, default: def };
}

interface RawModel {
  readonly path: string;
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly Alias[];
  readonly status: Model["status"];
  readonly retiresOn: string | null;
  readonly capabilities: readonly string[];
  readonly effort: Effort | null;
  readonly offerings: readonly RawOffering[];
}

function modelId(value: JsonValue | undefined, path: string): string {
  const s = matching(value, path, MODEL_ID);
  if (s.length > 200) structure(path, "longer than 200 characters");
  return s;
}

function model(value: JsonValue | undefined, path: string): RawModel {
  const o = object(
    value,
    path,
    ["id", "name", "aliases", "status", "capabilities", "offerings", "provenance"],
    ["retiresOn", "effort", "statusProvenance"],
  );
  const id = modelId(o.id, `${path}/id`);
  const name = nonEmpty(o.name, `${path}/name`);
  const aliases = array(o.aliases, `${path}/aliases`).map((a, i): Alias => {
    const p = `${path}/aliases/${i}`;
    const alias = object(a, p, ["id", "status"]);
    const status = alias.status;
    if (status !== "active" && status !== "retired") {
      return structure(`${p}/status`, "expected active or retired");
    }
    return { id: modelId(alias.id, `${p}/id`), status };
  });
  const status = o.status;
  if (
    status !== "preview" &&
    status !== "available" &&
    status !== "deprecated" &&
    status !== "retired"
  ) {
    return structure(`${path}/status`, "expected preview, available, deprecated or retired");
  }
  const retiresOn = o.retiresOn === undefined ? null : date(o.retiresOn, `${path}/retiresOn`);
  const capabilities = array(o.capabilities, `${path}/capabilities`).map((c, i) => {
    if (typeof c !== "string" || !(CAPABILITIES as readonly string[]).includes(c)) {
      return structure(`${path}/capabilities/${i}`, "not a capability");
    }
    return c;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    structure(`${path}/capabilities`, "capabilities must be distinct");
  }
  const eff = o.effort === undefined ? null : effort(o.effort, `${path}/effort`);
  const offerings = array(o.offerings, `${path}/offerings`).map((x, i) =>
    offering(x, `${path}/offerings/${i}`),
  );
  provenance(o.provenance, `${path}/provenance`);
  if (o.statusProvenance !== undefined) provenance(o.statusProvenance, `${path}/statusProvenance`);
  if (
    o.statusProvenance === undefined &&
    (o.retiresOn !== undefined ||
      status === "preview" ||
      status === "deprecated" ||
      status === "retired")
  ) {
    structure(path, 'missing member "statusProvenance"');
  }
  return { path, id, name, aliases, status, retiresOn, capabilities, effort: eff, offerings };
}

interface RawProvider {
  readonly path: string;
  readonly id: Provider["id"];
  readonly name: string;
  readonly pricingUrls: readonly string[];
  readonly models: readonly RawModel[];
}

function provider(value: JsonValue | undefined, path: string): RawProvider {
  const o = object(value, path, ["id", "name", "pricingUrls", "models"]);
  if (!isProviderId(o.id)) structure(`${path}/id`, "not a provider id");
  const name = nonEmpty(o.name, `${path}/name`);
  const pricingUrls = array(o.pricingUrls, `${path}/pricingUrls`, 1).map((u, i) =>
    matching(u, `${path}/pricingUrls/${i}`, HTTPS),
  );
  const models = array(o.models, `${path}/models`).map((m, i) => model(m, `${path}/models/${i}`));
  return { path, id: o.id as Provider["id"], name, pricingUrls, models };
}

// ---------------------------------------------------------------------------------------------
// Semantic checks.
// ---------------------------------------------------------------------------------------------

function sortedCodePoint<T extends string>(items: Iterable<T>): T[] {
  return [...items].sort();
}

function conditionKey(c: Condition): string {
  return `${c.gt ?? ""}|${c.lte ?? ""}`;
}

/** COND-4. Throws `conditions-not-exclusive` or `conditions-not-covering`. */
function checkPartition(sorted: readonly Condition[], path: string): void {
  // Sorted by lower bound (no `gt` first), then by upper bound (no `lte` last).
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1] as Condition;
    const next = sorted[i] as Condition;
    if (previous.lte === null || next.gt === null || next.gt < previous.lte) {
      fail("conditions-not-exclusive", `${path}: conditions overlap`);
    }
  }
  const first = sorted[0] as Condition;
  const last = sorted[sorted.length - 1] as Condition;
  if (first.gt !== null || last.lte !== null) {
    fail("conditions-not-covering", `${path}: conditions leave part of [0, 2^53) uncovered`);
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1] as Condition;
    const next = sorted[i] as Condition;
    if (next.gt !== previous.lte) {
      fail("conditions-not-covering", `${path}: conditions leave a gap`);
    }
  }
}

function compareConditions(a: Condition, b: Condition): number {
  const lowerA = a.gt ?? -1;
  const lowerB = b.gt ?? -1;
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  const upperA = a.lte ?? Number.POSITIVE_INFINITY;
  const upperB = b.lte ?? Number.POSITIVE_INFINITY;
  return upperA === upperB ? 0 : upperA < upperB ? -1 : 1;
}

function buildOffering(raw: RawOffering, providerId: string): Offering {
  const { path } = raw;
  // TIER-1: the prefix of a known tier is its provider's id.
  if (!raw.tier.startsWith(`${providerId}:`)) {
    fail("tier-provider-mismatch", `${path}/tier: "${raw.tier}" is not a tier of "${providerId}"`);
  }

  // COND-3, COND-2.
  const conditioned = raw.rates.filter((r) => r.condition !== null).length;
  if (conditioned !== 0 && conditioned !== raw.rates.length) {
    fail("conditions-mixed", `${path}: some rate entries have a condition and some do not`);
  }
  const hasConditions = conditioned !== 0;
  if (hasConditions !== (raw.conditionInputs !== null)) {
    fail("condition-inputs-invalid", `${path}: conditions and conditionInputs go together`);
  }
  const listed = new Set(raw.rates.map((r) => r.entry.component));
  if (raw.conditionInputs !== null) {
    for (const component of raw.conditionInputs) {
      if (!listed.has(component) || dimensionOfComponent(component) !== "tokens") {
        fail(
          "condition-inputs-invalid",
          `${path}/conditionInputs: "${component}" must be a listed token component`,
        );
      }
    }
  }

  // COND-4: the distinct conditions are the schedules, and partition [0, 2^53).
  const conditions = new Map<string, Condition>();
  for (const r of raw.rates) {
    if (r.condition !== null) conditions.set(conditionKey(r.condition), r.condition);
  }
  const sortedConditions = [...conditions.values()].sort(compareConditions);
  if (hasConditions) checkPartition(sortedConditions, path);

  // Group the entries by schedule.
  const groups: { condition: Condition | null; entries: Map<Component, RateEntry[]> }[] =
    hasConditions
      ? sortedConditions.map((condition) => ({ condition, entries: new Map() }))
      : [{ condition: null, entries: new Map() }];
  for (const r of raw.rates) {
    const group = hasConditions
      ? (groups.find(
          (g) =>
            g.condition !== null &&
            r.condition !== null &&
            conditionKey(g.condition) === conditionKey(r.condition),
        ) as (typeof groups)[number])
      : (groups[0] as (typeof groups)[number]);
    const list = group.entries.get(r.entry.component) ?? [];
    list.push(r.entry);
    group.entries.set(r.entry.component, list);
  }

  // COND-5.
  const reference = sortedCodePoint((groups[0] as (typeof groups)[number]).entries.keys()).join(
    ",",
  );
  for (const g of groups) {
    if (sortedCodePoint(g.entries.keys()).join(",") !== reference) {
      fail("schedules-mismatch", `${path}: the schedules list different components`);
    }
  }

  // TIME-3: each window is non-empty, and no two windows of one component overlap.
  for (const r of raw.rates) {
    const { fromMs, untilMs } = r.entry;
    if (fromMs !== null && untilMs !== null && fromMs >= untilMs) {
      fail(
        "invalid-window",
        `${path}: "${r.entry.component}" has validFrom at or after validUntil`,
      );
    }
  }
  for (const g of groups) {
    for (const [component, entries] of g.entries) {
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
          const a = entries[i] as RateEntry;
          const b = entries[j] as RateEntry;
          const start = Math.max(
            a.fromMs ?? Number.NEGATIVE_INFINITY,
            b.fromMs ?? Number.NEGATIVE_INFINITY,
          );
          const end = Math.min(
            a.untilMs ?? Number.POSITIVE_INFINITY,
            b.untilMs ?? Number.POSITIVE_INFINITY,
          );
          if (start < end)
            fail("windows-overlap", `${path}: two windows of "${component}" overlap`);
        }
      }
    }
  }

  // VAL-5, VAL-6.
  const currencies = new Set(raw.rates.flatMap((r) => (r.currency === null ? [] : [r.currency])));
  if (currencies.size > 1)
    fail("mixed-currencies", `${path}: priced entries use different currencies`);
  const [currency] = [...currencies];
  if (currency === undefined) fail("offering-without-price", `${path}: no entry is priced`);

  const schedules: Schedule[] = groups.map((g) => ({ condition: g.condition, entries: g.entries }));
  return {
    tier: raw.tier,
    currency: currency as Offering["currency"],
    conditionInputs: raw.conditionInputs === null ? null : sortedCodePoint(raw.conditionInputs),
    schedules,
  };
}

function buildProvider(raw: RawProvider): Provider {
  const modelsById = new Map<string, Model>();
  const ids = new Set<string>();
  for (const m of raw.models) {
    if (ids.has(m.id)) fail("duplicate-model", `${m.path}/id: "${m.id}" is listed twice`);
    ids.add(m.id);
  }
  const aliasIds = new Set<string>();
  for (const m of raw.models) {
    for (const a of m.aliases) {
      if (aliasIds.has(a.id))
        fail("duplicate-alias", `${m.path}/aliases: "${a.id}" is listed twice`);
      aliasIds.add(a.id);
    }
  }
  for (const m of raw.models) {
    for (const a of m.aliases) {
      if (a.status === "active" && ids.has(a.id)) {
        fail("alias-collision", `${m.path}/aliases: active alias "${a.id}" is a model id`);
      }
    }
  }

  const modelsByAlias = new Map<string, Model>();
  const models: Model[] = [];
  for (const m of raw.models) {
    const offerings = new Map<Tier, Offering>();
    const tiers = new Set<string>();
    for (const o of m.offerings) {
      if (tiers.has(o.tier))
        fail("duplicate-offering", `${o.path}/tier: "${o.tier}" is listed twice`);
      tiers.add(o.tier);
    }
    for (const o of m.offerings) offerings.set(o.tier, buildOffering(o, raw.id));
    const built: Model = {
      id: m.id,
      name: m.name,
      aliases: m.aliases,
      status: m.status,
      retiresOn: m.retiresOn,
      capabilities: m.capabilities,
      effort: m.effort,
      offerings,
    };
    models.push(built);
    modelsById.set(m.id, built);
    for (const a of m.aliases) modelsByAlias.set(a.id, built);
  }
  return {
    id: raw.id,
    name: raw.name,
    pricingUrls: raw.pricingUrls,
    models,
    modelsById,
    modelsByAlias,
  };
}

/** VER-1: the pattern and a valid date part. */
function version(value: JsonValue | undefined): string {
  const s = text(value, "/version");
  const m = VERSION.exec(s);
  if (m === null || !isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    fail("invalid-version", `/version: "${s}" is not YYYY.MM.DD.N with a valid date`);
  }
  return s;
}

/**
 * Validates a parsed catalog document. `digest` is the sha256 of the bytes it was read from.
 * Throws `AiCatalogError` for the first rule found violated.
 */
export function validateCatalog(document: JsonValue, digest: string): CatalogData {
  if (!isObject(document)) return structure("", "expected an object");
  // VAL-3 comes first: a document of another schema version is not read as this one.
  const schemaVersion = document.schemaVersion;
  if (typeof schemaVersion === "string" && !SCHEMA_VERSION.test(schemaVersion)) {
    fail("unsupported-schema-version", `/schemaVersion: "${schemaVersion}" is not 1.0.x`);
  }
  const o = object(document, "", ["schemaVersion", "version", "publishedAt", "providers"]);
  text(o.schemaVersion, "/schemaVersion");
  const catalogVersion = version(o.version);
  const publishedAt = instant(o.publishedAt, "/publishedAt").text;
  const rawProviders = array(o.providers, "/providers").map((p, i) =>
    provider(p, `/providers/${i}`),
  );

  const providers = new Map<string, Provider>();
  const seen = new Set<string>();
  for (const p of rawProviders) {
    if (seen.has(p.id)) fail("duplicate-provider", `${p.path}/id: "${p.id}" is listed twice`);
    seen.add(p.id);
  }
  for (const p of rawProviders) providers.set(p.id, buildProvider(p));

  return {
    schemaVersion: schemaVersion as string,
    version: catalogVersion,
    publishedAt,
    sha256: digest,
    providers,
  };
}
