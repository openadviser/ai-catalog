# Specification

> **Status: Draft — specified in C1.** Slice C1 writes this document in full, together with the JSON
> Schema in [`schema/`](../schema/) and the vectors in [`conformance/`](../conformance/). What follows
> is the contract that is already decided. The details are decided in C1.

## Purpose

To be the one normative description of how a catalog is validated and how a call is priced from it, so
that two independent clients cannot disagree.

## What it will hold

Each section below states a decided rule. C1 adds the exact definitions and the vectors that pin them.

1. **Numbers.**
   - Amounts are nonnegative decimal strings matching `^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$`.
   - `per` is a power of ten from 1 to 10^9, so that division is always an exact decimal.
   - Quantities are nonnegative integers below 2^53, so every language can represent them.
   - Every intermediate result is exact. The only rounding is the final one, on the total.
   - A value outside these bounds is a validation error, never a rounded value. Adapting a rate into a
     consumer type that cannot hold it exactly is refused, never rounded.
2. **Rounding.** The client returns the exact total plus `estimate` (half-up to the currency's minor
   unit) and `booked` (half-up, but any positive exact total books at least one minor unit). The consumer
   chooses which one it reserves or settles with, and the basis states it.
3. **Usage completeness.** A usage report is `{ completeness, quantities }` with `completeness` one of
   `complete`, `totals-only`, `partial` or `unknown`. Only `complete` prices to an amount; the others
   return `unknown` with the missing components named. A component absent from the report is never zero.
   Component meanings are disjoint and stated per provider: for each provider, which reported field maps
   to which component.
4. **Components and disposition.** The vocabulary is closed and versioned with the schema. Each offering
   lists every billable component its source publishes, with one disposition each: `priced`,
   `inapplicable` (with the reason) or `unsupported`. Any use of an `unsupported` component makes pricing
   refuse. Compound units are a separate unit kind, and a client that cannot price one refuses.
5. **Tiers.** Tier ids are specific to each provider and named as the source names them. The
   specification says, per tier, what request and response semantics make a call that tier. The selected
   tier is part of the basis.
6. **Conditions.** Conditions are typed predicates. The first is `inputTokens > N`: the whole call is
   priced at the tier's conditional rates when it holds. The conditional schedules of one offering must
   be mutually exclusive and cover every input, or the catalog is invalid. When the input is unknown at
   admission, the consumer reserves at the most expensive schedule that can apply and keeps the whole
   schedule in the basis, so settlement picks the actual one.
7. **Time.**
   - Validity windows are half-open `[validFrom, validUntil)` in RFC 3339 UTC, and may not overlap.
   - A source date without a time means 00:00 in the zone the source states, or UTC if it states none.
     The reader records which rule it applied.
   - A change read with no stated effective date becomes effective at the release's `publishedAt`, never
     earlier, and is flagged as undated.
   - The vectors price one instant before, at and after every boundary.
8. **Identity.** Every lookup is keyed by `(provider, modelId)`. Aliases are unique within a provider,
   an exact id wins over an alias, a retired alias still resolves for history, and the resolved identity
   is part of the basis.
9. **The basis and replay.** The basis is a JSON document canonicalised by RFC 8785 (JCS) and hashed with
   sha256. It carries the catalog version and its hash (or the override revision), `(provider, modelId)`,
   the tier, the condition schedule, each rate with its source unit and `per`, the conversion into the
   consumer's units, and the rounding policy. `priceFromBasis(basis, usage)` gives the same result in
   every client without the catalog. The vectors pin the basis bytes.
10. **Validation.** A catalog becomes "last good" only when it passes the schema, the hash check and
    semantic validation: unique ids, offerings and aliases; one currency per priced total;
    non-overlapping windows; exclusive conditions; known components and units. A malformed candidate is
    rejected as a whole.

## Decided in C1

Everything not stated above: field names, the closed vocabularies, the per-provider component mapping,
the per-tier semantics, the vector files, and the form of the basis.
