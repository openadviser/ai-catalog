// Checks the conformance vectors against the schemas, the specification and the validator.
//
//   node scripts/check-conformance.ts
//
// - every vector file satisfies schema/vector.schema.json;
// - every vector names a rule docs/specification.md defines, and the rule's row in
//   Appendix B lists it; every vector id Appendix B lists exists;
// - every fixture a vector names exists, every valid fixture is loaded by a
//   load-accept vector, and every invalid fixture by exactly one rejecting vector;
// - every load vector gets exactly its expected outcome from scripts/validate-catalog.ts,
//   and the schema alone rejects exactly the fixtures whose defect it can express;
// - every usage report satisfies schema/usage.schema.json unless the vector expects
//   it to be refused as invalid;
// - every pinned basis passes its schema and BASIS-4 step 5, and every canonical basis
//   a vector expects to be invalid fails one of them.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSchemas, ROOT, type Validate } from "./schemas.ts";
import { COMPONENT_DIMENSION, UNIT_DIMENSION, validateCatalog } from "./validate-catalog.ts";

type Obj = Record<string, unknown>;

/** Codes whose defect the JSON Schema itself expresses, so the schema must reject the fixture. */
export const SCHEMA_CODES = new Set([
  "invalid-amount",
  "invalid-per",
  "unknown-currency",
  "unknown-unit",
  "unit-mismatch",
  "unknown-component",
  "unknown-tier",
  "invalid-version",
  "unsupported-schema-version",
  "invalid-structure",
]);

/** Codes no schema can express, so the schema must accept the fixture and only the validator rejects it. */
export const SEMANTIC_CODES = new Set([
  "tier-provider-mismatch",
  "windows-overlap",
  "invalid-window",
  "condition-inputs-invalid",
  "conditions-mixed",
  "conditions-not-exclusive",
  "conditions-not-covering",
  "schedules-mismatch",
  "duplicate-provider",
  "duplicate-model",
  "duplicate-alias",
  "duplicate-offering",
  "alias-collision",
  "mixed-currencies",
  "offering-without-price",
  "invalid-effort",
]);

const USAGE_REFUSALS = new Set(["invalid-usage", "quantity-out-of-range"]);

const EXPONENT: Record<string, number> = { USD: 2, EUR: 2, GBP: 2 };
const METER: Record<string, [string | null, number | null]> = {
  token: ["token", 1],
  character: ["character", 1],
  request: ["request", 1],
  millisecond: ["millisecond", 1],
  second: ["millisecond", 1000],
  minute: ["millisecond", 60000],
  hour: ["millisecond", 3600000],
  "token-hour": [null, null],
};

const ascending = (list: string[]): boolean =>
  list.every((c, i) => i === 0 || (list[i - 1] as string) < c);

/** BASIS-4 step 5: why a schema-valid basis is not one `price` could have written, or undefined. */
export function basisProblem(basis: Obj): string | undefined {
  const rounding = basis.rounding as Obj;
  if (rounding.exponent !== EXPONENT[basis.currency as string])
    return "exponent is not the currency's";
  const schedules = basis.schedules as Obj[];
  const names = (s: Obj): string[] => (s.components as Obj[]).map((c) => c.component as string);
  const first = names(schedules[0] as Obj);
  for (const schedule of schedules) {
    const list = names(schedule);
    if (!ascending(list)) return "components not strictly ascending";
    if (list.join() !== first.join()) return "schedules list different components";
    for (const c of schedule.components as Obj[]) {
      if (c.disposition !== "priced") continue;
      const unit = c.unit as string;
      const [meter, factor] = METER[unit] ?? [undefined, undefined];
      if (c.meter !== meter || c.factor !== factor)
        return `meter or factor is not the unit's for ${String(c.component)}`;
      if (COMPONENT_DIMENSION[c.component as string] !== UNIT_DIMENSION[unit])
        return `unit outside its dimension`;
      if (/\.$|\.[0-9]*0$/.test(c.amount as string))
        return `amount not canonical for ${String(c.component)}`;
      if (
        c.validFrom !== null &&
        c.validUntil !== null &&
        !((c.validFrom as string) < (c.validUntil as string))
      ) {
        return "window not ordered";
      }
    }
  }
  const inputs = (basis.conditionInputs as Obj).inputTokens as string[] | undefined;
  if (schedules.length === 1) {
    if ((schedules[0] as Obj).condition !== null || inputs !== undefined)
      return "one schedule with a condition";
    return undefined;
  }
  if (inputs === undefined || !ascending(inputs)) return "conditionInputs missing or unsorted";
  if (inputs.some((c) => !first.includes(c) || COMPONENT_DIMENSION[c] !== "tokens")) {
    return "conditionInputs names a component the schedules do not list";
  }
  let previous = -1;
  for (const schedule of schedules) {
    const range = (schedule.condition as Obj | null)?.inputTokens as Obj | undefined;
    if (range === undefined) return "a schedule without a condition";
    if ((typeof range.gt === "number" ? range.gt : -1) !== previous)
      return "schedules do not partition the input";
    previous = typeof range.lte === "number" ? range.lte : Number.POSITIVE_INFINITY;
  }
  return previous === Number.POSITIVE_INFINITY ? undefined : "schedules do not cover the input";
}

/** RFC 8785 for the basis's value types, enough to tell whether a pinned string is canonical. */
function jcsLike(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jcsLike).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Obj;
    const members = Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcsLike(o[k])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function appendixB(spec: string): Map<string, string[]> {
  const start = spec.indexOf("## Appendix B.");
  const end = spec.indexOf("## Appendix C.");
  const rows = new Map<string, string[]>();
  for (const line of spec.slice(start, end).split("\n")) {
    const m = /^\| ([A-Z]+-[0-9]+) +\| (.*)\|$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    rows.set(
      m[1],
      [...m[2].matchAll(/`([a-z0-9-]+)`/g)].map((x) => x[1] as string),
    );
  }
  return rows;
}

export function checkConformance(
  root: string = ROOT,
  validate: Validate = loadSchemas(root),
): string[] {
  const problems: string[] = [];
  const spec = readFileSync(join(root, "docs/specification.md"), "utf8");
  const defined = new Set([...spec.matchAll(/\*\*([A-Z]+-[0-9]+)\. /g)].map((m) => m[1] as string));
  const index = appendixB(spec);
  const vectorsDir = join(root, "conformance/vectors");
  const fixturesDir = join(root, "conformance/fixtures");
  const ids = new Set<string>();
  const fixtureUse = new Map<string, number>();

  for (const file of readdirSync(vectorsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const doc = JSON.parse(readFileSync(join(vectorsDir, file), "utf8")) as Obj;
    for (const p of validate("vector", doc)) problems.push(`${file}${p.path}: ${p.message}`);
    for (const v of (doc.vectors as Obj[] | undefined) ?? []) {
      const id = v.id as string;
      const where = `${file} ${id}`;
      if (ids.has(id)) problems.push(`${where}: duplicate vector id`);
      ids.add(id);
      const rule = v.rule as string;
      if (!defined.has(rule))
        problems.push(`${where}: rule ${rule} is not defined in the specification`);
      if (!(index.get(rule) ?? []).includes(id))
        problems.push(`${where}: Appendix B's row for ${rule} does not list it`);
      const error = v.expectedError as Obj | undefined;
      const catalog = v.catalog as Obj | undefined;
      if (catalog !== undefined) {
        const fixture = catalog.fixture as string;
        let bytes: Buffer;
        try {
          bytes = readFileSync(join(fixturesDir, fixture));
        } catch {
          problems.push(`${where}: fixture ${fixture} does not exist`);
          continue;
        }
        if (v.kind === "load") fixtureUse.set(fixture, (fixtureUse.get(fixture) ?? 0) + 1);
        const result = validateCatalog(
          bytes,
          validate,
          v.kind === "load" ? (v.expectedSha256 as string | undefined) : undefined,
        );
        const want = v.kind === "load" ? (error?.code as string | undefined) : undefined;
        if (result?.code !== want) {
          problems.push(
            `${where}: validator gives ${result?.code ?? "valid"}, expected ${want ?? "valid"}`,
          );
        }
        if (v.kind === "load" && want !== undefined && v.expectedSha256 === undefined) {
          const schemaRejects = validate("catalog", JSON.parse(bytes.toString("utf8"))).length > 0;
          if (SCHEMA_CODES.has(want) && !schemaRejects)
            problems.push(`${where}: the schema should reject this fixture`);
          if (SEMANTIC_CODES.has(want) && schemaRejects)
            problems.push(`${where}: the schema should accept this fixture`);
        }
      }
      const request = v.request as Obj | undefined;
      if (request?.usage !== undefined && !USAGE_REFUSALS.has(error?.code as string)) {
        for (const p of validate("usage", request.usage))
          problems.push(`${where}: usage${p.path} ${p.message}`);
      }
      const pinned =
        v.kind === "price" && v.expected !== undefined
          ? ((v.expected as Obj).basis as string)
          : v.kind === "priceFromBasis"
            ? (request?.basis as string)
            : undefined;
      if (pinned !== undefined) {
        const doc = JSON.parse(pinned) as Obj;
        const schemaProblems = validate("basis", doc);
        const semantic = schemaProblems.length === 0 ? basisProblem(doc) : "schema";
        if (error === undefined) {
          for (const p of schemaProblems) problems.push(`${where}: basis${p.path} ${p.message}`);
          if (semantic !== undefined)
            problems.push(`${where}: basis fails BASIS-4 step 5: ${semantic}`);
        } else if (
          error.code === "invalid-basis" &&
          pinned === jcsLike(doc) &&
          semantic === undefined
        ) {
          problems.push(
            `${where}: a canonical basis expected to be invalid passes the schema and step 5`,
          );
        }
      }
    }
  }
  for (const [rule, listed] of index) {
    if (!defined.has(rule)) problems.push(`Appendix B: ${rule} is not defined`);
    for (const id of listed)
      if (!ids.has(id)) problems.push(`Appendix B: ${rule} lists ${id}, which does not exist`);
  }
  const fixtures = [
    ...readdirSync(fixturesDir).filter((f) => f.endsWith(".json")),
    ...readdirSync(join(fixturesDir, "invalid")).map((f) => `invalid/${f}`),
  ];
  for (const fixture of fixtures) {
    const uses = fixtureUse.get(fixture) ?? 0;
    if (fixture.startsWith("invalid/") ? uses !== 1 : uses < 1) {
      problems.push(`fixture ${fixture} is loaded by ${uses} load vectors`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkConformance(resolve(ROOT));
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log(
    "Conformance vectors are consistent with the schemas, the specification and the validator.",
  );
}
