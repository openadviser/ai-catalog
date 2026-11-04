// The excerpt re-check of plan §11.6: provenance must cite what was read.
//
// For every reading the reconciler uses, the bytes at the cited offset must be the
// excerpt, in the evidence the run holds, and the excerpt must contain the value it
// supports — not merely exist somewhere in the page:
//
//   priced rate     the amount, as a number token ("2.50" matches "2.5" and "$2.50");
//   derived rate    the formula's operands multiply exactly to the amount, the formula
//                   states that amount, and each operand appears in some cited input
//                   (as a number, "Nx", or "P%" / "P percent" for N = P/100);
//   effort          every level and the default, in the excerpt or its anchors;
//   model           its id or its name;
//   status          a status other than "available" names itself in the status excerpt;
//   retiresOn       the date, as YYYY-MM-DD or "Month D, YYYY".
import type { Provenance, Reason } from "@openadviser/ai-catalog-readers-kit";
import type { EffortReading, ModelReading, RateReading, Reading } from "./model.ts";
import { compareRates, parseDecimal } from "./model.ts";

export type BodyLookup = (sha256: string) => Buffer | undefined;

const NUMBER = /(?<![0-9.])[0-9][0-9,]*(?:\.[0-9]+)?(?![0-9])/g;

/** Every number token in `text`, thousands separators removed. */
export function numberTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const token = m[0].replace(/,/g, "");
    if (/^[0-9]+(\.[0-9]+)?$/.test(token)) out.push(token);
  }
  return out;
}

export function containsAmount(text: string, amount: string): boolean {
  return numberTokens(text).some((t) => compareRates(t, 1, amount, 1) === 0);
}

function bytesAt(
  lookup: BodyLookup,
  sha: string,
  offset: number,
  excerpt: string,
): string | undefined {
  const body = lookup(sha);
  if (body === undefined) return `evidence ${sha.slice(0, 12)} is not held by this run`;
  const want = Buffer.from(excerpt, "utf8");
  if (!body.subarray(offset, offset + want.length).equals(want)) {
    return `the bytes at offset ${offset} of ${sha.slice(0, 12)} are not the excerpt`;
  }
  return undefined;
}

/** The byte-level check of a provenance: location, anchors and derivation inputs. */
export function checkBytes(p: Provenance, lookup: BodyLookup): string[] {
  const problems: string[] = [];
  const loc = p.location;
  if (loc !== undefined) {
    const a = bytesAt(lookup, p.evidence, loc.offset, loc.excerpt);
    if (a !== undefined) problems.push(a);
    for (const anchor of loc.anchors ?? []) {
      const b = bytesAt(lookup, p.evidence, anchor.offset, anchor.excerpt);
      if (b !== undefined) problems.push(`anchor: ${b}`);
    }
  }
  for (const input of p.derivation?.inputs ?? []) {
    const c = bytesAt(lookup, input.evidence, input.offset, input.excerpt);
    if (c !== undefined) problems.push(`derivation input: ${c}`);
  }
  if (loc === undefined && p.derivation === undefined)
    problems.push("no location and no derivation");
  return problems;
}

function multiply(values: string[]): { num: bigint; scale: number } {
  let num = 1n;
  let scale = 0;
  for (const v of values) {
    const d = parseDecimal(v);
    num *= d.num;
    scale += d.scale;
  }
  return { num, scale };
}

function sameScaled(a: { num: bigint; scale: number }, amount: string): boolean {
  const b = parseDecimal(amount);
  const s = Math.max(a.scale, b.scale);
  return a.num * 10n ** BigInt(s - a.scale) === b.num * 10n ** BigInt(s - b.scale);
}

/** An operand appears in a cited input: as a number, "Nx", or as a percentage. */
function operandCited(operand: string, excerpts: string[]): boolean {
  for (const text of excerpts) {
    if (containsAmount(text, operand)) return true;
    for (const m of text.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*(?:%|percent\b)/g)) {
      const pct = parseDecimal(m[1] as string);
      // P% = P/100
      if (sameScaled({ num: pct.num, scale: pct.scale + 2 }, operand)) return true;
    }
  }
  return false;
}

/** The derivation check: the formula's product is the amount and every operand is cited. */
export function checkDerivation(r: RateReading): string[] {
  const d = r.provenance.derivation;
  if (d === undefined || r.fact.disposition !== "priced") return [];
  const amount = r.fact.amount;
  const eq = d.formula.indexOf("=");
  if (eq < 0) return ["the derivation formula states no result"];
  const lhs = d.formula.slice(0, eq).replace(/\([^)]*\)/g, " ");
  const rhs = d.formula.slice(eq + 1);
  const result = numberTokens(rhs)[0];
  if (result === undefined || compareRates(result, 1, amount, 1) !== 0)
    return [`the derivation formula states ${result ?? "no result"}, not the amount ${amount}`];
  const operands = numberTokens(lhs);
  if (operands.length < 2) return ["the derivation formula has fewer than two operands"];
  if (!sameScaled(multiply(operands), amount))
    return [`the derivation's operands ${operands.join(" × ")} do not multiply to ${amount}`];
  const excerpts = d.inputs.map((i) => i.excerpt);
  const missing = operands.filter((o) => !operandCited(o, excerpts));
  return missing.length === 0
    ? []
    : [`the derivation operand(s) ${missing.join(", ")} appear in no cited input`];
}

function texts(p: Provenance | undefined): string[] {
  if (p?.location === undefined) return [];
  return [p.location.excerpt, ...(p.location.anchors ?? []).map((a) => a.excerpt)];
}

function hasWord(haystack: string, word: string): boolean {
  return new RegExp(`(?<![a-z])${word}(?![a-z])`, "i").test(haystack);
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function dateForms(date: string): string[] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [date, `${MONTHS[m - 1]} ${d}, ${y}`];
}

/** The value check of one reading against its excerpt. Empty means it passes. */
export function checkValue(r: Reading): string[] {
  if (r.kind === "rate") {
    if (r.fact.disposition !== "priced") return [];
    if (r.provenance.derivation !== undefined) return checkDerivation(r);
    const excerpt = r.provenance.location?.excerpt ?? "";
    return containsAmount(excerpt, r.fact.amount)
      ? []
      : [`the excerpt does not contain the amount ${r.fact.amount}`];
  }
  if (r.kind === "effort") return checkEffort(r);
  if (r.kind === "model") return checkModel(r);
  return [];
}

function checkEffort(r: EffortReading): string[] {
  const all = texts(r.provenance).join("\n");
  const missing: string[] = r.levels.filter((l) => !hasWord(all, l));
  if (r.default !== null && !hasWord(all, r.default)) missing.push(`default ${r.default}`);
  return missing.length === 0 ? [] : [`the excerpt does not name ${missing.join(", ")}`];
}

function checkModel(r: ModelReading): string[] {
  const problems: string[] = [];
  const main = texts(r.provenance).join("\n");
  if (!main.includes(r.modelId) && (r.name === undefined || !main.includes(r.name)))
    problems.push(`the excerpt names neither ${r.modelId} nor its name`);
  const status = texts(r.statusProvenance ?? r.provenance).join("\n");
  if (r.status !== undefined && r.status !== "available" && !hasWord(status, r.status))
    problems.push(`the status excerpt does not say "${r.status}"`);
  if (r.retiresOn !== undefined && !dateForms(r.retiresOn).some((f) => status.includes(f)))
    problems.push(`the status excerpt does not state ${r.retiresOn}`);
  return problems;
}

/** Both checks; each problem is a `needs-review` reason with the code "excerpt". */
export function excerptReasons(r: Reading, lookup: BodyLookup): Reason[] {
  if (r.kind === "observation") return [];
  const problems = [...checkBytes(r.provenance, lookup)];
  if (r.kind === "model" && r.statusProvenance !== undefined)
    problems.push(...checkBytes(r.statusProvenance, lookup).map((p) => `status: ${p}`));
  problems.push(...checkValue(r));
  return problems.map((message) => ({ code: "excerpt", message }));
}
