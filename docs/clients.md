# Clients

> **Status: Draft.** The behaviour below is decided. The TypeScript client arrives in slice C5, the PHP
> core in P1 and the Symfony bundle in P2.

## Purpose

To say what every client does, so that a call is priced the same way in every language.

## Behaviour shared by every client

- `load(url | path)` fetches a catalog, checks the sha256 and the `schemaVersion`, and keeps the last
  good copy. A catalog becomes the last good copy only when it passes the schema, the hash check and
  semantic validation (unique ids, offerings and aliases; one currency per priced total;
  non-overlapping windows; exclusive conditions; known components and units). A malformed candidate is
  rejected as a whole.
- `price(model, tier, usage, at)` returns `{ amount, currency, basis, basisSha256 }`. It throws on an
  unknown model or tier, a missing component rate, or no validity window at `at`.
- `priceFromBasis(basis, usage)` gives the same result in every client, without the catalog.
- `models(provider)` and `effort(model)`.

## Pricing rules

- Arithmetic is exact. The only rounding is on the total. The client returns the exact total plus two
  rounded figures: `estimate` (half-up to the currency's minor unit) and `booked` (half-up, but any
  positive exact total books at least one minor unit). Which one a consumer reserves or settles with is
  the consumer's policy, and the basis states it.
- A usage report is `{ completeness, quantities }`, where `completeness` is `complete`, `totals-only`,
  `partial` or `unknown`. Only `complete` prices to an amount. Anything else returns `unknown`, naming
  the missing components. A component absent from the report is never treated as zero.
- The basis is a JSON document canonicalised by RFC 8785 (JCS) and hashed with sha256.

Every client release must pass every vector in [`conformance/`](../conformance/). The full rules are in
the [specification](specification.md).

## TypeScript

Lives in [`clients/ts/`](../clients/ts/) and is published to npm later.

## PHP

Lives in [`clients/php/`](../clients/php/) and needs PHP 8.3 or newer.

- **Core:** a framework-neutral client built on PSR-18, PSR-20 and brick/math: `Catalog`, `Model`,
  `Rate`, `Price`, `PricingBasis` and `CatalogLoader`.
- **Symfony bundle** (optional, in the same package): configuration for the source URL, a schedule
  (`off`, `daily` or `weekly`) and an adopt mode (`auto` or `approve`); a database store of adopted
  versions; the commands `ai-catalog:fetch`, `ai-catalog:diff` and `ai-catalog:adopt <version>`; and the
  events `CatalogFetched`, `CatalogAdopted` and `CatalogAdoptionPending`. Fetching runs only in a
  background handler, never in a web request.
- **Installation:** Composer and Packagist need `composer.json` at a repository root, so on each tag a
  workflow splits `clients/php/` into the read-only mirror `openadviser/ai-catalog-php`. The mirror is
  never edited by hand. Issues and pull requests go to `openadviser/ai-catalog`.

## Adoption is local

A client fetches published catalogs. Whether an installation adopts a new version is that installation's
decision. Adoption validates the exact candidate against the local configuration and then switches the
active version atomically. A version that fails validation is not adopted, and the previous version stays
in force.

## Decided in later slices

Package names, public APIs and version numbers: C5, P1 and P2.
