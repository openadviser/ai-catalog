# @openadviser/ai-catalog

**The TypeScript client for [AI Catalog](https://github.com/openadviser/ai-catalog): it validates a
catalog, prices an AI call exactly, and replays a price from its basis alone.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

- ESM only, with type declarations. Node 26 (`engines`).
- No runtime dependency. Money is `bigint` rational arithmetic: no binary floating point touches an
  amount, a quantity, a product or a sum.
- Built from the [specification](../../docs/specification.md) alone, and it passes every
  [conformance vector](../../conformance/).

## Install

_The first release has not been published yet. After it is:_

```sh
npm install @openadviser/ai-catalog
```

## Quick start

```ts
import { load, price, priceFromBasis } from "@openadviser/ai-catalog";

// Bytes or a URL. A URL is fetched together with `<url>.sha256`, and the bytes must match it.
const catalog = await load("<catalog.json URL>");

const result = price(catalog, {
  provider: "openai",
  modelId: "gpt-6.1-sol", // an id or an alias
  tier: "openai:standard",
  at: new Date().toISOString(), // RFC 3339 UTC, up to milliseconds
  settlement: "booked", // which figure you reserve or settle with
  usage: {
    completeness: "complete",
    quantities: {
      input: 12000,
      input_cached: 3000,
      cache_write_30m: 0,
      cache_write_12h: 0,
      output: 800,
      web_search: 0,
      file_search: 0,
      containers: 0,
    },
  },
});

result.exact; // "323/10000", the exact total
result.estimate; // "0.03", half-up to the minor unit, once, on the total
result.booked; // "0.03", the same, but a positive total books at least "0.01"

// Store `result.basis` and `result.basisSha256` with the call. Later, without the catalog and without
// the instant, price the actual usage from them:
const settled = priceFromBasis(result.basis, result.basisSha256, actualUsage);
```

Every quantity of a `complete` report must be present, zero included: a component that is absent is
never read as zero (USAGE-2). A report that is not `complete` is refused with `usage-incomplete` and the
list of the missing components.

## API

### Loading

| Function / class         | What it does                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load(source, options?)` | `source` is the catalog's bytes (`Uint8Array`) or the URL of `catalog.json` (`string` or `URL`). Returns a `Catalog`, or throws. Checks, in order: the hash, JSON-1 and JSON-2 on the text, then the structure and every semantic rule. |
| `new CatalogClient()`    | Keeps the last good catalog. `client.load(source, options?)` replaces it only when the candidate passes every check; `client.current` is the last good one. A `version` already held with different bytes is rejected.                  |
| `parseUsage(text)`       | Reads a usage report from JSON text under JSON-1 and JSON-2 (`1e-999` and duplicate members are refused). A quantity of 2^53 or more is kept as a `bigint`, so `price` refuses it with `quantity-out-of-range`.                         |

`LoadOptions`: `expectedSha256` (lowercase hex of the bytes, VAL-2), `sidecar` (read the hash from
`<url>.sha256`; default `true` for a URL), `fetch`, `signal`, `maxBytes` (default 64 MiB) and
`allowInsecureHttp` (only `https:` is fetched by default).

A catalog is accepted whole or not at all (VAL-1). A `Catalog` is immutable and exposes `version`,
`schemaVersion`, `publishedAt` and `sha256`.

### Pricing

| Function                                                      | What it does                                                                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `price(catalog, request)`                                     | PRICE-2. Returns `{ provider, modelId, tier, currency, schedule, exact, estimate, booked, basis, basisSha256 }`. `modelId` is the resolved id; `basis` is the canonical text, whose UTF-8 bytes `basisSha256` hashes. |
| `priceFromBasis(basis, basisSha256, usage, conditionInputs?)` | BASIS-3. `basis` is the stored bytes or text. Checks the basis first (BASIS-4). Returns `{ currency, schedule, exact, estimate, booked }`.                                                                            |
| `convertRate(rate, to)`                                       | UNIT-4. `rate` is `{ unit, per, amount }`, `to` is `{ unit, per, scale }`. Returns `{ amount }` in canonical form, or refuses; it never rounds.                                                                       |

`request.conditionInputs: { inputTokens: "unknown" }` reserves before a call whose input is not known
(COND-7): every schedule is evaluated and the greatest total is returned.

### Other reads

| Function                              | What it does                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `providers(catalog)`                  | The provider ids.                                                                                       |
| `models(catalog, provider)`           | A provider's models: `id`, `name`, `aliases`, `status`, `retiresOn`, `capabilities`, `tiers`, `effort`. |
| `resolveModel(catalog, provider, id)` | One model, by id or alias. An exact id wins over an alias; a retired alias still resolves.              |
| `effort(catalog, provider, id)`       | `{ levels, default }`, or `null` when the catalog states none.                                          |

## Errors

A refusal the specification names is an `AiCatalogError` with a `code` and, for `usage-incomplete`, the
sorted `missing` list:

```ts
try {
  price(catalog, request);
} catch (error) {
  if (error instanceof AiCatalogError && error.code === "usage-incomplete") {
    console.log(error.missing); // for example ["cache_write_5m", "web_search"]
  }
}
```

The codes are those of [Appendix A](../../docs/specification.md#appendix-a-error-codes), exported as
`ERROR_CODES` and the `ErrorCode` type:

- **load:** `invalid-json`, `hash-mismatch`, `unsupported-schema-version`, `invalid-structure`,
  `invalid-amount`, `invalid-per`, `unknown-currency`, `unknown-unit`, `unit-mismatch`,
  `unknown-component`, `unknown-tier`, `tier-provider-mismatch`, `invalid-instant`, `invalid-window`,
  `windows-overlap`, `condition-inputs-invalid`, `conditions-mixed`, `conditions-not-exclusive`,
  `conditions-not-covering`, `schedules-mismatch`, `duplicate-provider`, `duplicate-model`,
  `duplicate-alias`, `duplicate-offering`, `alias-collision`, `mixed-currencies`,
  `offering-without-price`, `invalid-version`, `invalid-effort`.
- **price:** `invalid-request`, `invalid-instant`, `unknown-provider`, `unknown-model`,
  `unknown-offering`, `invalid-usage`, `quantity-out-of-range`, `usage-incomplete`,
  `component-not-offered`, `unsupported-component`, `inapplicable-component-used`, `no-rate-in-force`,
  `unsupported-unit`.
- **priceFromBasis:** the usage codes above, and `basis-hash-mismatch`, `unsupported-basis-version`,
  `invalid-basis`.
- **convertRate:** `invalid-per`, `dimension-mismatch`, `unsupported-unit`, `inexact-conversion`.

A failure to fetch a URL (a network error, a non-2xx answer, a missing or malformed `.sha256`, a body over
`maxBytes`) is a `CatalogFetchError`. It is not a verdict on any catalog: nothing was read.

## Supported schema versions

Schema `1.0.x`. The vocabularies are closed, so a newer minor version is rejected with
`unsupported-schema-version` (VAL-3). Basis version `1`.

## The conformance promise

Every release of this client passes every vector in [`conformance/`](../../conformance/), so a call is
priced the same way here as in every other language. `test/conformance.test.ts` reads each vector file
and fixture as bytes, runs the vector through the public API only, and compares the result or the error
code exactly, including the basis bytes and their sha256. A vector that is skipped or expected to fail is
a failure.

Run the tests from the repository root with `npm test`, and the type check of this package with
`npm run typecheck -w @openadviser/ai-catalog`.

## Where the specification is silent

No vector reaches these cases. The client does the following, and a specification change would replace
it:

- **A version already held with different bytes** (VAL-2) is rejected with `hash-mismatch`, because
  Appendix A binds that code to VAL-2. Appendix A has no code of its own for it.
- **A malformed `conditionInputs` list** is `invalid-structure` when the list is empty or repeats a
  component (the schema rejects it), `unknown-component` for a string that is not a component, and
  `condition-inputs-invalid` for the two rules COND-2 spells out.
- **A well-formed tier id with an unknown provider prefix** is `unknown-tier`; a known tier of another
  provider is `tier-provider-mismatch`.
- **A wrong JSON type**: `amount` and `per` take any wrong value to `invalid-amount` and `invalid-per`;
  for `currency`, `unit`, `component`, `tier`, instants, dates, versions and effort levels a string outside
  the vocabulary gets the rule's code and a non-string is `invalid-structure`.
- **`convertRate`**: a `scale` outside 0 to 12 throws a `RangeError`; an unknown unit, an amount outside
  NUM-1 or an invalid source `per` is refused with `unknown-unit`, `invalid-amount` or `invalid-per`.
- **A request that is not an object, or a `provider`, `modelId` or `tier` that is not a string,** is
  `invalid-request`; so is a malformed `conditionInputs` given to `priceFromBasis`. A non-string `at` is
  `invalid-instant`.
- **JSON text**: bytes that are not UTF-8, a byte order mark, an unpaired surrogate escape and nesting
  deeper than 512 are `invalid-json` (`invalid-basis` for a basis).
- **A basis `price` could not have written** is `invalid-basis` beyond the checks BASIS-4 lists: the
  windows of its priced entries must have an instant in common.
- **Several broken rules in one catalog**: the first found is reported, in this order: the hash, the
  text (JSON-1, JSON-2), the schema version, the structure in document order, then the semantic rules.

## Links

- [Specification](../../docs/specification.md) · [Clients](../../docs/clients.md) ·
  [Contributing](../../CONTRIBUTING.md) · [MIT licence](LICENSE)
