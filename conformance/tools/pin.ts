// Pins the basis bytes and sha256 of the conformance vectors, and checks the
// hand-written figures of every accepting vector against them.
//
//   node conformance/tools/pin.ts --check   fail if any pinned value is stale or any figure is wrong
//   node conformance/tools/pin.ts --write   fill in expected.basis / basisSha256 and replayed bases
//
// THIS IS NOT A CLIENT. It handles only the accepting path, over fixtures that
// scripts/validate-catalog.ts has already validated; it implements no refusal,
// no loader, no hash check and no last-good state, and it is not exported or
// published. Its figures are never the source of a vector: every expected
// amount is written by hand with its derivation, and this tool only confirms it.
// A client must be built from docs/specification.md, not from this file.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const ROOT = resolve(import.meta.dirname, "..");
const VECTORS = join(ROOT, "vectors");
const FIXTURES = join(ROOT, "fixtures");

// ---------------------------------------------------------------- arithmetic

interface Fraction {
  n: bigint;
  d: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const reduce = (f: Fraction): Fraction => {
  const g = gcd(f.n, f.d);
  return g === 0n ? { n: 0n, d: 1n } : { n: f.n / g, d: f.d / g };
};
const add = (a: Fraction, b: Fraction): Fraction =>
  reduce({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const compare = (a: Fraction, b: Fraction): number => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};

function decimal(amount: string): Fraction {
  const [whole, fraction = ""] = amount.split(".");
  return reduce({ n: BigInt(`${whole}${fraction}`), d: 10n ** BigInt(fraction.length) });
}

/** The canonical decimal form (NUM-4) of a fraction known to terminate. */
function canonical(f: Fraction): string {
  const r = reduce(f);
  let twos = 0n;
  let fives = 0n;
  let d = r.d;
  while (d % 2n === 0n) {
    d /= 2n;
    twos++;
  }
  while (d % 5n === 0n) {
    d /= 5n;
    fives++;
  }
  if (d !== 1n) throw new Error("not a terminating decimal");
  const scale = twos > fives ? twos : fives;
  const n = r.n * 2n ** (scale - twos) * 5n ** (scale - fives);
  if (scale === 0n) return n.toString();
  const digits = n.toString().padStart(Number(scale) + 1, "0");
  const intPart = digits.slice(0, digits.length - Number(scale));
  const fracPart = digits.slice(digits.length - Number(scale)).replace(/0+$/, "");
  return fracPart === "" ? intPart : `${intPart}.${fracPart}`;
}

const fractionText = (f: Fraction): string => `${f.n}/${f.d}`;

function rounded(f: Fraction, exponent: number): { estimate: string; booked: string } {
  const scale = 10n ** BigInt(exponent);
  const minor = (2n * f.n * scale + f.d) / (2n * f.d);
  const booked = minor === 0n && f.n > 0n ? 1n : minor;
  const render = (m: bigint): string => {
    if (exponent === 0) return m.toString();
    const s = m.toString().padStart(exponent + 1, "0");
    return `${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
  };
  return { estimate: render(minor), booked: render(booked) };
}

// ---------------------------------------------------------------- vocabulary

const EXPONENT: Record<string, number> = { USD: 2, EUR: 2, GBP: 2 };
const UNIT: Record<string, { meter: string | null; factor: number | null; dimension: string }> = {
  token: { meter: "token", factor: 1, dimension: "tokens" },
  character: { meter: "character", factor: 1, dimension: "characters" },
  request: { meter: "request", factor: 1, dimension: "requests" },
  millisecond: { meter: "millisecond", factor: 1, dimension: "duration" },
  second: { meter: "millisecond", factor: 1000, dimension: "duration" },
  minute: { meter: "millisecond", factor: 60000, dimension: "duration" },
  hour: { meter: "millisecond", factor: 3600000, dimension: "duration" },
  "token-hour": { meter: null, factor: null, dimension: "token-time" },
};
const NOT_PER_CALL = new Set(["cache_storage", "file_search_storage"]);
const PERS = new Set([1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9]);

// ---------------------------------------------------------------- canonical JSON (RFC 8785 subset)

export function jcs(value: Json): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`basis number ${value} not allowed`);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k] as Json)}`).join(",")}}`;
}

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------- instants

function instantMs(value: string): number {
  const m =
    /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z$/.exec(
      value,
    );
  if (m === null) throw new Error(`bad instant ${value}`);
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Number((m[7] ?? "").padEnd(3, "0"));
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}

// ---------------------------------------------------------------- pricing (accepting path only)

type Entry = Obj; // a basis component

interface Schedule {
  condition: Obj | null;
  gt: number;
  lte: number;
  components: Entry[];
}

function buildSchedules(offering: Obj, at: string): Schedule[] {
  const t = instantMs(at);
  const rates = offering.rates as Obj[];
  const components = [...new Set(rates.map((r) => r.component as string))].sort();
  const byKey = new Map<string, Schedule>();
  for (const rate of rates) {
    const cond = (rate.condition as Obj | undefined) ?? null;
    const range = (cond?.inputTokens as Obj | undefined) ?? {};
    const gt = typeof range.gt === "number" ? range.gt : -1;
    const lte = typeof range.lte === "number" ? range.lte : Number.POSITIVE_INFINITY;
    const key = `${gt}:${lte}`;
    if (!byKey.has(key)) byKey.set(key, { condition: cond, gt, lte, components: [] });
  }
  const schedules = [...byKey.values()].sort((a, b) => a.gt - b.gt);
  for (const schedule of schedules) {
    for (const component of components) {
      const inForce = rates.filter((r) => {
        const cond = (r.condition as Obj | undefined) ?? null;
        if (JSON.stringify(cond) !== JSON.stringify(schedule.condition)) return false;
        if (r.component !== component) return false;
        const from =
          typeof r.validFrom === "string" ? instantMs(r.validFrom) : Number.NEGATIVE_INFINITY;
        const until =
          typeof r.validUntil === "string" ? instantMs(r.validUntil) : Number.POSITIVE_INFINITY;
        return from <= t && t < until;
      });
      if (inForce.length > 1) throw new Error(`two entries in force for ${component}`);
      const rate = inForce[0];
      if (rate === undefined) {
        schedule.components.push({ component, disposition: "no-rate" });
      } else if (rate.disposition === "priced") {
        const unit = UNIT[rate.unit as string];
        if (unit === undefined) throw new Error(`unknown unit ${String(rate.unit)}`);
        schedule.components.push({
          component,
          disposition: "priced",
          unit: rate.unit as string,
          per: rate.per as number,
          amount: canonical(decimal(rate.amount as string)),
          meter: unit.meter,
          factor: unit.factor,
          validFrom: (rate.validFrom as string | undefined) ?? null,
          validUntil: (rate.validUntil as string | undefined) ?? null,
        });
      } else {
        schedule.components.push({ component, disposition: rate.disposition as string });
      }
    }
  }
  return schedules;
}

interface Figures {
  currency: string;
  schedule: number;
  exact: string;
  estimate: string;
  booked: string;
}

function evaluate(
  schedules: Schedule[],
  conditionInputs: Obj,
  currency: string,
  exponent: number,
  usage: Obj,
  unknownInput: boolean,
): Figures {
  if (usage.completeness !== "complete")
    throw new Error("an accepting vector needs a complete report");
  const quantities = usage.quantities as Record<string, number>;
  const required = new Set<string>();
  for (const s of schedules) {
    for (const e of s.components) {
      const c = e.component as string;
      if (!NOT_PER_CALL.has(c) && e.disposition !== "inapplicable") required.add(c);
    }
  }
  for (const c of (conditionInputs.inputTokens as string[] | undefined) ?? []) required.add(c);
  const missing = [...required].filter((c) => !(c in quantities)).sort();
  if (missing.length > 0) throw new Error(`report misses ${missing.join(", ")}`);
  const listed = new Set(schedules[0]?.components.map((e) => e.component as string));
  for (const [c, q] of Object.entries(quantities)) {
    if (q > 0 && !listed.has(c)) throw new Error(`${c} is not offered`);
  }
  const inputs = (conditionInputs.inputTokens as string[] | undefined) ?? [];
  let candidates = schedules.map((s, i) => ({ s, i }));
  if (schedules.length > 1 && !unknownInput) {
    const x = inputs.reduce((sum, c) => sum + (quantities[c] ?? 0), 0);
    candidates = candidates.filter(({ s }) => x > s.gt && x <= s.lte);
    if (candidates.length !== 1) throw new Error("not exactly one schedule holds");
  }
  let best: { total: Fraction; index: number } | undefined;
  for (const { s, i } of candidates) {
    let total: Fraction = { n: 0n, d: 1n };
    for (const e of s.components) {
      const q = quantities[e.component as string] ?? 0;
      if (q === 0) continue;
      if (e.disposition !== "priced")
        throw new Error(`${String(e.component)} is ${String(e.disposition)} and in use`);
      if (e.factor === null) throw new Error(`${String(e.component)} has a compound unit`);
      const a = decimal(e.amount as string);
      total = add(
        total,
        reduce({
          n: BigInt(q) * a.n,
          d: BigInt(e.per as number) * BigInt(e.factor as number) * a.d,
        }),
      );
    }
    if (best === undefined || compare(total, best.total) > 0) best = { total, index: i };
  }
  if (best === undefined) throw new Error("no schedule");
  return {
    currency,
    schedule: best.index,
    exact: fractionText(best.total),
    ...rounded(best.total, exponent),
  };
}

function price(vector: Obj): { figures: Figures & Obj; basis: string } {
  const fixture = (vector.catalog as Obj).fixture as string;
  const bytes = readFileSync(join(FIXTURES, fixture));
  const catalog = JSON.parse(bytes.toString("utf8")) as Obj;
  const request = vector.request as Obj;
  const provider = (catalog.providers as Obj[]).find((p) => p.id === request.provider);
  if (provider === undefined) throw new Error("unknown provider");
  const models = provider.models as Obj[];
  const model =
    models.find((m) => m.id === request.modelId) ??
    models.find((m) => (m.aliases as Obj[]).some((a) => a.id === request.modelId));
  if (model === undefined) throw new Error("unknown model");
  const offering = (model.offerings as Obj[]).find((o) => o.tier === request.tier);
  if (offering === undefined) throw new Error("unknown offering");
  const priced = (offering.rates as Obj[]).find((r) => r.disposition === "priced");
  const currency = priced?.currency as string;
  const exponent = EXPONENT[currency] as number;
  const schedules = buildSchedules(offering, request.at as string);
  const conditionInputs: Obj = {};
  const inputs = (offering.conditionInputs as Obj | undefined)?.inputTokens as string[] | undefined;
  if (inputs !== undefined) conditionInputs.inputTokens = [...inputs].sort();
  const unknownInput =
    ((request.conditionInputs as Obj | undefined)?.inputTokens ?? null) === "unknown";
  const figures = evaluate(
    schedules,
    conditionInputs,
    currency,
    exponent,
    request.usage as Obj,
    unknownInput,
  );
  const basis: Obj = {
    basisVersion: 1,
    origin: { kind: "catalog", version: catalog.version as string, sha256: sha256(bytes) },
    provider: provider.id as string,
    model: { id: model.id as string, requested: request.modelId as string },
    tier: request.tier as string,
    currency,
    rounding: { rule: "half-up-once-on-total", exponent, settlement: request.settlement as string },
    conditionInputs,
    schedules: schedules.map((s) => ({ condition: s.condition, components: s.components })),
  };
  return {
    figures: {
      provider: provider.id as string,
      modelId: model.id as string,
      tier: request.tier as string,
      ...figures,
    },
    basis: jcs(basis),
  };
}

function replay(request: Obj): Figures {
  const basis = JSON.parse(request.basis as string) as Obj;
  const schedules: Schedule[] = (basis.schedules as Obj[]).map((s) => {
    const range = ((s.condition as Obj | null)?.inputTokens as Obj | undefined) ?? {};
    return {
      condition: s.condition as Obj | null,
      gt: typeof range.gt === "number" ? range.gt : -1,
      lte: typeof range.lte === "number" ? range.lte : Number.POSITIVE_INFINITY,
      components: s.components as Entry[],
    };
  });
  const rounding = basis.rounding as Obj;
  const unknownInput =
    ((request.conditionInputs as Obj | undefined)?.inputTokens ?? null) === "unknown";
  return evaluate(
    schedules,
    basis.conditionInputs as Obj,
    basis.currency as string,
    rounding.exponent as number,
    request.usage as Obj,
    unknownInput,
  );
}

// ---------------------------------------------------------------- convertRate (UNIT-4)

function convert(request: Obj): { amount: string } | { code: string } {
  const rate = request.rate as Obj;
  const to = request.to as Obj;
  if (!PERS.has(to.per as number)) return { code: "invalid-per" };
  const from = UNIT[rate.unit as string];
  const target = UNIT[to.unit as string];
  if (from === undefined || target === undefined) throw new Error("unknown unit");
  if (from.dimension !== target.dimension) return { code: "dimension-mismatch" };
  if (from.factor === null || target.factor === null) return { code: "unsupported-unit" };
  const a = decimal(rate.amount as string);
  const result = reduce({
    n: a.n * BigInt(to.per as number) * BigInt(target.factor),
    d: a.d * BigInt(rate.per as number) * BigInt(from.factor),
  });
  const scaled = result.n * 10n ** BigInt(to.scale as number);
  if (scaled % result.d !== 0n) return { code: "inexact-conversion" };
  return { amount: canonical(result) };
}

// ---------------------------------------------------------------- driver

export function run(write: boolean): string[] {
  const problems: string[] = [];
  const files = readdirSync(VECTORS)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const all = new Map<string, Obj>();
  const docs = files.map((file) => {
    const doc = JSON.parse(readFileSync(join(VECTORS, file), "utf8")) as Obj;
    for (const v of doc.vectors as Obj[]) all.set(v.id as string, v);
    return { file, doc };
  });
  const keys = [
    "provider",
    "modelId",
    "tier",
    "currency",
    "schedule",
    "exact",
    "estimate",
    "booked",
  ];
  // Price vectors first, so that a replay can copy the basis its source pinned.
  const ordered = docs.flatMap(({ doc }) => doc.vectors as Obj[]);
  ordered.sort((a, b) => Number(a.kind === "priceFromBasis") - Number(b.kind === "priceFromBasis"));
  for (const v of ordered) {
    const id = v.id as string;
    try {
      if (v.kind === "price" && v.expected !== undefined) {
        const expected = v.expected as Obj;
        const { figures, basis } = price(v);
        for (const k of keys) {
          if (expected[k] !== figures[k])
            problems.push(`${id}: ${k} is ${String(expected[k])}, computed ${String(figures[k])}`);
        }
        if (write) {
          expected.basis = basis;
          expected.basisSha256 = sha256(basis);
        } else if (expected.basis !== basis || expected.basisSha256 !== sha256(basis)) {
          problems.push(`${id}: pinned basis is stale; run --write`);
        }
      } else if (v.kind === "priceFromBasis" && v.expected !== undefined) {
        const request = v.request as Obj;
        const source = all.get(request.basisFrom as string);
        const sourceExpected = source?.expected as Obj | undefined;
        if (sourceExpected === undefined)
          throw new Error(`basisFrom ${String(request.basisFrom)} has no basis`);
        if (write) {
          request.basis = sourceExpected.basis as string;
          request.basisSha256 = sourceExpected.basisSha256 as string;
        } else if (
          request.basis !== sourceExpected.basis ||
          request.basisSha256 !== sourceExpected.basisSha256
        ) {
          problems.push(
            `${id}: replayed basis differs from ${String(request.basisFrom)}; run --write`,
          );
        }
        const figures = replay(request) as unknown as Obj;
        const expected = v.expected as Obj;
        for (const k of ["currency", "schedule", "exact", "estimate", "booked"]) {
          if (expected[k] !== figures[k])
            problems.push(`${id}: ${k} is ${String(expected[k])}, computed ${String(figures[k])}`);
        }
      } else if (v.kind === "convert") {
        const result = convert(v.request as Obj);
        const expected = (v.expected as Obj | undefined) ?? (v.expectedError as Obj);
        const got = "amount" in result ? result.amount : result.code;
        const want = "amount" in expected ? expected.amount : expected.code;
        if (got !== want) problems.push(`${id}: expected ${String(want)}, computed ${got}`);
      }
    } catch (error) {
      problems.push(`${id}: ${(error as Error).message}`);
    }
  }
  if (write) {
    for (const { file, doc } of docs)
      writeFileSync(join(VECTORS, file), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return problems;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  if (!write && !process.argv.includes("--check")) {
    console.error("usage: node conformance/tools/pin.ts --check | --write");
    process.exit(2);
  }
  const problems = run(write);
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log(write ? "Pinned every basis." : "Every pinned basis and figure checks out.");
}
