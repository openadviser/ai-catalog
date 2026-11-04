# Clients

> **Status: Draft.** The behaviour below is decided and is the [specification](specification.md)'s. The
> TypeScript client arrives in slice C5 and the Symfony bundle in P2; the PHP core has shipped (P1).

## Purpose

To say what every client does, so that a call is priced the same way in every language.

## Operations shared by every client

Each client offers these operations, under the names the specification gives them (Section 12), in the
idiom of its language.

| Operation                          | What it does                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `load` (bytes, a file or a URL)    | Checks the sha256 and the `schemaVersion`, validates the catalog as a whole, and keeps the last good copy |
| `price`                            | Prices a call from a catalog at an instant                                                                |
| `priceFromBasis`                   | Prices a usage report from a basis alone, with no catalog and no instant                                  |
| `convertRate`                      | Converts a rate into another unit and `per`, exactly or not at all                                        |
| the reads: models, a model, effort | A provider's models, one model by id or alias, and a model's effort levels                                |

- **Loading.** A catalog becomes the last good copy only when it passes every check of Section 14: the
  hash, the JSON text rules, the schema, and the semantic rules (unique ids, offerings and aliases; one
  currency per priced total; non-overlapping windows; exclusive and covering conditions; known components
  and units). A candidate that fails any check is rejected as a whole, and the previous copy stays in
  force. A version the client already holds, with different bytes, is `version-conflict`.
- **`price`** takes `provider`, `modelId` (an id or an alias), `tier`, `at`, `usage`, `settlement` and,
  optionally, `conditionInputs`. It returns `provider`, the resolved `modelId`, `tier`, `currency`,
  `schedule`, `exact`, `estimate`, `booked`, `basis` and `basisSha256`. It refuses with a code of the
  specification's Appendix A, never with a language exception: an unknown model or tier, a component with
  no rate in force, an incomplete usage report, and so on.
- **`priceFromBasis`** gives, from the stored basis and the sha256 of its bytes, the same figures that
  `price` gave, and checks the basis before it prices.
- Every refusal carries one of the specification's error codes, and `usage-incomplete` also lists the
  missing components, sorted.

## Pricing rules

- Arithmetic is exact: no binary floating point touches an amount, a quantity or a sum. The only rounding
  is on the total, and the client returns three figures: `exact` (the total as `N/D` in lowest terms),
  `estimate` (half-up to the currency's minor unit) and `booked` (like `estimate`, but any positive exact
  total books at least one minor unit). Which of the last two a consumer reserves or settles with is the
  consumer's policy, and the basis records it.
- A usage report is `{ completeness, quantities }`, where `completeness` is `complete`, `totals-only`,
  `partial` or `unknown`. Only `complete` prices to an amount. For any other value the client refuses
  with `usage-incomplete`, and names the required components that are missing. A component absent from a
  report is never treated as zero.
- The basis is a JSON document in RFC 8785 (JCS) canonical form, hashed with sha256.

Every client release must pass every vector in [`conformance/`](../conformance/). The full rules are in
the [specification](specification.md).

## TypeScript

Lives in [`clients/ts/`](../clients/ts/) as `@openadviser/ai-catalog` (ESM, Node 26, no runtime
dependency) and is published to npm later. It exports `load`, `price`, `priceFromBasis`, `convertRate`,
the reads `models`, `resolveModel` and `effort`, and `CatalogClient`, which keeps the last good catalog.
Its README has the API and the error codes.

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

Version numbers, and the Symfony bundle (P2).
