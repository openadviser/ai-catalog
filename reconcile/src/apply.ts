// Applying a plan's groups to a catalog: one partition's tree.
//
// The tree is stamped with a provisional `publishedAt` P (the build instant, after every
// reading) and the next `version`. The release workflow restamps both, and every bound
// equal to P, when it publishes (docs/versioning.md). Changes apply by TIME-6:
//
//   undated change         the current entry ends at P; a new entry from the reading
//                          starts at P, with `dateRule: "undated"`;
//   future stated window   replaced in place (no past instant changes);
//   new fact               added as read, with no `validFrom` (a first reading);
//   effort / lifecycle     replaced from the reading.
//
// Nothing is ever removed. Each group is applied alone and validated (load-time
// validation); a group that would make the catalog invalid is not applied and is listed.
import type { Provenance } from "@openadviser/ai-catalog-readers-kit";
import { loadSchemas, type Validate } from "../../scripts/schemas.ts";
import { validateCatalog } from "../../scripts/validate-catalog.ts";
import type {
  Catalog,
  EntryIndex,
  Group,
  Item,
  Model,
  Offering,
  Op,
  Plan,
  RateEntry,
  RateReading,
} from "./model.ts";

/** The next data version after `current` for a release on the UTC date of `at`. */
export function nextVersion(current: string, at: string): string {
  const day = at.slice(0, 10).replace(/-/g, ".");
  const m = /^([0-9]{4}\.[0-9]{2}\.[0-9]{2})\.([1-9][0-9]*)$/.exec(current);
  if (m !== null && m[1] === day) return `${day}.${Number(m[2]) + 1}`;
  return `${day}.1`;
}

export function serialize(catalog: Catalog): Buffer {
  return Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, "utf8");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A catalog rate entry from a rate reading, in the catalog's member order. */
export function entryFromReading(
  r: RateReading,
  window: { from?: string; until?: string },
): RateEntry {
  const e: Record<string, unknown> = { component: r.component, disposition: r.fact.disposition };
  if (r.fact.disposition === "priced") {
    e.unit = r.fact.unit;
    e.per = r.fact.per;
    e.amount = r.fact.amount;
    e.currency = r.fact.currency;
  }
  if (r.condition !== undefined) e.condition = r.condition;
  if (window.from !== undefined) e.validFrom = window.from;
  if (window.until !== undefined) e.validUntil = window.until;
  if (r.fact.disposition !== "priced") e.reason = r.fact.reason;
  e.provenance = rateProvenance(
    r.provenance,
    window.from !== undefined && r.validFrom === undefined,
  );
  return e as unknown as RateEntry;
}

/** A reading's provenance as a rate provenance: `dateRule` is required, `undated` for TIME-6. */
function rateProvenance(p: Provenance, timeSix: boolean): Provenance {
  const out = clone(p);
  if (timeSix || out.dateRule === undefined) out.dateRule = "undated";
  // Member order as the catalog writes it.
  const ordered: Record<string, unknown> = {};
  for (const k of [
    "source",
    "url",
    "readAt",
    "reader",
    "evidence",
    "location",
    "derivation",
    "dateRule",
    "note",
  ]) {
    const v = (out as unknown as Record<string, unknown>)[k];
    if (v !== undefined) ordered[k] = v;
  }
  return ordered as unknown as Provenance;
}

function plainProvenance(p: Provenance): Provenance {
  const out = clone(p);
  const ordered: Record<string, unknown> = {};
  for (const k of [
    "source",
    "url",
    "readAt",
    "reader",
    "evidence",
    "location",
    "derivation",
    "dateRule",
    "note",
  ]) {
    const v = (out as unknown as Record<string, unknown>)[k];
    if (v !== undefined) ordered[k] = v;
  }
  return ordered as unknown as Provenance;
}

function findModel(c: Catalog, provider: string, modelId: string): Model {
  const m = c.providers.find((p) => p.id === provider)?.models.find((x) => x.id === modelId);
  if (m === undefined) throw new Error(`no model ${provider}/${modelId}`);
  return m;
}

function findOffering(c: Catalog, provider: string, modelId: string, tier: string): Offering {
  const o = findModel(c, provider, modelId).offerings.find((x) => x.tier === tier);
  if (o === undefined) throw new Error(`no offering ${provider}/${modelId}/${tier}`);
  return o;
}

/** Puts a model's members back in the catalog's order. */
function orderModel(m: Model): Model {
  const ordered: Record<string, unknown> = {};
  for (const k of [
    "id",
    "name",
    "aliases",
    "status",
    "retiresOn",
    "capabilities",
    "effort",
    "offerings",
    "provenance",
    "statusProvenance",
  ]) {
    const v = (m as unknown as Record<string, unknown>)[k];
    if (v !== undefined) ordered[k] = v;
  }
  return ordered as unknown as Model;
}

/**
 * The offering and position of a baseline entry in `c`, found by its exact content: an
 * earlier split in the same offering shifts positions, never an untouched entry's bytes.
 */
function locate(
  c: Catalog,
  op: { index: EntryIndex; entry: RateEntry },
): { o: Offering; at: number } {
  const o = c.providers[op.index.provider]?.models[op.index.model]?.offerings[op.index.offering];
  const want = JSON.stringify(op.entry);
  const at = o?.rates.findIndex((r) => JSON.stringify(r) === want) ?? -1;
  if (o === undefined || at < 0) throw new Error("the baseline entry is no longer in the catalog");
  return { o, at };
}

/** Applies one op to `c` in place, at stamp P. */
export function applyOp(c: Catalog, op: Op, stamp: string): void {
  switch (op.type) {
    case "rate-split": {
      const { o, at } = locate(c, op);
      const e = o.rates[at] as RateEntry;
      // Fill the members in their place: `validUntil` before `reason` and `provenance`.
      const rebuilt: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(e)) {
        if (k === "reason" || k === "provenance") continue;
        rebuilt[k] = v;
      }
      rebuilt.validUntil = stamp;
      if (e.reason !== undefined) rebuilt.reason = e.reason;
      rebuilt.provenance = e.provenance;
      o.rates[at] = rebuilt as unknown as RateEntry;
      o.rates.splice(at + 1, 0, entryFromReading(op.reading, { from: stamp }));
      return;
    }
    case "rate-replace": {
      // Only a window that has not begun may be replaced: once it is in force, its released
      // price applied to real calls. The release re-checks this at its own publishedAt.
      if (op.entry.validFrom === undefined || op.entry.validFrom <= stamp)
        throw new Error(
          `the window starting ${op.entry.validFrom ?? "(open)"} has begun by ${stamp}; it cannot be replaced`,
        );
      const { o, at } = locate(c, op);
      const w: { from?: string; until?: string } = {};
      if (op.reading.validFrom !== undefined) w.from = op.reading.validFrom;
      if (op.reading.validUntil !== undefined) w.until = op.reading.validUntil;
      o.rates[at] = entryFromReading(op.reading, w);
      return;
    }
    case "rate-add": {
      const o = findOffering(c, op.provider, op.modelId, op.tier);
      const w: { from?: string; until?: string } = {};
      if (op.reading.validFrom !== undefined) w.from = op.reading.validFrom;
      if (op.reading.validUntil !== undefined) w.until = op.reading.validUntil;
      o.rates.push(entryFromReading(op.reading, w));
      return;
    }
    case "condition-inputs": {
      const o = findOffering(c, op.provider, op.modelId, op.tier);
      const rebuilt: Offering = {
        tier: o.tier,
        conditionInputs: { inputTokens: op.inputs },
        rates: o.rates,
      };
      const m = findModel(c, op.provider, op.modelId);
      m.offerings[m.offerings.indexOf(o)] = rebuilt;
      return;
    }
    case "effort": {
      const m = findModel(c, op.provider, op.modelId);
      m.effort = {
        levels: op.reading.levels,
        default: op.reading.default,
        provenance: plainProvenance(op.reading.provenance),
      };
      replaceModel(c, op.provider, m);
      return;
    }
    case "lifecycle": {
      const m = findModel(c, op.provider, op.modelId);
      if (op.status !== undefined) m.status = op.status;
      if (op.retiresOn === null) delete m.retiresOn;
      else if (op.retiresOn !== undefined) m.retiresOn = op.retiresOn;
      m.statusProvenance = plainProvenance(op.provenance);
      replaceModel(c, op.provider, m);
      return;
    }
  }
}

function replaceModel(c: Catalog, provider: string, m: Model): void {
  const p = c.providers.find((x) => x.id === provider);
  if (p === undefined) return;
  const i = p.models.findIndex((x) => x.id === m.id);
  p.models[i] = orderModel(m);
}

export interface BuiltPartition {
  partition: "confirmed" | "review";
  stamp: string;
  version: string;
  catalog: Catalog;
  bytes: Buffer;
  applied: string[];
  /** Groups whose changes were not applied, and why. */
  skipped: { group: string; error: string }[];
  /** Groups of the partition that carry no tree change (findings only). */
  bodyOnly: string[];
}

/** Builds one partition's catalog, group by group. */
export function buildPartition(
  baseline: Catalog,
  plan: Plan,
  partition: "confirmed" | "review",
  stamp: string,
  validate: Validate = loadSchemas(),
): BuiltPartition {
  let current = clone(baseline);
  current.publishedAt = stamp;
  current.version = nextVersion(baseline.version, stamp);
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const applied: string[] = [];
  const skipped: { group: string; error: string }[] = [];
  const bodyOnly: string[] = [];
  const groups: Group[] = plan.groups.filter((g) => g.partition === partition);
  for (const g of groups) {
    const ops = g.items.map((id) => byId.get(id) as Item).filter((i) => i.op !== undefined);
    if (ops.length === 0) {
      bodyOnly.push(g.id);
      continue;
    }
    const candidate = clone(current);
    try {
      for (const item of ops) applyOp(candidate, item.op as Op, stamp);
      const error = validateCatalog(serialize(candidate), validate);
      if (error !== undefined) throw new Error(`${error.code} at ${error.path}: ${error.message}`);
      current = candidate;
      applied.push(g.id);
    } catch (error) {
      skipped.push({ group: g.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    partition,
    stamp,
    version: current.version,
    catalog: current,
    bytes: serialize(current),
    applied,
    skipped,
    bodyOnly,
  };
}

/** Every provenance object in a catalog, serialized, for the evidence diff. */
function provenanceSet(
  value: unknown,
  out = new Map<string, Provenance>(),
): Map<string, Provenance> {
  if (Array.isArray(value)) {
    for (const v of value) provenanceSet(v, out);
    return out;
  }
  if (typeof value !== "object" || value === null) return out;
  for (const [k, v] of Object.entries(value)) {
    if ((k === "provenance" || k === "statusProvenance") && typeof v === "object" && v !== null) {
      out.set(JSON.stringify(v), v as Provenance);
    } else {
      provenanceSet(v, out);
    }
  }
  return out;
}

export interface EvidenceNeed {
  sha256: string;
  /** Retrieval records to carry: the (url, readAt) a provenance cites. */
  records: { url: string; readAt?: string }[];
}

/** The evidence bodies and records the built tree cites that the baseline does not. */
export function evidenceNeeded(baseline: Catalog, built: Catalog): EvidenceNeed[] {
  const before = provenanceSet(baseline);
  const needs = new Map<string, EvidenceNeed>();
  const need = (sha: string, url: string, readAt?: string) => {
    const n = needs.get(sha) ?? { sha256: sha, records: [] };
    if (!n.records.some((r) => r.url === url && r.readAt === readAt)) {
      const rec: { url: string; readAt?: string } = { url };
      if (readAt !== undefined) rec.readAt = readAt;
      n.records.push(rec);
    }
    needs.set(sha, n);
  };
  for (const [key, p] of provenanceSet(built)) {
    if (before.has(key)) continue;
    need(p.evidence, p.url, p.readAt);
    for (const input of p.derivation?.inputs ?? []) need(input.evidence, input.url);
  }
  return [...needs.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
}
