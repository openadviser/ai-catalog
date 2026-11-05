// Load-time validation of a catalog, as docs/specification.md Section 14 states it.
//
//   node scripts/validate-catalog.ts <file> [--sha256 <hex>]
//
// CI runs it on data/catalog.json and on every conformance fixture (through
// scripts/check-conformance.ts), so the seed and the rejecting vectors are both
// held to the rules. It reports the code of the first violated rule it meets:
// first the rules that name a field (amounts, per, instants, vocabularies),
// then the schema (invalid-structure), then the semantic rules.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadSchemas, type Validate } from "./schemas.ts";

export interface CatalogError {
  code: string;
  path: string;
  message: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

export const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/;
export const PERS = new Set([1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9]);
export const CURRENCIES = new Set(["USD", "EUR", "GBP"]);
export const TIERS = new Set([
  "anthropic:standard",
  "anthropic:batch",
  "openai:standard",
  "google-gemini:standard",
  "elevenlabs:pay-as-you-go",
]);
export const EFFORT_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const UNIT_DIMENSION: Record<string, string> = {
  token: "tokens",
  character: "characters",
  request: "requests",
  millisecond: "duration",
  second: "duration",
  minute: "duration",
  hour: "duration",
  "token-hour": "token-time",
};

export const COMPONENT_DIMENSION: Record<string, string> = {
  input: "tokens",
  input_cached: "tokens",
  cache_write_5m: "tokens",
  cache_write_1h: "tokens",
  cache_write_30m: "tokens",
  cache_write_12h: "tokens",
  output: "tokens",
  output_audio: "tokens",
  characters: "characters",
  output_audio_duration: "duration",
  web_search: "requests",
  file_search: "requests",
  grounding_search: "requests",
  grounding_maps: "requests",
  generation: "requests",
  code_execution: "duration",
  containers: "duration",
  cache_storage: "token-time",
  file_search_storage: "storage",
};

/** The components added after 1.0.0 (COMP-1): a document that declares 1.0.x does not know them. */
export const ADDED_AFTER_1_0 = new Set(["generation"]);
/** VAL-3: the schema versions this validator accepts. */
const SCHEMA_VERSION = /^1\.[01]\.(0|[1-9][0-9]*)$/;

const WINDOW_INSTANT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const VERSION = /^([0-9]{4})\.([0-9]{2})\.([0-9]{2})\.[1-9][0-9]*$/;

const isObj = (value: Json | undefined): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : []);

export function validDate(year: number, month: number, day: number): boolean {
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

/** Milliseconds since the epoch for a whole-second window instant, or undefined if invalid. */
export function windowInstant(value: string): number | undefined {
  const m = WINDOW_INSTANT.exec(value);
  if (m === null) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 59) return undefined;
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** JSON-1: arrays and objects nest at most this deep, the outermost value being at depth 1. */
export const MAX_DEPTH = 512;

type Frame = { keys: Set<string> | undefined; expectKey: boolean; path: string; index: number };

const here = (stack: Frame[], pendingKey: string | undefined): string => {
  const top = stack[stack.length - 1];
  if (top === undefined) return "/";
  return top.keys !== undefined ? `${top.path}/${pendingKey ?? ""}` : `${top.path}/${top.index}`;
};

/**
 * The first problem only the text can show, or undefined: an object member whose name repeats a
 * sibling's after unescaping (JSON-1), or a number literal that is not an integer literal (JSON-2).
 * JSON.parse keeps the last of two values and rounds numbers to binary floating point, so both checks
 * run on the text itself.
 */
export function textProblem(
  text: string,
): { kind: "duplicate" | "number" | "depth" | "negative-zero"; path: string } | undefined {
  const stack: Frame[] = [];
  let i = 0;
  let pendingKey: string | undefined;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.keys !== undefined && top.expectKey) {
        const name = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(name)) return { kind: "duplicate", path: `${top.path}/${name}` };
        top.keys.add(name);
        top.expectKey = false;
        pendingKey = name;
      }
      i = j + 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      while (j < text.length && /[0-9eE.+-]/.test(text[j] as string)) j++;
      const literal = text.slice(i, j);
      if (!/^-?(0|[1-9][0-9]*)$/.test(literal))
        return { kind: "number", path: here(stack, pendingKey) };
      // JSON-2: -0 is not read as 0, and no member of a catalog may be negative.
      if (literal === "-0") return { kind: "negative-zero", path: here(stack, pendingKey) };
      i = j;
      continue;
    }
    const top = stack[stack.length - 1];
    if (ch === "{" || ch === "[") {
      const where = top === undefined ? "" : here(stack, pendingKey);
      if (stack.length >= MAX_DEPTH) return { kind: "depth", path: where || "/" };
      stack.push({
        keys: ch === "{" ? new Set() : undefined,
        expectKey: ch === "{",
        path: where,
        index: 0,
      });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    } else if (ch === "," && top !== undefined) {
      if (top.keys !== undefined) top.expectKey = true;
      else top.index++;
    }
    i++;
  }
  return undefined;
}

/** The path of the first string or member name that holds an unpaired surrogate (JSON-1), or undefined. */
export function unpairedSurrogate(value: Json, path = ""): string | undefined {
  if (typeof value === "string") return value.isWellFormed() ? undefined : path || "/";
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const found = unpairedSurrogate(item, `${path}/${i}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isObj(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (!key.isWellFormed()) return `${path}/${key}`;
      const found = unpairedSurrogate(child, `${path}/${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

class Rejection extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string, message: string) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

const reject = (code: string, path: string, message: string): never => {
  throw new Rejection(code, path, message);
};

/** The members that hold an instant (TIME-1), wherever they appear in a catalog. */
export const INSTANT_MEMBERS = new Set(["publishedAt", "validFrom", "validUntil", "readAt"]);
/** The members that hold a date (TIME-1). */
export const DATE_MEMBERS = new Set(["retiresOn"]);

export function validDateText(value: string): boolean {
  const m = DATE.exec(value);
  return m !== null && validDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * TIME-1 for every instant and date in the catalog: publishedAt, every validFrom and validUntil, the
 * readAt of every provenance (model, status, effort and rate), and every retiresOn. The schema's
 * patterns cannot tell February 30th from a real day, so the calendar is checked here.
 */
function checkInstants(value: Json, path: string): void {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) checkInstants(item, `${path}/${i}`);
    return;
  }
  if (!isObj(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const where = `${path}/${key}`;
    if (INSTANT_MEMBERS.has(key)) {
      // VAL-4: a value that is not a string is left to the schema (invalid-structure).
      if (typeof child === "string" && windowInstant(child) === undefined) {
        reject("invalid-instant", where, `${JSON.stringify(child)} is not a UTC instant`);
      }
    } else if (DATE_MEMBERS.has(key)) {
      if (typeof child === "string" && !validDateText(child)) {
        reject("invalid-instant", where, `${JSON.stringify(child)} is not a date`);
      }
    } else {
      checkInstants(child, where);
    }
  }
}

/** The rules that name a field and report their own code (VAL-4). */
function checkFields(catalog: Obj): void {
  if (typeof catalog.version === "string") {
    const m = VERSION.exec(catalog.version);
    if (m === null || !validDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
      reject("invalid-version", "/version", `"${catalog.version}" is not YYYY.MM.DD.N`);
    }
  }
  checkInstants(catalog, "");
  // COMP-1: a component added after 1.0.0 is unknown to a document that declares 1.0.x.
  const legacy = typeof catalog.schemaVersion === "string" && /^1\.0\./.test(catalog.schemaVersion);
  const known = (component: string): boolean =>
    Object.hasOwn(COMPONENT_DIMENSION, component) && !(legacy && ADDED_AFTER_1_0.has(component));
  list(catalog.providers).forEach((provider, p) => {
    if (!isObj(provider)) return;
    list(provider.models).forEach((model, m) => {
      if (!isObj(model)) return;
      const mpath = `/providers/${p}/models/${m}`;
      if (isObj(model.effort)) {
        const levels = list(model.effort.levels);
        const def = model.effort.default;
        // VAL-4: a level or default that is not a string is left to the schema (invalid-structure).
        const typed =
          levels.every((l) => typeof l === "string") && (def === null || typeof def === "string");
        if (typed) {
          const known = levels.every((l) => EFFORT_LEVELS.has(l as string));
          const order = [...EFFORT_LEVELS];
          const ranks = levels.map((l) => order.indexOf(l as string));
          const distinct = ranks.every((rank, i) => i === 0 || rank > (ranks[i - 1] as number));
          const defOk = def === null || levels.includes(def);
          if (levels.length === 0 || !known || !distinct || !defOk) {
            reject("invalid-effort", `${mpath}/effort`, "effort levels or default are not valid");
          }
        }
      }
      list(model.offerings).forEach((offering, o) => {
        if (!isObj(offering)) return;
        const opath = `${mpath}/offerings/${o}`;
        if (typeof offering.tier === "string" && !TIERS.has(offering.tier)) {
          reject("unknown-tier", `${opath}/tier`, `unknown tier "${offering.tier}"`);
        }
        if (isObj(offering.conditionInputs)) {
          for (const input of list(offering.conditionInputs.inputTokens)) {
            if (typeof input === "string" && !known(input)) {
              reject(
                "unknown-component",
                `${opath}/conditionInputs`,
                `unknown component "${input}"`,
              );
            }
          }
        }
        list(offering.rates).forEach((rate, r) => {
          if (!isObj(rate)) return;
          checkRateFields(rate, `${opath}/rates/${r}`, known);
        });
      });
    });
  });
}

function checkRateFields(rate: Obj, path: string, known: (component: string) => boolean): void {
  const { component, unit, amount, per, currency } = rate;
  if (typeof component === "string" && !known(component)) {
    reject("unknown-component", `${path}/component`, `unknown component "${component}"`);
  }
  // VAL-4: a unit that is not a string is left to the schema (invalid-structure).
  if (typeof unit === "string") {
    if (!Object.hasOwn(UNIT_DIMENSION, unit)) {
      reject("unknown-unit", `${path}/unit`, `unknown unit ${JSON.stringify(unit)}`);
    }
    const unitDimension = UNIT_DIMENSION[unit];
    const componentDimension = COMPONENT_DIMENSION[component as string];
    if (componentDimension !== undefined && unitDimension !== componentDimension) {
      reject("unit-mismatch", `${path}/unit`, `"${unit}" is not a unit of ${componentDimension}`);
    }
  }
  if (amount !== undefined && (typeof amount !== "string" || !AMOUNT.test(amount))) {
    reject("invalid-amount", `${path}/amount`, `${JSON.stringify(amount)} is not an amount`);
  }
  if (per !== undefined && (typeof per !== "number" || !PERS.has(per))) {
    reject(
      "invalid-per",
      `${path}/per`,
      `${JSON.stringify(per)} is not a power of ten from 1 to 10^9`,
    );
  }
  if (typeof currency === "string" && !CURRENCIES.has(currency)) {
    reject("unknown-currency", `${path}/currency`, `unknown currency ${JSON.stringify(currency)}`);
  }
}

interface Interval {
  gt: number;
  lte: number;
}

const intervalOf = (condition: Obj): Interval => {
  const range = condition.inputTokens as Obj;
  return {
    gt: typeof range.gt === "number" ? range.gt : -1,
    lte: typeof range.lte === "number" ? range.lte : Number.POSITIVE_INFINITY,
  };
};
const intervalKey = (i: Interval): string => `${i.gt}:${i.lte}`;

/** The semantic rules no schema can express (Section 14). */
function checkSemantics(catalog: Obj): void {
  const providerIds = new Set<string>();
  list(catalog.providers).forEach((providerJson, p) => {
    const provider = providerJson as Obj;
    const ppath = `/providers/${p}`;
    const pid = provider.id as string;
    if (providerIds.has(pid))
      reject("duplicate-provider", `${ppath}/id`, `provider "${pid}" twice`);
    providerIds.add(pid);
    const models = list(provider.models) as Obj[];
    const modelIds = new Set<string>();
    for (const [m, model] of models.entries()) {
      const id = model.id as string;
      if (modelIds.has(id))
        reject("duplicate-model", `${ppath}/models/${m}/id`, `model "${id}" twice`);
      modelIds.add(id);
    }
    const aliasIds = new Set<string>();
    for (const [m, model] of models.entries()) {
      for (const [a, aliasJson] of list(model.aliases).entries()) {
        const alias = aliasJson as Obj;
        const apath = `${ppath}/models/${m}/aliases/${a}`;
        const aid = alias.id as string;
        if (aliasIds.has(aid)) reject("duplicate-alias", apath, `alias "${aid}" twice`);
        aliasIds.add(aid);
        if (modelIds.has(aid) && alias.status === "active") {
          reject("alias-collision", apath, `active alias "${aid}" is also a model id`);
        }
      }
      const tiers = new Set<string>();
      for (const [o, offeringJson] of list(model.offerings).entries()) {
        const offering = offeringJson as Obj;
        const opath = `${ppath}/models/${m}/offerings/${o}`;
        const tier = offering.tier as string;
        if (!tier.startsWith(`${pid}:`)) {
          reject("tier-provider-mismatch", `${opath}/tier`, `"${tier}" is not a tier of "${pid}"`);
        }
        if (tiers.has(tier)) reject("duplicate-offering", `${opath}/tier`, `tier "${tier}" twice`);
        tiers.add(tier);
        checkOffering(offering, opath);
      }
    }
  });
}

function checkOffering(offering: Obj, path: string): void {
  const rates = list(offering.rates) as Obj[];
  const priced = rates.filter((r) => r.disposition === "priced");
  if (priced.length === 0) reject("offering-without-price", path, "no priced entry");
  const currencies = new Set(priced.map((r) => r.currency));
  if (currencies.size > 1) reject("mixed-currencies", path, "more than one currency");

  const conditional = rates.filter((r) => r.condition !== undefined).length;
  if (conditional !== 0 && conditional !== rates.length) {
    reject("conditions-mixed", path, "some entries have a condition and some do not");
  }
  const listed = new Set(rates.map((r) => r.component as string));
  const inputs = isObj(offering.conditionInputs)
    ? list(offering.conditionInputs.inputTokens)
    : undefined;
  if (conditional > 0 !== (inputs !== undefined)) {
    reject(
      "condition-inputs-invalid",
      path,
      "conditionInputs must be present exactly when there are conditions",
    );
  }
  for (const input of inputs ?? []) {
    if (!listed.has(input as string) || COMPONENT_DIMENSION[input as string] !== "tokens") {
      reject("condition-inputs-invalid", path, `"${input}" is not a listed token component`);
    }
  }

  // Schedules: distinct intervals, partitioning [0, 2^53).
  const schedules = new Map<string, { interval: Interval; components: Set<string> }>();
  for (const [r, rate] of rates.entries()) {
    const interval = isObj(rate.condition)
      ? intervalOf(rate.condition)
      : { gt: -1, lte: Number.POSITIVE_INFINITY };
    if (interval.gt >= interval.lte) {
      reject("invalid-structure", `${path}/rates/${r}/condition`, "gt must be below lte");
    }
    const key = intervalKey(interval);
    const schedule = schedules.get(key) ?? { interval, components: new Set<string>() };
    schedule.components.add(rate.component as string);
    schedules.set(key, schedule);
  }
  const ordered = [...schedules.values()].sort((a, b) => a.interval.gt - b.interval.gt);
  if (conditional > 0) {
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1] as (typeof ordered)[number];
      const next = ordered[i] as (typeof ordered)[number];
      if (next.interval.gt < prev.interval.lte)
        reject("conditions-not-exclusive", path, "conditions overlap");
      if (next.interval.gt > prev.interval.lte)
        reject("conditions-not-covering", path, "conditions leave a gap");
    }
    if (
      first === undefined ||
      first.interval.gt !== -1 ||
      last?.interval.lte !== Number.POSITIVE_INFINITY
    ) {
      reject("conditions-not-covering", path, "conditions do not cover every input");
    }
  }
  const reference = [...(ordered[0]?.components ?? [])].sort().join(",");
  for (const schedule of ordered) {
    if ([...schedule.components].sort().join(",") !== reference) {
      reject("schedules-mismatch", path, "schedules list different components");
    }
  }

  // Windows: from < until, and no two entries of one schedule and component overlap.
  const windows = new Map<string, Array<[number, number, number]>>();
  for (const [r, rate] of rates.entries()) {
    const from =
      typeof rate.validFrom === "string"
        ? (windowInstant(rate.validFrom) as number)
        : Number.NEGATIVE_INFINITY;
    const until =
      typeof rate.validUntil === "string"
        ? (windowInstant(rate.validUntil) as number)
        : Number.POSITIVE_INFINITY;
    if (from >= until)
      reject("invalid-window", `${path}/rates/${r}`, "validFrom is not before validUntil");
    const interval = isObj(rate.condition)
      ? intervalOf(rate.condition)
      : { gt: -1, lte: Number.POSITIVE_INFINITY };
    const key = `${intervalKey(interval)}|${rate.component as string}`;
    const seen = windows.get(key) ?? [];
    for (const [otherFrom, otherUntil, other] of seen) {
      if (from < otherUntil && otherFrom < until) {
        reject("windows-overlap", `${path}/rates/${r}`, `overlaps rates/${other}`);
      }
    }
    seen.push([from, until, r]);
    windows.set(key, seen);
  }
}

export function validateCatalog(
  bytes: Uint8Array,
  validate: Validate,
  expectedSha256?: string,
): CatalogError | undefined {
  try {
    if (expectedSha256 !== undefined) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== expectedSha256)
        reject("hash-mismatch", "/", `sha256 is ${actual}, expected ${expectedSha256}`);
    }
    let catalog: Json;
    let text: string;
    try {
      // ignoreBOM keeps a byte order mark in the text, where JSON.parse refuses it (JSON-1).
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      catalog = JSON.parse(text) as Json;
    } catch (error) {
      return reject("invalid-json", "/", String(error));
    }
    const problem = textProblem(text);
    if (problem?.kind === "duplicate") {
      reject("invalid-json", problem.path, "a member name appears twice in one object");
    }
    if (problem?.kind === "number") {
      reject("invalid-json", problem.path, "a number is not an integer literal (JSON-2)");
    }
    if (problem?.kind === "negative-zero") {
      reject(
        problem.path.endsWith("/per")
          ? "invalid-per"
          : problem.path.endsWith("/amount")
            ? "invalid-amount"
            : "invalid-structure",
        problem.path,
        "-0 is not read as 0 (JSON-2)",
      );
    }
    if (problem?.kind === "depth") {
      reject("invalid-json", problem.path, `nesting is deeper than ${MAX_DEPTH} (JSON-1)`);
    }
    const lone = unpairedSurrogate(catalog);
    if (lone !== undefined) {
      reject("invalid-json", lone, "a string holds an unpaired surrogate escape (JSON-1)");
    }
    if (!isObj(catalog)) return reject("invalid-structure", "/", "not an object");
    if (typeof catalog.schemaVersion === "string" && !SCHEMA_VERSION.test(catalog.schemaVersion)) {
      reject(
        "unsupported-schema-version",
        "/schemaVersion",
        `"${catalog.schemaVersion}" is not 1.0.x or 1.1.x`,
      );
    }
    checkFields(catalog);
    const problems = validate("catalog", catalog);
    if (problems.length > 0) {
      const first = problems[0] as { path: string; message: string };
      reject("invalid-structure", first.path, first.message);
    }
    checkSemantics(catalog);
    return undefined;
  } catch (error) {
    if (error instanceof Rejection)
      return { code: error.code, path: error.path, message: error.message };
    throw error;
  }
}

if (import.meta.main) {
  const [file, flag, sha] = process.argv.slice(2);
  if (file === undefined) {
    console.error("usage: node scripts/validate-catalog.ts <file> [--sha256 <hex>]");
    process.exit(2);
  }
  const error = validateCatalog(
    readFileSync(file),
    loadSchemas(),
    flag === "--sha256" ? sha : undefined,
  );
  if (error === undefined) {
    console.log(`${file}: valid`);
  } else {
    console.error(`${file}: ${error.code} at ${error.path}: ${error.message}`);
    process.exit(1);
  }
}
