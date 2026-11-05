// The reading types a reader returns.
//
// A reader turns a provider's official page or API response into readings, never into a
// wrong price. The central type is the price fact of plan §11.2.3: a fact is
//
//   (provider, modelId, tier, component, unit, per, currency, condition, window) → amount
//
// compared whole. A reading also carries the provenance check-data.ts verifies: the
// evidence sha256, a byte offset and the exact excerpt there.
//
// Outcomes:
//   ok            — the value was read and understood;
//   needs-review  — the source read fine but holds something the reader does not
//                   understand or expect in tracked scope (an unknown column, feature,
//                   footnote, tier or date, a missing model, an unparseable amount);
//   unreadable    — the source could not be read at all: no bytes, undecodable, a
//                   document of the wrong kind, a failed API call. Never a zero or a guess;
//   not-configured — the source was not read because it is not configured: an optional
//                   API key is absent. It produces no issue, no finding and no change;
//                   the run summary lists it.

/** An instant in RFC 3339 UTC, whole seconds (TIME-1). */
export type Instant = string;
/** A calendar date, YYYY-MM-DD (TIME-1). */
export type Date = string;
/** The effort levels of EFF-1, in schema order. */
export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Outcome = "ok" | "needs-review" | "unreadable" | "not-configured";

/** Why a reading is not `ok`. `code` is a stable slug; `message` is for people. */
export interface Reason {
  code: string;
  message: string;
}

/** The rule a reader applied to turn a source's date into a window bound (TIME-5). */
export type DateRule = "undated" | "date-only-utc" | "date-only-zoned" | "stated-instant";

/** A half-open interval over one named input (COND-1). */
export interface Condition {
  inputTokens: { gt?: number; lte?: number };
}

/** The component list an `inputTokens` condition is summed over (COND-2). */
export interface ConditionInputs {
  inputTokens: string[];
}

/** A byte span inside an evidence body. `excerpt` is exactly the bytes at `offset`. */
export interface Anchor {
  offset: number;
  excerpt: string;
}

/** Where a value sits in its evidence: a human path plus the exact bytes. */
export interface Location {
  path: string;
  offset: number;
  excerpt: string;
  anchors?: Anchor[];
}

/** One cited input of a derivation. */
export interface DerivationInput extends Anchor {
  evidence: string;
  url: string;
  path: string;
}

/** A value the source states as a rule over other stated values. Every input is cited. */
export interface Derivation {
  formula: string;
  inputs: DerivationInput[];
}

/** Where a value was read: the source, the page, when, by what, and its evidence. */
export interface Provenance {
  source: string;
  url: string;
  readAt: Instant;
  /** `<reader>@<version>`, or `manual` for a value entered by hand. */
  reader: string;
  evidence: string;
  location?: Location;
  derivation?: Derivation;
  dateRule?: DateRule;
  note?: string;
}

/** A priced fact: the complete identity of plan §11.2.3 plus the amount. */
export interface PricedFact {
  disposition: "priced";
  unit: string;
  per: number;
  amount: string;
  currency: string;
}

/** A fact the source publishes but the schema cannot price, with the stated reason. */
export interface UnpricedFact {
  disposition: "inapplicable" | "unsupported";
  reason: string;
}

export type FactValue = PricedFact | UnpricedFact;

/** A rate reading: one price fact, or the reason it is not a price. */
export interface RateReading {
  kind: "rate";
  outcome: Outcome;
  reasons: Reason[];
  provider: string;
  modelId: string;
  /** The tier id `<provider>:<name>`, named as the source names the table it was read from. */
  tier: string;
  component: string;
  fact: FactValue;
  condition?: Condition;
  /** The offering's `inputTokens` input, recorded where the source states it (COND-2). */
  conditionInputs?: string[];
  validFrom?: Instant;
  validUntil?: Instant;
  /**
   * A cross-check's own revision of the stated value: the instant its maintainers last
   * revised or checked the entry, as the tracker publishes it. Sources of truth leave it
   * unset. The reconciler counts a cross-check only when this postdates the catalog's
   * recorded observation of the value it would confirm (plan §11.2.3).
   */
  revisedAt?: Instant;
  provenance: Provenance;
}

/** A model reading: identity and lifecycle, as far as the source states them. */
export interface ModelReading {
  kind: "model";
  outcome: Outcome;
  reasons: Reason[];
  provider: string;
  modelId: string;
  name?: string;
  status?: "preview" | "available" | "deprecated" | "retired";
  retiresOn?: Date;
  /** A deprecation or retirement notice the source states; lifecycle evidence. */
  notice?: string;
  provenance: Provenance;
  statusProvenance?: Provenance;
}

/** An effort reading: the levels a model accepts and its default, where stated. */
export interface EffortReading {
  kind: "effort";
  outcome: Outcome;
  reasons: Reason[];
  provider: string;
  modelId: string;
  levels: EffortLevel[];
  default: EffortLevel | null;
  provenance: Provenance;
}

/**
 * Everything else worth recording: a tier the schema does not model on a tracked model,
 * a priced modifier the reader understands but the tier excludes, a model seen on a
 * page, an unreadable page. Carries the partial identity it applies to.
 */
export interface ObservationReading {
  kind: "observation";
  outcome: Outcome;
  reasons: Reason[];
  provider: string;
  modelId?: string;
  tier?: string;
  component?: string;
  source?: string;
  note?: string;
  provenance?: Provenance;
}

export type Reading = RateReading | ModelReading | EffortReading | ObservationReading;

/** What one `npm run read` emits. */
export interface ReadReport {
  provider: string;
  mode: "evidence" | "live";
  /**
   * The source's role, and the upstreams its data comes from. A provider's own pages are
   * the source of truth; a third-party tracker is a cross-check. Two sources whose
   * lineages share an upstream count as one when the reconciler counts independent
   * agreement.
   */
  role?: "source-of-truth" | "cross-check";
  lineage?: string[];
  /** Every body read, in the order the reader consumed it. */
  sources: {
    source: string;
    url: string;
    evidence: string;
    retrievedAt: Instant;
  }[];
  /** The account scope a model list was read with, when an API was called. */
  accountScope?: Record<string, string>;
  readings: Reading[];
}

/** The models and tiers the catalog tracks for one provider, from `data/catalog.json`. */
export interface TrackedScope {
  provider: string;
  /** By model id. `offerings` holds the tier ids with a catalog offering. */
  models: Map<
    string,
    {
      status: string;
      hasEffort: boolean;
      offerings: Set<string>;
      /** By tier id: the components the catalog's rates state. */
      components: Map<string, Set<string>>;
    }
  >;
}

/** Builds the tracked scope for `provider` out of a parsed `data/catalog.json`. */
export function trackedScope(catalog: unknown, provider: string): TrackedScope {
  const scope: TrackedScope = { provider, models: new Map() };
  if (typeof catalog !== "object" || catalog === null) return scope;
  const providers = (catalog as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return scope;
  for (const p of providers) {
    if (typeof p !== "object" || p === null || (p as { id?: unknown }).id !== provider) continue;
    const models = (p as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      if (typeof m !== "object" || m === null) continue;
      const model = m as { id?: unknown; status?: unknown; effort?: unknown; offerings?: unknown };
      if (typeof model.id !== "string") continue;
      const offerings = new Set<string>();
      const components = new Map<string, Set<string>>();
      if (Array.isArray(model.offerings)) {
        for (const o of model.offerings) {
          const offering = o as { tier?: unknown; rates?: unknown };
          const tier = offering.tier;
          if (typeof tier !== "string") continue;
          offerings.add(tier);
          if (Array.isArray(offering.rates)) {
            for (const r of offering.rates) {
              const component = (r as { component?: unknown }).component;
              if (typeof component !== "string") continue;
              let set = components.get(tier);
              if (set === undefined) {
                set = new Set();
                components.set(tier, set);
              }
              set.add(component);
            }
          }
        }
      }
      scope.models.set(model.id, {
        status: typeof model.status === "string" ? model.status : "available",
        hasEffort: model.effort !== undefined,
        offerings,
        components,
      });
    }
  }
  return scope;
}

/** A reader's identity, written into every provenance as `<name>@<version>`. */
export interface ReaderId {
  name: string;
  version: string;
}

export function readerTag(id: ReaderId): string {
  return `${id.name}@${id.version}`;
}
