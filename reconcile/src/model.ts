// The reconciler's vocabulary: whole price facts, their identity keys, the catalog's
// current facts, exact decimal ratios, the policy and the plan it produces.
//
// A fact is (provider, modelId, tier, component, condition, window) → value, where the
// value is the disposition with unit, per, currency and amount, or the reason. Facts are
// compared whole, never field by field (plan §11.2.3).
import type {
  Condition,
  EffortReading,
  FactValue,
  Instant,
  ModelReading,
  Provenance,
  RateReading,
  Reading,
  Reason,
} from "@openadviser/ai-catalog-readers-kit";

// ---- the catalog, as JSON ----

export interface RateEntry {
  component: string;
  disposition: "priced" | "inapplicable" | "unsupported";
  unit?: string;
  per?: number;
  amount?: string;
  currency?: string;
  condition?: Condition;
  validFrom?: Instant;
  validUntil?: Instant;
  reason?: string;
  provenance: Provenance;
}

export interface Offering {
  tier: string;
  conditionInputs?: { inputTokens: string[] };
  rates: RateEntry[];
}

export interface Effort {
  levels: string[];
  default: string | null;
  provenance: Provenance;
}

export interface Model {
  id: string;
  name: string;
  aliases: unknown[];
  status: string;
  retiresOn?: string;
  capabilities: string[];
  effort?: Effort;
  offerings: Offering[];
  provenance: Provenance;
  statusProvenance?: Provenance;
}

export interface Provider {
  id: string;
  name: string;
  pricingUrls: string[];
  models: Model[];
}

export interface Catalog {
  schemaVersion: string;
  version: string;
  publishedAt: Instant;
  providers: Provider[];
}

// ---- identity ----

/** A half-open validity window as the fact is identified: stated bounds only. */
export interface Window {
  from?: Instant;
  until?: Instant;
}

export interface Subject {
  provider: string;
  modelId?: string;
  tier?: string;
  component?: string;
  condition?: Condition;
  window?: Window;
}

export function conditionKey(condition: Condition | undefined): string {
  if (condition === undefined) return "";
  const c = condition.inputTokens;
  return `gt=${c.gt ?? ""},lte=${c.lte ?? ""}`;
}

export function windowKey(window: Window): string {
  return `${window.from ?? ""}..${window.until ?? ""}`;
}

export function factKey(s: {
  provider: string;
  modelId: string;
  tier: string;
  component: string;
  condition?: Condition | undefined;
  window: Window;
}): string {
  return [
    s.provider,
    s.modelId,
    s.tier,
    s.component,
    conditionKey(s.condition),
    windowKey(s.window),
  ].join("|");
}

/** The group of dependent facts: every component and schedule of one offering, in one window. */
export function rateGroup(provider: string, modelId: string, tier: string, window: Window): string {
  return `rate|${provider}|${modelId}|${tier}|${windowKey(window)}`;
}

export function effortGroup(provider: string, modelId: string): string {
  return `effort|${provider}|${modelId}`;
}

export function lifecycleGroup(provider: string, modelId: string): string {
  return `lifecycle|${provider}|${modelId}`;
}

/** A reading's window: its stated bounds. */
export function readingWindow(r: RateReading): Window {
  const w: Window = {};
  if (r.validFrom !== undefined) w.from = r.validFrom;
  if (r.validUntil !== undefined) w.until = r.validUntil;
  return w;
}

/**
 * A catalog entry's identifying window. A `validFrom` set by TIME-6 for an undated change
 * (`dateRule: "undated"`) was never stated by the source, so it is not part of the
 * identity: the undated reading of the same price matches the entry it produced.
 */
export function entryWindow(e: RateEntry): Window {
  const w: Window = {};
  if (e.validFrom !== undefined && e.provenance.dateRule !== "undated") w.from = e.validFrom;
  if (e.validUntil !== undefined) w.until = e.validUntil;
  return w;
}

export function entryValue(e: RateEntry): FactValue {
  if (e.disposition === "priced") {
    return {
      disposition: "priced",
      unit: e.unit as string,
      per: e.per as number,
      amount: e.amount as string,
      currency: e.currency as string,
    };
  }
  return { disposition: e.disposition, reason: e.reason as string };
}

/** Where an entry sits in the catalog. */
export interface EntryIndex {
  provider: number;
  model: number;
  offering: number;
  rate: number;
}

/** A catalog rate entry that is current at the reconcile instant, with its identity. */
export interface CatalogFact {
  key: string;
  group: string;
  provider: string;
  modelId: string;
  tier: string;
  component: string;
  condition?: Condition;
  window: Window;
  entry: RateEntry;
  index: EntryIndex;
}

/**
 * The catalog's current rate facts: every entry whose window has not ended at `now`.
 * An entry with `validUntil <= now` is history: a source naturally stops stating a past
 * window, so history is never reconciled and never "tracked, not read".
 */
export function currentFacts(catalog: Catalog, now: Instant): CatalogFact[] {
  const out: CatalogFact[] = [];
  catalog.providers.forEach((p, pi) => {
    p.models.forEach((m, mi) => {
      m.offerings.forEach((o, oi) => {
        o.rates.forEach((e, ri) => {
          if (e.validUntil !== undefined && e.validUntil <= now) return;
          const window = entryWindow(e);
          const fact: CatalogFact = {
            key: factKey({
              provider: p.id,
              modelId: m.id,
              tier: o.tier,
              component: e.component,
              condition: e.condition,
              window,
            }),
            group: rateGroup(p.id, m.id, o.tier, window),
            provider: p.id,
            modelId: m.id,
            tier: o.tier,
            component: e.component,
            window,
            entry: e,
            index: { provider: pi, model: mi, offering: oi, rate: ri },
          };
          if (e.condition !== undefined) fact.condition = e.condition;
          out.push(fact);
        });
      });
    });
  });
  return out;
}

// ---- exact decimals ----

interface Scaled {
  num: bigint;
  scale: number;
}

export function parseDecimal(amount: string): Scaled {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(amount);
  if (m === null) throw new Error(`${JSON.stringify(amount)} is not a decimal amount`);
  const frac = m[2] ?? "";
  return { num: BigInt(`${m[1]}${frac}`), scale: frac.length };
}

/** a/pa compared with b/pb exactly: negative, zero or positive. */
export function compareRates(a: string, pa: number, b: string, pb: number): number {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  const xn = x.num * 10n ** BigInt(scale - x.scale) * BigInt(pb);
  const yn = y.num * 10n ** BigInt(scale - y.scale) * BigInt(pa);
  return xn < yn ? -1 : xn > yn ? 1 : 0;
}

export function isZero(amount: string): boolean {
  return parseDecimal(amount).num === 0n;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export interface Ratio {
  /** max(new/old, old/new) as a reduced fraction, "3/2". */
  fraction: string;
  /** The same to four decimals, rounded down, for people. */
  decimal: string;
  within: boolean;
}

/**
 * The change factor of plan §11.2.4: max(new/old, old/new) on two positive amounts of the
 * same unit, per and currency, compared exactly with `factor`. Equal to the factor counts
 * as within.
 */
export function changeRatio(before: string, after: string, factor: string): Ratio {
  const a = parseDecimal(before);
  const b = parseDecimal(after);
  if (a.num === 0n || b.num === 0n) throw new Error("the factor applies to positive amounts only");
  const scale = Math.max(a.scale, b.scale);
  const an = a.num * 10n ** BigInt(scale - a.scale);
  const bn = b.num * 10n ** BigInt(scale - b.scale);
  const [hi, lo] = an >= bn ? [an, bn] : [bn, an];
  const g = gcd(hi, lo);
  const f = parseDecimal(factor);
  // hi/lo <= f.num/10^f.scale  ⇔  hi * 10^f.scale <= f.num * lo
  const within = hi * 10n ** BigInt(f.scale) <= f.num * lo;
  const q = (hi * 10000n) / lo;
  const decimal = `${q / 10000n}.${(q % 10000n).toString().padStart(4, "0")}`;
  return { fraction: `${hi / g}/${lo / g}`, decimal, within };
}

/** Two fact values are the same price: same disposition and, when priced, the same rate. */
export function sameValue(a: FactValue, b: FactValue): boolean {
  if (a.disposition !== b.disposition) return false;
  if (a.disposition === "priced" && b.disposition === "priced") {
    return (
      a.unit === b.unit &&
      a.per === b.per &&
      a.currency === b.currency &&
      compareRates(a.amount, 1, b.amount, 1) === 0
    );
  }
  return (a as { reason: string }).reason === (b as { reason: string }).reason;
}

/** The same price per unit, whatever the `per`: a cross-check states its own denomination. */
export function samePrice(a: FactValue, b: FactValue): boolean {
  if (a.disposition !== "priced" || b.disposition !== "priced") return false;
  return (
    a.unit === b.unit &&
    a.currency === b.currency &&
    compareRates(a.amount, a.per, b.amount, b.per) === 0
  );
}

// ---- the policy ----

export interface Policy {
  factor: string;
  crossChecks: { minIndependent: number };
}

export interface Acknowledgement {
  /** The observation key (`observationKey`): changes whenever the observation's content does. */
  key: string;
  provider: string;
  source?: string;
  modelId?: string;
  tier?: string;
  component?: string;
  reasons: Reason[];
  note?: string;
  /** The cited excerpt, when the observation has one. */
  excerpt?: string;
  /** Why a person accepted it as standing. */
  reason: string;
  /** The date it was acknowledged, YYYY-MM-DD. */
  acknowledgedOn: string;
}

// ---- the plan ----

export type ChangeClass = "confirmed" | "single-source" | "conflict" | "needs-review";

export interface CrossCheckEvaluation {
  source: string;
  lineage: string[];
  reading: RateReading;
  eligible: boolean;
  /** Why it is not eligible. */
  why?: string;
  agrees: boolean;
}

export type Op =
  | { type: "rate-split"; index: EntryIndex; entry: RateEntry; reading: RateReading }
  | { type: "rate-replace"; index: EntryIndex; entry: RateEntry; reading: RateReading }
  | { type: "rate-add"; provider: string; modelId: string; tier: string; reading: RateReading }
  | { type: "condition-inputs"; provider: string; modelId: string; tier: string; inputs: string[] }
  | { type: "effort"; provider: string; modelId: string; reading: EffortReading }
  | {
      type: "lifecycle";
      provider: string;
      modelId: string;
      status?: string;
      /** A date to set, or null to remove. Undefined leaves it. */
      retiresOn?: string | null;
      provenance: Provenance;
    };

/** What a change or finding is about, for people and for grouping. */
export type ItemKind =
  | "amount"
  | "structural"
  | "new-fact"
  | "unpriced-reason"
  | "condition-inputs"
  | "tracked-not-read"
  | "reader"
  | "excerpt"
  | "official-disagree"
  | "in-force-window"
  | "effort"
  | "status"
  | "retires-on";

export interface Item {
  id: string;
  kind: ItemKind;
  class: ChangeClass;
  reasons: Reason[];
  subject: Subject;
  /** The rate, effort or lifecycle group it belongs to; absent for a provider- or model-wide finding. */
  group?: string;
  /** For a finding that blocks more than its own group: what it blocks. */
  blocks?: { provider: string; modelId?: string; tier?: string };
  before?: { value: unknown; provenance?: Provenance };
  after?: { value: unknown; provenance?: Provenance };
  official: Reading[];
  crossChecks: CrossCheckEvaluation[];
  ratio?: Ratio;
  /** How the change is applied to a tree; absent when nothing is applied (a finding). */
  op?: Op;
}

export interface Group {
  id: string;
  provider: string;
  modelId: string;
  kind: "rate" | "effort" | "lifecycle";
  partition: "confirmed" | "review";
  items: string[];
  /** Why the group waits for a person, when it does. */
  blockers: string[];
}

export interface UnreadableSource {
  source: string;
  provider: string;
  modelId?: string;
  reasons: Reason[];
}

export interface Informational {
  source: string;
  provider: string;
  kind: Reading["kind"];
  outcome: Reading["outcome"];
  modelId?: string;
  tier?: string;
  component?: string;
  reasons: Reason[];
  note?: string;
}

export interface ReportSummary {
  source: string;
  role: "source-of-truth" | "cross-check";
  lineage: string[];
  mode: "evidence" | "live";
  readings: number;
  sources: { source: string; url: string; evidence: string; retrievedAt: Instant }[];
}

export interface Plan {
  /**
   * The reconcile instant: the later of the readings' instant and the baseline's publishedAt.
   * History and in-force windows are judged at it.
   */
  now: Instant;
  baseline: { version: string; publishedAt: Instant; sha256: string };
  policy: Policy;
  reports: ReportSummary[];
  items: Item[];
  groups: Group[];
  unreadable: UnreadableSource[];
  acknowledged: { acknowledgement: Acknowledgement; observation: Informational }[];
  informational: Informational[];
  unchanged: Record<string, number>;
}

export type { EffortReading, ModelReading, RateReading, Reading };
