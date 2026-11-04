// Section 12: `price`, and BASIS-3: `priceFromBasis`.

import { type BasisEntry, buildBasis, readBasis } from "./basis.ts";
import { type Catalog, dataOf } from "./catalog.ts";
import { figures, formatExact } from "./decimal.ts";
import { type BuiltSchedule, choose, type Slot } from "./engine.ts";
import { fail } from "./errors.ts";
import type { Offering, RateEntry } from "./model.ts";
import { parseInstantAt } from "./time.ts";
import { readUsage, type UsageReport } from "./usage.ts";
import { type Component, type Currency, exponentOf, unitInfo } from "./vocab.ts";

export interface PriceRequest {
  provider: string;
  /** A model id or one of its aliases. */
  modelId: string;
  tier: string;
  /** The instant to price at: RFC 3339 UTC, up to three fractional digits. */
  at: string;
  usage: UsageReport;
  /** Which figure the consumer reserves or settles with. It is written into the basis (ROUND-4). */
  settlement: "estimate" | "booked";
  /** COND-7: reserve before the call, when the input cannot be bounded. */
  conditionInputs?: { inputTokens: "unknown" };
}

export interface PriceResult {
  provider: string;
  /** The resolved model id. */
  modelId: string;
  tier: string;
  currency: Currency;
  /** The index of the chosen schedule in the basis's `schedules`. */
  schedule: number;
  /** The exact total, `N/D` in lowest terms (NUM-5). */
  exact: string;
  /** The total rounded half-up to the currency's minor unit, once (ROUND-2). */
  estimate: string;
  /** `estimate`, but a positive total books at least one minor unit (ROUND-3). */
  booked: string;
  /** The canonical basis (BASIS-2), as text. Its UTF-8 bytes are what `basisSha256` hashes. */
  basis: string;
  basisSha256: string;
}

export interface ReplayResult {
  currency: Currency;
  schedule: number;
  exact: string;
  estimate: string;
  booked: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** PRICE-1: `conditionInputs` is absent or exactly `{ inputTokens: "unknown" }`. */
function readUnknownInput(value: unknown): boolean {
  if (value === undefined) return false;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    (value as { inputTokens?: unknown }).inputTokens !== "unknown"
  ) {
    return fail("invalid-request", 'conditionInputs is absent or { "inputTokens": "unknown" }');
  }
  return true;
}

function inForce(entries: readonly RateEntry[], at: number): RateEntry | undefined {
  return entries.find(
    (e) => (e.fromMs === null || e.fromMs <= at) && (e.untilMs === null || at < e.untilMs),
  );
}

/**
 * Prices a call (PRICE-2). Everything is exact; the one rounding is on the total. Refuses with the
 * first refusal met, in the order of PRICE-2.
 */
export function price(catalog: Catalog, request: PriceRequest): PriceResult {
  const data = dataOf(catalog);

  // 1. The request, then the instant.
  if (!isRecord(request)) return fail("invalid-request", "a price request is an object");
  for (const name of ["provider", "modelId", "tier"] as const) {
    if (typeof request[name] !== "string") fail("invalid-request", `${name} is a string`);
  }
  if (request.settlement !== "estimate" && request.settlement !== "booked") {
    fail("invalid-request", 'settlement is "estimate" or "booked"');
  }
  const unknownInput = readUnknownInput(request.conditionInputs);
  const at = typeof request.at === "string" ? parseInstantAt(request.at) : undefined;
  if (at === undefined)
    fail("invalid-instant", "at is an RFC 3339 UTC instant, up to milliseconds");

  // 2. The provider, the model, the offering.
  const provider = data.providers.get(request.provider);
  if (provider === undefined) fail("unknown-provider", `no provider "${request.provider}"`);
  // ID-4: an exact id wins over an alias.
  const model =
    provider.modelsById.get(request.modelId) ?? provider.modelsByAlias.get(request.modelId);
  if (model === undefined) fail("unknown-model", `no model or alias "${request.modelId}"`);
  const offering = (model.offerings as ReadonlyMap<string, Offering>).get(request.tier);
  if (offering === undefined)
    fail("unknown-offering", `"${model.id}" has no ${request.tier} offering`);

  // 3. The usage report.
  const usage = readUsage(request.usage);

  // 4. Each schedule at the instant: the entry in force for each component, or "no rate".
  const entries: { condition: BuiltSchedule["condition"]; entries: BasisEntry[] }[] = [];
  const schedules: BuiltSchedule[] = offering.schedules.map((schedule) => {
    const slots = new Map<Component, Slot>();
    const listed: BasisEntry[] = [];
    for (const component of [...schedule.entries.keys()].sort()) {
      const entry = inForce(schedule.entries.get(component) as readonly RateEntry[], at);
      if (entry === undefined) {
        slots.set(component, { kind: "no-rate" });
        listed.push({ component, kind: "no-rate" });
      } else if (entry.priced === undefined) {
        slots.set(component, { kind: entry.disposition as "unsupported" | "inapplicable" });
        listed.push({ component, kind: entry.disposition as "unsupported" | "inapplicable" });
      } else {
        const { unit, per, amount, rate } = entry.priced;
        slots.set(component, { kind: "priced", rate, per, factor: unitInfo(unit).factor });
        listed.push({
          component,
          kind: "priced",
          unit,
          per,
          amount,
          validFrom: entry.validFrom,
          validUntil: entry.validUntil,
        });
      }
    }
    entries.push({ condition: schedule.condition, entries: listed });
    return { condition: schedule.condition, slots };
  });

  // 5 to 9.
  const chosen = choose(schedules, offering.conditionInputs, usage, unknownInput);

  // 10. Round once, on the total.
  const { estimate, booked } = figures(chosen.total, exponentOf(offering.currency));

  // 11. The basis.
  const basis = buildBasis({
    origin: { version: data.version, sha256: data.sha256 },
    provider: provider.id,
    modelId: model.id,
    requested: request.modelId,
    tier: offering.tier,
    currency: offering.currency,
    settlement: request.settlement,
    conditionInputs: offering.conditionInputs,
    schedules: entries,
  });

  return {
    provider: provider.id,
    modelId: model.id,
    tier: offering.tier,
    currency: offering.currency,
    schedule: chosen.schedule,
    exact: formatExact(chosen.total),
    estimate,
    booked,
    basis: basis.text,
    basisSha256: basis.sha256,
  };
}

/**
 * Prices a usage report from a basis alone, without a catalog and without an instant (BASIS-3).
 * The basis is checked first (BASIS-4). `basis` is the basis exactly as stored: its bytes, or its
 * text, which is encoded as UTF-8.
 */
export function priceFromBasis(
  basis: Uint8Array | string,
  basisSha256: string,
  usage: UsageReport,
  conditionInputs?: { inputTokens: "unknown" },
): ReplayResult {
  const bytes = typeof basis === "string" ? new TextEncoder().encode(basis) : basis;
  const read = readBasis(bytes, basisSha256);
  const unknownInput = readUnknownInput(conditionInputs);
  const checked = readUsage(usage);
  const chosen = choose(read.schedules, read.conditionInputs, checked, unknownInput);
  const { estimate, booked } = figures(chosen.total, read.exponent);
  return {
    currency: read.currency,
    schedule: chosen.schedule,
    exact: formatExact(chosen.total),
    estimate,
    booked,
  };
}
