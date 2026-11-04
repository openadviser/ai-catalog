// Writes a built partition into a repository tree: `data/catalog.json`, its sha256, and
// exactly the evidence the added or changed entries cite (docs/trust-and-provenance.md).
//
// A body is copied into `evidence/` only when a reading it supports enters the tree, with
// the retrieval record of the (url, readAt) the provenance names. Nothing else from the
// run is committed. Nothing is ever deleted: a body no value cites any more is listed in
// `evidence/superseded.json`, so check-data's "cited or superseded" rule holds.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hashLine, provenances, readSuperseded, SUPERSEDED } from "../../scripts/check-data.ts";
import { applyCoverage, renderCoverage } from "../../scripts/coverage-table.ts";
import { type BuiltPartition, type EvidenceNeed, evidenceNeeded } from "./apply.ts";
import type { Catalog } from "./model.ts";
import { recordFiles } from "./run.ts";

function compact(instant: string): string {
  return instant.replace(/[-:]/g, "");
}

/** Copies the needed bodies and records into `<root>/evidence`. Throws when one is missing. */
export function copyEvidence(root: string, needs: EvidenceNeed[], dirs: string[]): string[] {
  const target = join(root, "evidence");
  mkdirSync(target, { recursive: true });
  const copied: string[] = [];
  for (const need of needs) {
    const src = dirs.map((d) => join(d, need.sha256)).find((p) => existsSync(p));
    if (src === undefined) throw new Error(`evidence ${need.sha256} is not in this run`);
    const dest = join(target, need.sha256);
    if (existsSync(dest)) {
      if (!readFileSync(dest).equals(readFileSync(src)))
        throw new Error(`evidence/${need.sha256} exists with different bytes`);
    } else {
      copyFileSync(src, dest);
      copied.push(need.sha256);
    }
    const records = recordFiles(dirs, need.sha256);
    for (const want of need.records) {
      const candidates = records.filter((r) => {
        const rec = JSON.parse(readFileSync(join(r.dir, r.name), "utf8")) as {
          requestedUrl: string;
        };
        if (rec.requestedUrl !== want.url) return false;
        return (
          want.readAt === undefined || r.name === `${need.sha256}.${compact(want.readAt)}.json`
        );
      });
      const chosen = candidates[0] ?? (want.readAt === undefined ? records[0] : undefined);
      if (chosen === undefined)
        throw new Error(
          `no retrieval record of ${need.sha256.slice(0, 12)} for ${want.url} at ${want.readAt ?? "any time"}`,
        );
      const recDest = join(target, chosen.name);
      if (!existsSync(recDest)) {
        copyFileSync(join(chosen.dir, chosen.name), recDest);
        copied.push(chosen.name);
      }
    }
  }
  return copied;
}

/** Every evidence sha a catalog cites: locations and derivation inputs. */
export function citedEvidence(catalog: Catalog): Set<string> {
  const out = new Set<string>();
  for (const { provenance } of provenances(catalog)) {
    out.add(provenance.evidence as string);
    const inputs =
      (provenance.derivation as { inputs?: { evidence: string }[] } | undefined)?.inputs ?? [];
    for (const i of inputs) out.add(i.evidence);
  }
  return out;
}

/**
 * Lists in `evidence/superseded.json` the bodies the new catalog no longer cites, with the
 * stamp they were superseded at. That happens only when a value is replaced outright — a
 * price in a window that has not begun, an effort list, a status — never for a superseded
 * price, which stays as history. Evidence is never deleted, so the bytes behind every
 * released value, and the seed the reader tests are pinned to, stay in the tree.
 */
export function supersedeEvidence(root: string, catalog: Catalog, stamp: string): string[] {
  const cited = citedEvidence(catalog);
  const dir = join(root, "evidence");
  const listed = readSuperseded(dir);
  const added: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f]{64}$/.test(name) || cited.has(name) || listed.has(name)) continue;
    listed.set(name, stamp);
    added.push(name);
  }
  // A body cited again is no longer superseded.
  for (const sha of [...listed.keys()]) if (cited.has(sha)) listed.delete(sha);
  if (added.length > 0 || existsSync(join(dir, SUPERSEDED))) {
    const superseded = [...listed]
      .map(([sha256, since]) => ({ sha256, since }))
      .sort((a, b) => a.sha256.localeCompare(b.sha256));
    const doc = {
      $comment:
        "Evidence no catalog value cites any more, because the value was replaced outright. Evidence is never deleted (docs/trust-and-provenance.md).",
      superseded,
    };
    writeFileSync(join(dir, SUPERSEDED), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return added;
}

/** Writes the partition's catalog, hash and evidence into `root`. */
export function writeTree(
  root: string,
  baseline: Catalog,
  built: BuiltPartition,
  evidenceDirs: string[],
): { copied: string[]; superseded: string[] } {
  const copied = copyEvidence(root, evidenceNeeded(baseline, built.catalog), evidenceDirs);
  const superseded = supersedeEvidence(root, built.catalog, built.stamp);
  writeFileSync(join(root, "data", "catalog.json"), built.bytes);
  writeFileSync(join(root, "data", "catalog.json.sha256"), hashLine(built.bytes));
  // The README's coverage table is generated from the catalog; a new unit or tier changes it.
  const readme = join(root, "README.md");
  if (existsSync(readme)) {
    const text = readFileSync(readme, "utf8");
    const next = applyCoverage(text, renderCoverage(built.catalog));
    if (next !== text) writeFileSync(readme, next);
  }
  return { copied, superseded };
}
