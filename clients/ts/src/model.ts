// The validated catalog, in the form pricing reads it.

import type { Rational } from "./decimal.ts";
import type { Component, Currency, EffortLevel, Meter, ProviderId, Tier, Unit } from "./vocab.ts";

/** A half-open integer interval (gt, lte] over `inputTokens` (COND-1). `null` is unbounded. */
export interface Condition {
  readonly gt: number | null;
  readonly lte: number | null;
}

/** One rate entry of a catalog, with its window. */
export interface RateEntry {
  readonly component: Component;
  readonly disposition: "priced" | "inapplicable" | "unsupported";
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly fromMs: number | null;
  readonly untilMs: number | null;
  /** Only when priced. */
  readonly priced:
    | {
        readonly unit: Unit;
        readonly per: number;
        /** The amount in canonical form (NUM-4). */
        readonly amount: string;
        readonly rate: Rational;
      }
    | undefined;
}

export interface Schedule {
  readonly condition: Condition | null;
  /** Every entry of the schedule, by component. */
  readonly entries: ReadonlyMap<Component, readonly RateEntry[]>;
}

export interface Offering {
  readonly tier: Tier;
  readonly currency: Currency;
  /** The `inputTokens` components, sorted by code point; `null` for an offering without conditions. */
  readonly conditionInputs: readonly Component[] | null;
  /** Sorted by lower bound. */
  readonly schedules: readonly Schedule[];
}

export interface Alias {
  readonly id: string;
  readonly status: "active" | "retired";
}

export interface Effort {
  readonly levels: readonly EffortLevel[];
  readonly default: EffortLevel | null;
}

export interface Model {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly Alias[];
  readonly status: "preview" | "available" | "deprecated" | "retired";
  readonly retiresOn: string | null;
  readonly capabilities: readonly string[];
  readonly effort: Effort | null;
  readonly offerings: ReadonlyMap<Tier, Offering>;
}

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly pricingUrls: readonly string[];
  readonly models: readonly Model[];
  readonly modelsById: ReadonlyMap<string, Model>;
  readonly modelsByAlias: ReadonlyMap<string, Model>;
}

export interface CatalogData {
  readonly schemaVersion: string;
  readonly version: string;
  readonly publishedAt: string;
  readonly sha256: string;
  readonly providers: ReadonlyMap<string, Provider>;
}

export type { Meter };
