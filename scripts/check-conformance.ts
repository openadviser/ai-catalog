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
//   it to be refused as invalid.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSchemas, ROOT, type Validate } from "./schemas.ts";
import { validateCatalog } from "./validate-catalog.ts";

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
      if (v.kind === "priceFromBasis" && v.expected !== undefined) {
        for (const p of validate("basis", JSON.parse(request?.basis as string))) {
          problems.push(`${where}: basis${p.path} ${p.message}`);
        }
      }
      if (v.kind === "price" && v.expected !== undefined) {
        const basis = (v.expected as Obj).basis as string;
        for (const p of validate("basis", JSON.parse(basis)))
          problems.push(`${where}: basis${p.path} ${p.message}`);
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
