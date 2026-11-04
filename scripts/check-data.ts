// Checks data/catalog.json, its hash and its evidence.
//
//   node scripts/check-data.ts          check everything below
//   node scripts/check-data.ts --hash   rewrite data/catalog.json.sha256 from the file's bytes
//
// - data/catalog.json passes load-time validation (scripts/validate-catalog.ts);
// - data/catalog.json.sha256 is "<sha256>  catalog.json" for the file's exact bytes;
// - every evidence/<sha256> body hashes to its name and has at least one retrieval
//   record evidence/<sha256>.<time>.json that names it;
// - every provenance in the catalog names an evidence body whose record carries the
//   provenance's URL and read time, and every cited excerpt (location, anchors and
//   derivation inputs) is exactly the bytes at its offset;
// - every evidence body is cited by the catalog.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSchemas, ROOT, type Validate } from "./schemas.ts";
import { validateCatalog } from "./validate-catalog.ts";

type Obj = Record<string, unknown>;

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

interface Record_ {
  sha256: string;
  requestedUrl: string;
  retrievedAt: string;
}

export function hashLine(bytes: Uint8Array): string {
  return `${sha256(bytes)}  catalog.json\n`;
}

/** Every provenance object in the catalog, with a path for messages. */
export function provenances(value: unknown, path = ""): Array<{ path: string; provenance: Obj }> {
  if (Array.isArray(value)) return value.flatMap((v, i) => provenances(v, `${path}/${i}`));
  if (typeof value !== "object" || value === null) return [];
  const out: Array<{ path: string; provenance: Obj }> = [];
  for (const [key, child] of Object.entries(value as Obj)) {
    if (
      (key === "provenance" || key === "statusProvenance") &&
      typeof child === "object" &&
      child !== null
    ) {
      out.push({ path: `${path}/${key}`, provenance: child as Obj });
    } else {
      out.push(...provenances(child, `${path}/${key}`));
    }
  }
  return out;
}

export function checkData(root: string = ROOT, validate: Validate = loadSchemas(root)): string[] {
  const problems: string[] = [];
  const bytes = readFileSync(join(root, "data/catalog.json"));
  const error = validateCatalog(bytes, validate);
  if (error !== undefined)
    problems.push(`data/catalog.json: ${error.code} at ${error.path}: ${error.message}`);
  const recorded = readFileSync(join(root, "data/catalog.json.sha256"), "utf8");
  if (recorded !== hashLine(bytes)) {
    problems.push(
      "data/catalog.json.sha256 does not match data/catalog.json; run: npm run data:hash",
    );
  }

  const evidenceDir = join(root, "evidence");
  const bodies = new Map<string, Buffer>();
  const records = new Map<string, Record_[]>();
  for (const name of readdirSync(evidenceDir)) {
    if (/^[0-9a-f]{64}$/.test(name)) {
      const body = readFileSync(join(evidenceDir, name));
      if (sha256(body) !== name) problems.push(`evidence/${name}: bytes hash to ${sha256(body)}`);
      bodies.set(name, body);
    } else if (/^[0-9a-f]{64}\.[0-9]{8}T[0-9]{6}Z\.json$/.test(name)) {
      const record = JSON.parse(readFileSync(join(evidenceDir, name), "utf8")) as Record_;
      if (record.sha256 !== name.slice(0, 64))
        problems.push(`evidence/${name}: names ${record.sha256}`);
      const list = records.get(record.sha256) ?? [];
      list.push(record);
      records.set(record.sha256, list);
    } else if (name !== "README.md") {
      problems.push(`evidence/${name}: not a body, a retrieval record or the README`);
    }
  }
  for (const sha of bodies.keys())
    if (!records.has(sha)) problems.push(`evidence/${sha}: no retrieval record`);
  for (const sha of records.keys())
    if (!bodies.has(sha)) problems.push(`evidence record for ${sha}: no body`);

  const cited = new Set<string>();
  const excerptAt = (where: string, sha: string, offset: number, excerpt: string): void => {
    const body = bodies.get(sha);
    if (body === undefined) {
      problems.push(`${where}: evidence ${sha} is not in evidence/`);
      return;
    }
    cited.add(sha);
    const want = Buffer.from(excerpt, "utf8");
    if (!body.subarray(offset, offset + want.length).equals(want)) {
      problems.push(
        `${where}: the bytes at offset ${offset} of ${sha.slice(0, 12)} are not the excerpt`,
      );
    }
  };
  const catalog = JSON.parse(bytes.toString("utf8")) as unknown;
  for (const { path, provenance } of provenances(catalog)) {
    const sha = provenance.evidence as string;
    const matching = (records.get(sha) ?? []).filter(
      (r) => r.requestedUrl === provenance.url && r.retrievedAt === provenance.readAt,
    );
    if (matching.length === 0)
      problems.push(`${path}: no retrieval record of ${sha.slice(0, 12)} for its url and readAt`);
    const location = provenance.location as Obj | undefined;
    if (location !== undefined) {
      excerptAt(path, sha, location.offset as number, location.excerpt as string);
      for (const anchor of (location.anchors as Obj[] | undefined) ?? []) {
        excerptAt(`${path} anchor`, sha, anchor.offset as number, anchor.excerpt as string);
      }
    }
    const derivation = provenance.derivation as Obj | undefined;
    for (const input of (derivation?.inputs as Obj[] | undefined) ?? []) {
      excerptAt(
        `${path} derivation`,
        input.evidence as string,
        input.offset as number,
        input.excerpt as string,
      );
    }
  }
  for (const sha of bodies.keys())
    if (!cited.has(sha)) problems.push(`evidence/${sha}: not cited by data/catalog.json`);
  return problems;
}

if (import.meta.main) {
  if (process.argv.includes("--hash")) {
    const file = join(ROOT, "data/catalog.json");
    writeFileSync(`${file}.sha256`, hashLine(readFileSync(file)));
    console.log("data/catalog.json.sha256 written.");
  } else {
    const problems = checkData();
    for (const p of problems) console.error(p);
    if (problems.length > 0) process.exit(1);
    console.log("data/catalog.json, its hash and every cited excerpt check out.");
  }
}
