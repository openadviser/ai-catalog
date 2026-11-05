# Specification

> **Status: normative, schema 1.1.0, basis version 1.** This document is the contract every client
> implements. Where it and any other page of this repository differ, this page wins.

## 1. Scope and language

This specification says how a catalog is validated, how a call is priced from it, what the audit record
of that price (the basis) contains, and how a price is replayed from the basis alone. It is written so
that two clients built independently, in different languages, from this page and the
[conformance vectors](../conformance/) cannot price the same call differently.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY and
OPTIONAL are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals.

Each rule has an id in bold, such as **NUM-1**, and names the vectors that pin it. Appendix B indexes
them. A rule that binds only a consumer or a data author, and no client behaviour, says so and names no
vector.

### Terms

- **Catalog:** the document `catalog.json`, described by [`schema/catalog.schema.json`](../schema/).
- **Client:** a library that loads catalogs and prices calls (`clients/ts`, `clients/php`).
- **Consumer:** an application that uses a client, such as omf-app.
- **Offering:** one way of buying a model, identified by its tier.
- **Rate entry:** one element of an offering's `rates`: a component, a disposition and, when priced, an
  amount per unit.
- **Schedule:** the rate entries of an offering that share one condition (Section 9).
- **Usage report:** the quantities a call consumed, described by
  [`schema/usage.schema.json`](../schema/).
- **Basis:** the canonical record of the rates a call was priced at, described by
  [`schema/basis.schema.json`](../schema/).

## 2. The documents

| Document     | Schema                       | `$id`                                                                        |
| ------------ | ---------------------------- | ---------------------------------------------------------------------------- |
| Catalog      | `schema/catalog.schema.json` | `https://github.com/openadviser/ai-catalog/schema/1.1.0/catalog.schema.json` |
| Usage report | `schema/usage.schema.json`   | `https://github.com/openadviser/ai-catalog/schema/1.1.0/usage.schema.json`   |
| Basis        | `schema/basis.schema.json`   | `https://github.com/openadviser/ai-catalog/schema/1.1.0/basis.schema.json`   |
| Vector file  | `schema/vector.schema.json`  | `https://github.com/openadviser/ai-catalog/schema/1.1.0/vector.schema.json`  |

The `$id`s are identifiers, not download locations. The schemas are JSON Schema draft 2020-12. They are
the structural gate: every rule a schema can express is in it. The rules no schema can express (such as
non-overlapping windows) are the semantic checks of Section 14. A client MUST apply both, but it is NOT
REQUIRED to use a JSON Schema validator at runtime, as long as it rejects exactly what the rules reject,
with the codes of Appendix A.

All three documents are JSON ([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)) encoded as UTF-8.

**JSON-1. Duplicate members.** An object MUST NOT have two members with the same name, compared after
unescaping. A client MUST reject a catalog with one, with `invalid-json`, before it builds any value from
the bytes. Parsers differ on which of two values they keep, so the same bytes could otherwise price
differently in two clients. A basis with a duplicate member is not in canonical form (BASIS-4). A
consumer that reads a usage report from JSON text MUST reject it the same way.

The text itself MUST be JSON that a strict reader accepts. A client MUST reject a catalog with
`invalid-json`, before it builds any value from the bytes, when:

- its bytes are not valid UTF-8;
- it begins with a UTF-8 byte order mark;
- a string holds an unpaired UTF-16 surrogate escape, such as `\ud800` that no low-surrogate escape
  follows, or a low-surrogate escape that no high-surrogate escape precedes;
- arrays and objects nest more than 512 deep, the outermost value being at depth 1.

A basis that does any of this is refused with `invalid-basis` (BASIS-4, step 2). A usage report read from
JSON text is refused with `invalid-json`, as for a duplicate member.
Vectors: `load-duplicate-member`, `load-json-bom`, `load-json-not-utf8`, `load-json-unpaired-surrogate`,
`load-json-too-deep`, `basis-bom`, `basis-not-utf8`, `basis-unpaired-surrogate`, `basis-too-deep`.

**JSON-2. Integers are integer literals.** Every JSON number in a catalog MUST be written as an integer
literal, `-?(0|[1-9][0-9]*)`, with no fraction and no exponent. The catalog's numbers are all integers
(`per`, condition bounds, byte offsets), and its amounts are strings (NUM-1).

- A client MUST check each number literal in the text, before a parser converts it, and reject a
  catalog that breaks this with `invalid-json`.
- The reason is that a binary-floating-point parser reads `1000000.00000000001` as exactly 10^6, and
  `0.99999999999999999` as 1. One client would then accept a `per` that an exact-decimal client
  rejects.
- A basis holds only integer literals too. Any other spelling fails BASIS-4's canonical check.
- A consumer that reads a usage report from JSON text MUST hold its quantities to the same rule, so that
  `1e-999` is refused rather than read as zero.
- `-0` matches the grammar, but it is not read as 0. Wherever a nonnegative integer is required, a number
  literal with a leading minus is refused, `-0` included: `invalid-usage` in a usage report, and in a
  catalog the code of the member it stands in (`invalid-per` for `per`, `invalid-structure` for every other
  integer). A parser that turns `-0` into the integer 0 would otherwise accept what a stricter one refuses.

Vectors: `load-per-fraction-rounds`, `load-per-negative-zero`, `load-integer-negative-zero`.

## 3. Numbers

**NUM-1. Amounts.** An amount is a JSON string matching

```text
^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$
```

It is nonnegative, has no sign, no exponent, no leading zeros in the integer part, no separators and no
trailing point, and has at most twelve fractional digits. A JSON number in an amount's place, or a string
outside the grammar, is rejected with `invalid-amount`. A value outside these bounds is never rounded
into them.
Vectors: `load-amount-leading-zero`, `load-amount-number`, `load-amount-exponent`,
`load-amount-too-many-decimals`, `load-amount-negative`,
`load-amount-negative-zero`.

**NUM-2. `per`.** A rate's `per` is one of the integers 1, 10, 100, 1000, 10^4, 10^5, 10^6, 10^7, 10^8
or 10^9. Any other value, of any JSON type, is rejected with `invalid-per`: the string `"1000"` is not
the integer 1000.
Vectors: `load-per-not-power-of-ten`, `load-per-zero`, `load-per-too-large`, `load-per-string`.

**NUM-3. Quantities.** A usage quantity is a JSON number whose value is an integer `q` with
`0 <= q < 2^53` (that is, at most 9007199254740991).

- A negative or fractional value is `invalid-usage`. So is `-0` (JSON-2).
- A value of 2^53 or more is `quantity-out-of-range`.

Every language can represent such a quantity exactly. Some JSON parsers cannot tell 2^53 from 2^53 + 1,
so the vector uses exactly 2^53.

A client that accepts native values rather than JSON text cannot see the literal, so it MUST accept a
value as an integer only when its language proves it is one, and refuse every other number with
`invalid-usage`:

- where the language has an integer type apart from its floating-point type, only a value of the
  integer type is accepted, and a float is refused even when it is integral (PHP `1.0`);
- where the language has one number type, an integer-valued finite number is accepted, except negative
  zero; `NaN`, `Infinity` and a number with a fraction are refused (JavaScript).

The shape is judged before the bound (PRICE-2, step 3): a value that passes the test above and is 2^53
or more is `quantity-out-of-range`. For native values this is a rule about the type, not about lexical
form, which only JSON text carries (JSON-2).

_Note (not normative)._ In PHP `json_decode` reads `0.99999999999999999` as `1.0` and `1e-999` as `0.0`,
and once the value is a float it cannot be told from `1` and `0`; that is why a float is refused. A
JavaScript number outside the safe range cannot be told from its neighbours, but every integer from 2^53
up is `quantity-out-of-range`, so the code does not depend on which integer was meant. A JavaScript
program that has the JSON text should pass it to a reader that checks the literals rather than to
`JSON.parse`, which has already lost them.
Vectors: `price-quantity-over-bound`, `price-quantity-negative`, `price-quantity-fraction`,
`price-quantity-negative-zero`.

**NUM-4. The canonical decimal.** The canonical form of an amount removes trailing zeros from the
fraction, and removes the point when no fraction remains: `"0.10"` becomes `"0.1"`, `"2.00"` becomes
`"2"`, and `"0.000"` becomes `"0"`. The basis (Section 13) and `convertRate` (UNIT-4) write amounts only in
canonical form. A catalog MAY write amounts in any form NUM-1 allows.
Vectors: `price-unit-minute` (`"0.10"` in the fixture is `"0.1"` in the basis), `convert-characters`.

**NUM-5. Exact arithmetic.** Every intermediate result is an exact rational number. A client MUST NOT
use binary floating point for any amount, quantity, product or sum. The only rounding is the one in
Section 4, on the total. An **exact total** is written as the string `N/D`, where:

- `N >= 0` and `D >= 1` are decimal integers without leading zeros;
- the fraction is in lowest terms;
- zero is `0/1`.
  Vectors: `price-typical`, `price-unit-minute-recurring`, `price-zero-usage`.

## 4. Currencies and rounding

**ROUND-1. Currencies.** A currency is one of the codes below, which have been part of the vocabulary since 1.0.0.
Any other code is rejected with `unknown-currency`.

| Code | Minor-unit exponent `e` |
| ---- | ----------------------- |
| USD  | 2                       |
| EUR  | 2                       |
| GBP  | 2                       |

Vectors: `load-unknown-currency`.

**ROUND-2. `estimate`.** For an exact total `N/D` in a currency with exponent `e`, the estimate in minor
units is `floor((2 * N * 10^e + D) / (2 * D))`, which is half-up on a nonnegative value, computed in
integers. It is written as a decimal string with exactly `e` fractional digits, such as `"0.02"`,
`"12.30"` or `"0.00"`. Components are never rounded one by one.
Vectors: `price-rounded-once`, `price-sub-cent`, `price-typical`.

**ROUND-3. `booked`.** `booked` equals `estimate`, except that a positive exact total whose estimate is
zero books one minor unit (`"0.01"` in USD). A zero exact total books zero. This is the rule that stops
repeated small calls from vanishing from a ledger of whole minor units.
Vectors: `price-sub-cent`, `price-unit-minute-recurring`, `price-zero-usage`.

**ROUND-4. The consumer's policy.** The consumer says which figure it reserves or settles with, as the
request's `settlement`: `"estimate"` or `"booked"`. The client MUST write it into the basis (`rounding.
settlement`). It does not change the figures returned, and both figures are always returned.
Vectors: `price-settlement-estimate`, `price-sub-cent`.

## 5. Units, dimensions and meters

**UNIT-1. Unit kinds.** A rate's `unit` is one of the kinds below. Each belongs to a dimension, and every
component (Section 6) admits only the units of its dimension.

| Unit          | Dimension  | Meter         | Factor (meter units per unit) |
| ------------- | ---------- | ------------- | ----------------------------- |
| `token`       | tokens     | `token`       | 1                             |
| `character`   | characters | `character`   | 1                             |
| `request`     | requests   | `request`     | 1                             |
| `millisecond` | duration   | `millisecond` | 1                             |
| `second`      | duration   | `millisecond` | 1000                          |
| `minute`      | duration   | `millisecond` | 60000                         |
| `hour`        | duration   | `millisecond` | 3600000                       |
| `token-hour`  | token-time | none          | none (compound)               |

- An unknown unit is rejected with `unknown-unit`.
- A unit outside its component's dimension is rejected with `unit-mismatch`. The dimension `storage` has no
  unit in 1.1.0, so a priced `file_search_storage` entry is `unknown-unit` when its unit is not in the
  table, and `unit-mismatch` when it is.

Vectors: `load-unknown-unit`, `load-unknown-unit-inherited-name`, `load-unit-mismatch`,
`load-storage-priced-unit-mismatch`, `load-storage-priced-unknown-unit`.

**UNIT-2. Meters.** Usage is always reported in the meter of the component's dimension: tokens,
characters and requests as counts, and every duration in integer **milliseconds**. A priced entry with
amount `a`, `per` `p` and unit factor `f` makes a quantity `q` cost exactly `q * a / (p * f)`.

A per-minute price is therefore stored exactly as the source states it
(`{ "unit": "minute", "per": 1, "amount": "0.10" }`) and stays exact: 1 ms at $0.10 per minute costs
exactly 1/600000 USD. Nothing is converted into a per-millisecond decimal, which for this price would
not terminate.
Vectors: `price-typical` (tokens), `price-unit-character`, `price-unit-request`,
`price-unit-millisecond`, `price-unit-second`, `price-unit-minute`, `price-unit-minute-recurring`,
`price-unit-hour`.

**UNIT-3. Compound units.** `token-hour` is a compound unit. Version 1.1.0 defines no arithmetic for
compound units. A client MUST refuse, with `unsupported-unit`, a positive quantity for an entry whose unit
is compound. The components that carry compound units are not per-call quantities (COMP-4), so they are
not required in a usage report.
Vectors: `price-unit-token-hour`, `convert-compound`.

**UNIT-4. Converting a rate into a consumer's unit (`convertRate`).** A consumer whose own types meter a
component in another unit or `per` converts with this rule and no other. Given a rate
`(unit u1, per p1, amount a)` and a target `(unit u2, per p2, scale s)`:

1. `p2` MUST satisfy NUM-2, or the conversion is refused with `invalid-per`. `s` is an integer from 0
   to 12, or the conversion is refused with `invalid-request` (API-1).
2. `u1` and `u2` MUST belong to the same dimension, or the conversion is refused with
   `dimension-mismatch`.
3. A compound unit cannot be converted, and is refused with `unsupported-unit`.
4. The target amount is `a2 = a * p2 * f(u2) / (p1 * f(u1))`, exactly, so that a quantity costs the
   same under both: `a / (p1 * f(u1)) = a2 / (p2 * f(u2))`.
5. If `a2 * 10^s` is not an integer, the conversion is refused with `inexact-conversion`. It is never
   rounded.
6. Otherwise `a2` is returned in canonical form (NUM-4).

For example, $0.15 per minute is `2.5` per 10^6 milliseconds. $0.10 per minute has no exact
per-10^6-millisecond value at any scale, so it is refused. A consumer that cannot hold a converted rate
exactly MUST refuse to adopt it, rather than round it.
Vectors: `convert-minute-to-million-ms`, `convert-minute-recurring`, `convert-characters`,
`convert-scale-too-small`, `convert-scale-enough`, `convert-second-to-ms`, `convert-dimension-mismatch`,
`convert-compound`, `convert-invalid-per`.

## 6. Components

**COMP-1. The vocabulary.** A component is one of the ids below. The vocabulary is closed and versioned
with the schema: adding a component is a minor schema version. An unknown component in a catalog is
rejected with `unknown-component`. In a usage report it is rejected with `invalid-usage`.

A component added in a minor version is unknown to a catalog that declares an earlier minor version:
`generation`, added in 1.1.0, is rejected with `unknown-component` in a catalog whose `schemaVersion` is
`1.0.x`. A catalog that declares `1.0.x` therefore means what it meant to a 1.0.0 client, and a client
that reads both never prices a `1.0.x` document with a component the document did not know it had.

| Component               | Dimension  | Per call | Meaning                                                                                                                |
| ----------------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `input`                 | tokens     | yes      | Input tokens neither read from nor written to a prompt cache, of every modality the offering does not price separately |
| `input_cached`          | tokens     | yes      | Input tokens read from a prompt cache (cache hits and refreshes)                                                       |
| `cache_write_5m`        | tokens     | yes      | Input tokens written to a cache with a 5-minute lifetime                                                               |
| `cache_write_1h`        | tokens     | yes      | Input tokens written to a cache with a 1-hour lifetime                                                                 |
| `cache_write_30m`       | tokens     | yes      | Input tokens written to a cache with a 30-minute lifetime                                                              |
| `cache_write_12h`       | tokens     | yes      | Input tokens written to a cache with a 12-hour lifetime                                                                |
| `output`                | tokens     | yes      | Text output tokens, including reasoning or thinking tokens                                                             |
| `output_audio`          | tokens     | yes      | Audio output tokens                                                                                                    |
| `characters`            | characters | yes      | Billed characters of input text                                                                                        |
| `output_audio_duration` | duration   | yes      | Duration of generated audio                                                                                            |
| `web_search`            | requests   | yes      | Web search tool calls                                                                                                  |
| `file_search`           | requests   | yes      | File search tool calls                                                                                                 |
| `grounding_search`      | requests   | yes      | Grounding requests to a search engine                                                                                  |
| `grounding_maps`        | requests   | yes      | Grounding requests to a maps service                                                                                   |
| `generation`            | requests   | yes      | Generated media items, such as a song or a clip, priced per item                                                       |
| `code_execution`        | duration   | yes      | Code execution container time                                                                                          |
| `containers`            | duration   | yes      | Hosted container sessions                                                                                              |
| `cache_storage`         | token-time | no       | Tokens held in a context cache over time                                                                               |
| `file_search_storage`   | storage    | no       | Stored file-search data over time                                                                                      |

The `storage` dimension has no unit in 1.1.0, so `file_search_storage` can only be `unsupported` or
`inapplicable`.

Component meanings are disjoint. A token is counted in exactly one token component. Section 15 says, for
each provider, which reported field gives which component.
Vectors: `load-unknown-component`, `load-unknown-component-inherited-name`,
`load-generation-in-schema-1-0`.

**COMP-2. Dispositions.** Every rate entry has one disposition:

- **`priced`:** it has `unit`, `per`, `amount` and `currency`, and no `reason`;
- **`inapplicable`:** the source publishes the component but states that it does not apply to this
  offering, for example "Not available" in the tier's table. It has a `reason` and no unit or amount;
- **`unsupported`:** the source publishes a charge this version cannot price, for example a monthly free
  allowance, or a price whose scope the page leaves ambiguous. It has a `reason` and no unit or amount.

A positive quantity for an `unsupported` entry is refused with `unsupported-component`. For an
`inapplicable` entry it is refused with `inapplicable-component-used`. A zero quantity for either costs
nothing.
Vectors: `price-unsupported-in-use`, `price-inapplicable-in-use`, `price-condition-above-unsupported-write`.

**COMP-3. Listing.** Each offering lists every billable component its source publishes for it, with one
disposition per schedule and window. That obligation falls on data authors and readers. A usage report
with a positive quantity for a component the offering does not list at all is refused with
`component-not-offered`. A zero quantity for it costs nothing.
Vectors: `price-component-not-offered`.

**COMP-4. Per-call components.** A component marked "no" under "Per call" is billed outside any single
call, for example cache storage per token-hour. It is listed so that the offering is complete, but a
usage report does not have to state it. A positive quantity for it is refused, with
`unsupported-unit` if its entry is priced in a compound unit, and by COMP-2 otherwise.
Vectors: `price-window-before` (complete without `cache_storage`), `price-unit-token-hour`.

## 7. Usage reports

A usage report is:

```json
{ "completeness": "complete", "quantities": { "input": 1200, "input_cached": 0, "output": 340 } }
```

**USAGE-1. Completeness.** `completeness` is one of:

- **`complete`:** every per-call component is reported;
- **`totals-only`:** totals without the split the offering prices;
- **`partial`:** some components only;
- **`unknown`:** nothing reliable.

Only `complete` prices to an amount. For every other value the client MUST NOT return an amount. It
refuses with `usage-incomplete`, and lists in `missing` the required components (USAGE-2) that are absent
from `quantities`, sorted by code point. The list may be empty: a `totals-only` report is refused even
when its keys happen to cover the required set, because its numbers do not mean the components.
Vectors: `price-usage-partial`, `price-usage-totals-only`, `price-usage-unknown`.

**USAGE-2. Required components.** The required components are the per-call components whose entry at
the instant priced is `priced`, `unsupported` or "no rate" (nothing in force, TIME-4) in at least one
schedule. They are judged on the schedules as built at that instant (PRICE-2, step 4), so that
`priceFromBasis`, which sees only those schedules, judges the same way. For an offering with conditions,
every component of its `conditionInputs` is also required, so the input is never summed over an absent
quantity. A `complete` report MUST contain each of them, zero included. Otherwise it is refused with `usage-incomplete` and the missing list.
**A component absent from a report is never treated as zero.** A component that is `inapplicable` at
that instant in every schedule, and a component that is not per call, MAY be omitted.
Vectors: `price-usage-complete-missing`.

**USAGE-3. Zero.** A zero quantity costs nothing, whatever the component's disposition, and whether or not
a rate is in force for it at the instant priced.
Vectors: `price-zero-usage`.

**USAGE-4. Shape.** The report is refused with `invalid-usage` when any of these hold:

- it is not an object, or has members other than `completeness` and `quantities`;
- `completeness` is not one of the four values;
- `quantities` is not an object;
- a key is not a component of COMP-1;
- a value violates NUM-3 other than by being too large.

Vectors: `price-usage-invalid-completeness`, `price-quantity-negative`, `price-quantity-fraction`.

## 8. Tiers

**TIER-1. Tier ids.** A tier id is `<provider id>:<name>`, named as the provider's source names the
table it was read from. Tier ids are a closed vocabulary per provider, versioned with the schema. In
1.1.0 they are:

| Provider        | Tiers                                   |
| --------------- | --------------------------------------- |
| `anthropic`     | `anthropic:standard`, `anthropic:batch` |
| `openai`        | `openai:standard`                       |
| `google-gemini` | `google-gemini:standard`                |
| `elevenlabs`    | `elevenlabs:pay-as-you-go`              |

- An unknown tier is rejected with `unknown-tier`.
- A tier of the vocabulary whose prefix is not its provider's id is rejected with
  `tier-provider-mismatch`. The vocabulary is checked first: `mistral:standard` is `unknown-tier`
  under any provider, and `openai:standard` under `anthropic` is `tier-provider-mismatch`.
- A model has at most one offering per tier (ID-3).

Adding a tier is a minor schema version, and comes with its semantics in Section 15.
Vectors: `load-unknown-tier`, `load-tier-unknown-prefix`, `load-tier-provider-mismatch`.

**TIER-2. Lookup.** Pricing names the tier. A model that has no offering for it is refused with
`unknown-offering`. A client MUST NOT fall back to another tier.
Vectors: `price-unknown-offering`.

**TIER-3. What makes a call that tier.** Section 15 states, per tier, the request a consumer sends and the
response it checks. A consumer MUST price a call at a tier only when the call meets that tier's request
semantics. Where the provider's response reports the tier or service level applied, the consumer MUST
compare it with the tier priced, and MUST NOT settle at the priced tier when they differ. The selected
tier is part of the basis. This binds consumers. No client vector.

## 9. Conditions

**COND-1. The predicate.** A condition is a typed predicate over one named input. Version 1.1.0 defines
one input, `inputTokens`, and one predicate form, a half-open integer interval:

```json
{ "inputTokens": { "gt": 272000 } }
{ "inputTokens": { "lte": 272000 } }
{ "inputTokens": { "gt": 100000, "lte": 272000 } }
```

`gt` and `lte` are integers in `[0, 2^53)`. At least one is present, and when both are, `gt < lte`. A
condition holds for an input value `x` when `x > gt` (if present) and `x <= lte` (if present). Any other
form is rejected with `invalid-structure`.

**COND-2. The input is data.** An offering with conditions declares `conditionInputs`:

```json
{ "inputTokens": ["input", "input_cached", "cache_write_30m", "cache_write_12h"] }
```

The input's value is the sum of the reported quantities of the listed components. Each listed component
MUST be listed in the offering, and every component listed in it MUST be in the dimension `tokens`. An
offering with conditions and no `conditionInputs`, or `conditionInputs` without conditions, or one that
breaks these rules, is rejected with `condition-inputs-invalid`. The source decides which components
count, and the reader records that reading in the condition's provenance.

These rules are the whole of `condition-inputs-invalid`. A `conditionInputs` list that the schema rejects
is `invalid-structure` (VAL-4): an empty list, or a list that repeats a component. A string in the list
that is not a component is `unknown-component` (COMP-1). Both are reported instead of the rules above.
Vectors: `load-condition-inputs-invalid`, `load-condition-inputs-empty`,
`load-condition-inputs-duplicate`, `load-condition-inputs-unknown-component`.

**COND-3. All or none.** Within one offering, either no rate entry has a condition or every rate entry
has one. Otherwise the catalog is rejected with `conditions-mixed`.
Vectors: `load-conditions-mixed`.

**COND-4. Exclusive and covering.** The distinct conditions of one offering are its schedules. Their
intervals MUST partition `[0, 2^53)`:

- sorted by lower bound, the first has no `gt`;
- each next `gt` equals the previous `lte`;
- the last has no `lte`: a last schedule with any `lte`, `9007199254740991` included, leaves the inputs
  above it uncovered.

Overlapping intervals are rejected with `conditions-not-exclusive`. A gap is rejected with
`conditions-not-covering`. Two conditions are the same schedule when their `gt` and `lte` are equal.
Vectors: `load-conditions-not-exclusive`, `load-conditions-not-covering`, `load-conditions-last-bounded`.

**COND-5. Same components.** Every schedule of an offering lists the same set of components. Otherwise
the catalog is rejected with `schedules-mismatch`.
Vectors: `load-schedules-mismatch`.

**COND-6. Whole-request selection.** When the request does not say otherwise, the client computes the
input from the complete report. Exactly one schedule holds, and **the whole call is priced at that
schedule's entries**, every component included. Nothing is priced marginally above the threshold.
Vectors: `price-condition-below`, `price-condition-at`, `price-condition-above`.

**COND-7. An unknown input at admission.** A consumer that reserves before the call, when it cannot bound
the input, sends `conditionInputs: { "inputTokens": "unknown" }` with its estimated quantities. The client
then:

1. evaluates every schedule for those quantities, so a refusal in any schedule refuses the request;
2. returns the schedule with the greatest exact total, the lowest interval on a tie;
3. writes every schedule into the basis.

At settlement, the consumer prices the actual usage with `priceFromBasis` (BASIS-3), which selects the
actual schedule. An offering without conditions ignores `conditionInputs`.
Vectors: `price-condition-unknown`, `basis-replay-reserve`, `basis-replay-settle-below`,
`basis-replay-settle-above`.

## 10. Time

**TIME-1. Instants and dates.** Every instant is an RFC 3339 UTC timestamp. These are all the instants
and dates the three documents hold, and the rule covers each of them wherever it appears:

| Where                     | Member                                                                                                                     | Form                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Catalog                   | `publishedAt`                                                                                                              | Instant, whole seconds |
| Catalog, rate entries     | `validFrom`, `validUntil`                                                                                                  | Instant, whole seconds |
| Catalog, every provenance | `readAt`, in a model's `provenance` and `statusProvenance`, in `effort.provenance`, and in every rate entry's `provenance` | Instant, whole seconds |
| Catalog, models           | `retiresOn`                                                                                                                | Date, `YYYY-MM-DD`     |
| Basis, priced components  | `validFrom`, `validUntil` (when not `null`)                                                                                | Instant, whole seconds |
| Price request             | `at`                                                                                                                       | Instant, up to ms      |

An instant in whole seconds matches

```text
^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$
```

The instant a call is priced at (`at`) MAY also carry one to three fractional digits:

```text
^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$
```

A date matches `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`. The rules on the fields:

- the year is 1970 to 9999;
- the month and day form a valid Gregorian date, so `2026-02-30` is refused even though it matches the
  pattern;
- the hour is 0 to 23, and minutes and seconds are 0 to 59, so leap seconds are refused;
- no offset other than `Z` is allowed.

A pattern alone cannot express the calendar, so a client MUST check it for every member in the table, not
only for the ones it prices with.

- In a catalog, a violation is rejected with `invalid-instant`.
- In a request, it is refused with `invalid-instant`.
- In a basis, it fails BASIS-4 with `invalid-basis`.

Instants are compared exactly, to the millisecond.
Vectors: `load-instant-offset`, `load-instant-fraction-in-window`, `load-instant-not-a-date`,
`load-readat-not-a-date`, `load-model-readat-not-a-date`, `load-retires-on-not-a-date`,
`price-invalid-instant`, `basis-window-not-a-date`.

**TIME-2. Half-open windows.** A rate entry is in force at instant `t` when `validFrom <= t` (or
`validFrom` is absent) and `t < validUntil` (or `validUntil` is absent). Pricing at `t` uses, for each
component of each schedule, the one entry in force at `t`.
Vectors: `price-window-before`, `price-window-whole-second-before`, `price-window-at`,
`price-window-after`.

**TIME-3. No overlap.** For each offering, schedule and component, no two entries may both be in force at
any instant. Otherwise the catalog is rejected with `windows-overlap`. `validFrom` MUST be earlier than
`validUntil` when both are present, or the catalog is rejected with `invalid-window`. Gaps are allowed.
Vectors: `load-windows-overlap`, `load-window-inverted`.

**TIME-4. Nothing in force.** A component that has no entry in force at `t` costs nothing at a zero
quantity (USAGE-3). A positive quantity for it is refused with `no-rate-in-force`.
Vectors: `price-no-rate-in-force`.

**TIME-5. Source dates without a time.** A source date without a time of day means 00:00 in the zone the
source states for it, or in UTC when the source states none. "Through D" ends at 00:00 on the day after
D, and "starting D" begins at 00:00 on D. Each entry's provenance records the rule applied, in
`dateRule`:

- `date-only-utc`: a date, no zone stated, read in UTC;
- `date-only-zoned`: a date in a zone the source states;
- `stated-instant`: the source states the instant;
- `undated`: the source states no date.

When the source names a zone for something else, such as a quota reset, that zone does not apply to its
prices. The UTC reading of a step up is the conservative one: if the provider meant a zone west of UTC,
the higher price applies a few hours early, never late. This binds data authors and readers. No client
vector.

**TIME-6. Undated changes.** A change read with no stated effective date takes effect at the `publishedAt`
of the release that first carries it, never earlier. It has `validFrom` equal to that `publishedAt`, and
`dateRule: "undated"`. A first reading of a rate is not a change: it has no `validFrom`, and is flagged
`undated`. This binds data authors and the release workflow. No client vector.

## 11. Identity

**ID-1. Lookup.** Every lookup is keyed by `(provider, modelId)`.

- An unknown provider is refused with `unknown-provider`.
- A model id that is neither a model's `id` nor one of its aliases within that provider is refused with
  `unknown-model`.

Vectors: `price-unknown-provider`, `price-unknown-model`.

**ID-2. Aliases.** A model's `aliases` is a list of `{ "id": "...", "status": "active" | "retired" }`. An
alias resolves to its model whatever its status, so that a retired alias still resolves for history.
Vectors: `price-alias-active`, `price-alias-retired`.

**ID-3. Uniqueness.** Within a catalog:

- provider ids are unique (`duplicate-provider`);
- within a provider, model ids are unique (`duplicate-model`), and alias ids are unique across all its
  models (`duplicate-alias`);
- within a model, tiers are unique (`duplicate-offering`).

Vectors: `load-duplicate-provider`, `load-duplicate-model`, `load-duplicate-alias`,
`load-duplicate-offering`.

**ID-4. Exact id wins.** An alias MAY equal the id of another model of the same provider only if the
alias is `retired`. An active alias equal to any model id of the provider, its own model's included, is
rejected with `alias-collision`. When a
retired alias equals a model id, the lookup resolves to that model: an exact id wins over an alias.
Vectors: `load-alias-collision`, `price-exact-id-wins`.

**ID-5. The resolved identity.** The basis records the provider, the resolved model id and the id the
consumer asked for (`model.requested`), so an alias lookup stays visible in the audit record.
Vectors: `price-alias-active`, `price-alias-retired`.

## 12. Pricing (`price`)

**PRICE-1. The request.** A price request has:

- `provider`, `modelId`, `tier`;
- `at`, the instant to price at (TIME-1);
- `usage`, a usage report (Section 7);
- `settlement`, `"estimate"` or `"booked"` (ROUND-4);
- optionally `conditionInputs: { "inputTokens": "unknown" }` (COND-7).

A missing or malformed `settlement` or `conditionInputs` is refused with `invalid-request`.

**PRICE-2. The procedure.** A client MUST compute the result as follows, and MUST report the first
refusal met in this order.

1. Check the request (PRICE-1, API-1) and the instant (`invalid-instant`).
2. Resolve the provider and the model (ID-1, ID-2, ID-4), then the offering (TIER-2).
3. Check the usage report's shape (USAGE-4), then the bound (NUM-3: `quantity-out-of-range`).
4. Build each schedule at `at`. For each component the offering lists, the entry is the one in force
   (TIME-2), or "no rate" when none is.
5. Check completeness against those schedules (USAGE-1, USAGE-2: `usage-incomplete` with `missing`).
6. Refuse a positive quantity for a component the offering does not list (`component-not-offered`),
   taking components in code-point order.
7. Choose the candidate schedules. That is every schedule if `conditionInputs.inputTokens` is
   `"unknown"`, otherwise the one schedule that holds for the input computed from the report (COND-6).
   An offering without conditions has one schedule.
8. For each candidate schedule in order, and each component with a positive quantity in code-point
   order:
   - an `unsupported` entry refuses with `unsupported-component`;
   - an `inapplicable` entry refuses with `inapplicable-component-used`;
   - "no rate" refuses with `no-rate-in-force`;
   - a compound unit refuses with `unsupported-unit`;
   - a priced entry adds `q * a / (p * f)` to the schedule's exact total (UNIT-2).
9. Choose the schedule (COND-6, COND-7), and take its exact total `N/D` (NUM-5).
10. Compute `estimate` (ROUND-2) and `booked` (ROUND-3) in the offering's currency.
11. Build the basis (Section 13).

**PRICE-3. The result.**

```json
{
  "provider": "openai",
  "modelId": "gpt-6.1-sol",
  "tier": "openai:standard",
  "currency": "USD",
  "schedule": 0,
  "exact": "1043/2500",
  "estimate": "0.42",
  "booked": "0.42",
  "basis": "{...canonical bytes...}",
  "basisSha256": "..."
}
```

Here `modelId` is the resolved id, and `schedule` is the index of the chosen schedule in the basis's
`schedules`. A client MAY return the basis as bytes or as a string, but its content MUST be byte-for-byte
the canonical form.
Vectors: every `price-*` vector.

**API-1. Arguments.** Every refusal of a public operation is one of the codes of Appendix A. An argument
that breaks an operation's preconditions is refused with a code, never with a language exception or an
error of another kind. In particular:

- `price`:
  - a request that is not an object, or a `provider`, `modelId` or `tier` that is not a string, is
    `invalid-request` (PRICE-1);
  - an `at` that is not a string is `invalid-instant`.
- `priceFromBasis`: a `conditionInputs` that is not absent or `{ "inputTokens": "unknown" }` is
  `invalid-request`. It is checked after the basis (BASIS-4) and before the usage report.
- `convertRate`:
  - a `scale` that is not an integer from 0 to 12 is `invalid-request`;
  - a `unit`, of the source rate or of the target, that is not a unit is `unknown-unit`;
  - a source `amount` that is not an amount (NUM-1) is `invalid-amount`;
  - a source `per` that is not a `per` (NUM-2) is `invalid-per`, as the target's is (UNIT-4, step 1).

  These are checked before the steps of UNIT-4.

Vectors: `price-request-not-object`, `price-request-array`, `price-provider-not-string`,
`price-model-id-not-string`, `price-tier-not-string`, `price-at-not-string`,
`price-condition-inputs-invalid`, `basis-replay-condition-inputs-invalid`, `convert-scale-too-large`,
`convert-scale-not-integer`, `convert-unknown-unit`, `convert-unknown-target-unit`,
`convert-invalid-amount`, `convert-invalid-source-per`.

### Other reads

A client also lists a provider's models and a model's effort levels (`effort.levels`, `effort.default`),
resolving the model by ID-1 and ID-2. They carry no money, and this specification does not fix their
shape beyond the catalog's.

## 13. The basis

**BASIS-1. The document.** The basis has exactly these members:

```json
{
  "basisVersion": 1,
  "origin": { "kind": "catalog", "version": "2026.11.04.1", "sha256": "<hex>" },
  "provider": "openai",
  "model": { "id": "gpt-6.1-sol", "requested": "gpt-6.1-sol" },
  "tier": "openai:standard",
  "currency": "USD",
  "rounding": { "rule": "half-up-once-on-total", "exponent": 2, "settlement": "booked" },
  "conditionInputs": {
    "inputTokens": ["cache_write_12h", "cache_write_30m", "input", "input_cached"]
  },
  "schedules": [
    {
      "condition": { "inputTokens": { "lte": 272000 } },
      "components": [
        {
          "component": "input",
          "disposition": "priced",
          "unit": "token",
          "per": 1000000,
          "amount": "2",
          "meter": "token",
          "factor": 1,
          "validFrom": null,
          "validUntil": null
        },
        { "component": "containers", "disposition": "unsupported" },
        { "component": "web_search", "disposition": "no-rate" }
      ]
    }
  ]
}
```

- **`origin`:** for a catalog, `{ "kind": "catalog", "version", "sha256" }`, where `sha256` is the
  lowercase hex sha256 of the catalog's bytes exactly as loaded. A consumer that priced from its own
  override writes `{ "kind": "override", "revision": "<id>" }`. A client never writes that form, but MUST
  accept it in `priceFromBasis`.
- **`model.requested`:** the id the consumer asked for (ID-5).
- **`rounding`:** `rule` is always `"half-up-once-on-total"`. `exponent` is the currency's `e`, and
  `settlement` is the request's.
- **`conditionInputs`:** the offering's, with each list sorted by code point. It is `{}` for an offering
  without conditions.
- **`schedules`:**
  - sorted by lower bound;
  - `condition` is `null` for an offering without conditions;
  - each schedule's `components` covers every component the offering lists, sorted by code point.
- **A priced component** carries `unit`, `per`, the canonical `amount` (NUM-4), its `meter` and `factor`
  (UNIT-1; both `null` for a compound unit), and the bounds of the window in force, or `null`.
- **Any other component** carries only `component` and `disposition`. That is `unsupported`,
  `inapplicable`, or `no-rate` when no entry was in force at `at`.
- **No free text, no provenance, and not the instant priced at.** Two calls priced from the same rates
  get the same basis bytes, and the digest names that rate revision.

Its values are only strings, nonnegative integers below 2^53, `null`, arrays and objects. Vectors:
every vector that pins `basis`.

**BASIS-2. Canonical bytes and the digest.** The basis bytes are the
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JSON Canonicalization Scheme) serialization of the
document, encoded as UTF-8. Its sha256 is written as lowercase hex. On the value types allowed here, RFC
8785 means:

- no whitespace;
- object members sorted by name, comparing UTF-16 code units (every name here is ASCII);
- integers written in decimal without exponent or fraction;
- strings with only `"`, `\` and the control characters below U+0020 escaped, using `\b`, `\t`, `\n`,
  `\f`, `\r` or `\u00xx` with lowercase hex. Everything else, `/` and non-ASCII included, is written as
  is.

A serializer's defaults often differ (escaped slashes, escaped Unicode, unsorted keys). A client MUST
produce exactly these bytes.
Vectors: every vector that pins `basisSha256`.

**BASIS-3. `priceFromBasis(basis, basisSha256, usage, conditionInputs?)`.** It prices a usage report from
a basis alone, without a catalog and without an instant. It runs steps 3 and 5 to 10 of PRICE-2, taking
the basis's schedules as the schedules of step 4, and returns
`{ currency, schedule, exact, estimate, booked }`. For the same usage and
`conditionInputs`, its result MUST equal the `price` result that produced the basis. At settlement, the
actual usage selects the actual schedule.
Vectors: `basis-replay-reserve`, `basis-replay-settle-below`, `basis-replay-settle-above`,
`basis-replay-window`.

**BASIS-4. Checking a basis.** Before it prices, `priceFromBasis` MUST:

1. compare the sha256 of the bytes with `basisSha256`, refusing with `basis-hash-mismatch`;
2. parse them and check `basisVersion`, refusing with `unsupported-basis-version` if it is not `1`;
3. check the document against `schema/basis.schema.json`, refusing with `invalid-basis`;
4. canonicalize it again and require byte equality, refusing with `invalid-basis`;
5. check that the document is one `price` could have written, refusing with `invalid-basis` otherwise.
   These checks are the whole of step 5:
   - `rounding.exponent` is the exponent of `currency` (ROUND-1);
   - each priced component's `meter` and `factor` are those UNIT-1 gives for its `unit` (`null` for a
     compound unit), its unit is of its component's dimension, its `amount` is canonical (NUM-4), its
     `validFrom` and `validUntil` are valid instants when set (TIME-1), and its `validFrom` is before
     its `validUntil` when both are set;
   - within each schedule, the components are in strictly ascending code-point order, so none repeats;
   - every schedule lists the same components;
   - the windows of the priced components have an instant in common, judged across all the priced entries
     of all the schedules together: the latest `validFrom` is before the earliest `validUntil` (a bound
     that is `null` does not count), because `price` writes the entry in force at one instant for every
     component of every schedule;
   - the tier is a tier of the basis's provider (TIER-1);
   - either there is one schedule, with `condition: null` and `conditionInputs: {}`, or there are two or
     more, each with a condition whose `gt` is below its `lte` (COND-1), in ascending order of lower
     bound, partitioning `[0, 2^53)` (COND-4), with `conditionInputs.inputTokens` sorted, and naming only
     token components that the schedules list.

A basis that is not in canonical form does not name the rates it holds. One that fails step 5 does not
price the same way in two clients, for example when one derives the factor from the unit and the other
trusts the stored factor. A consumer's override basis is held to the same checks.
Vectors: `basis-hash-mismatch`, `basis-not-canonical`, `basis-unsupported-version`,
`basis-factor-mismatch`, `basis-exponent-mismatch`, `basis-duplicate-component`,
`basis-schedules-not-exclusive`, `basis-schedules-inverted`, `basis-window-not-a-date`,
`basis-windows-disjoint`, `basis-windows-disjoint-schedules`, `basis-tier-provider-mismatch`, `basis-bom`, `basis-not-utf8`,
`basis-unpaired-surrogate`, `basis-too-deep`.

## 14. Load-time validation

**VAL-1. All or nothing.** A candidate catalog becomes a client's "last good" copy only when it passes
every check of this section. A candidate that fails any check is rejected as a whole, and the previous
last good copy stays in force. The rejection reports the code of a violated rule. Each rejecting vector
violates exactly one rule, so its code is determined.

**VAL-2. Hash.** When the caller supplies the expected sha256, the client compares it with the sha256 of
the bytes before parsing, and rejects a mismatch with `hash-mismatch`. The caller supplies it as a digest,
or as the text of the sidecar file `catalog.json.sha256`.

- The sidecar is in `sha256sum` format, `<digest>  catalog.json`. The digest is the first
  whitespace-delimited field of its first line; the rest of the file is ignored. The first line ends at the
  first line feed, and a carriage return before it is ignored.
- A digest MUST be 64 lowercase hexadecimal characters. Anything else is `hash-mismatch`: capital letters,
  another length, and a sidecar from which no such field can be read. The release job that writes the
  sidecar writes lowercase, and one spelling keeps clients from disagreeing.

A client MUST also reject a catalog whose `version` it already holds with different bytes, with
`version-conflict`. A client holds every version it has accepted since it was created, not only the one
now in force, and compares a version by the sha256 of the bytes it accepted. Loading the same bytes
again is not a conflict. `hash-mismatch` is for bytes that do not match the sha256 the caller supplied;
`version-conflict` is for a catalog that contradicts one the client already accepted. They are different
faults with different repairs. After either rejection the previous last good copy stays in force (VAL-1).
Vectors: `load-hash-mismatch`, `load-hash-uppercase`, `load-sidecar-two-fields`, `load-sidecar-uppercase`,
`load-sidecar-no-digest`, `load-version-conflict`.

**VAL-3. Schema version.** `schemaVersion` is a SemVer string. A 1.1.0 client accepts `1.0.x` and `1.1.x`
and rejects everything else with `unsupported-schema-version`. Its vocabularies are closed, so a client
cannot accept a newer minor version than its own: that version may add a component the client cannot
know. A client that knows a minor version reads every earlier minor version of the same major version,
because a minor version only adds (Section 16): a `1.0.x` catalog loads and prices as it did before. The
reverse does not hold: a 1.0.0 client accepts `1.0.x` only, so it rejects a `1.1.x` catalog and keeps its
last good copy (VAL-1). Each client states the range it supports.
Vectors: `load-unsupported-schema-version`, `load-accept-schema-1-0`.

**VAL-4. Structure.** The catalog MUST satisfy `schema/catalog.schema.json`. A violation that a more
specific rule names (NUM-1, NUM-2, ROUND-1, UNIT-1, COMP-1, TIER-1, TIME-1, VER-1, EFF-1) is reported with
that rule's code. Any other is `invalid-structure`: a missing or unknown member, a wrong type, a bad enum
value outside those rules.

A rule's code applies to a value of the member's own type:

- for `amount` and `per`, any wrong value, of any JSON type, is `invalid-amount` or `invalid-per`
  (NUM-1, NUM-2);
- for every other member a rule names (`currency`, `unit`, `component`, `tier`, instants, dates,
  `version` and effort levels), a value that is not a string is `invalid-structure`, and a string outside
  the vocabulary or the pattern gets the rule's code.

Vectors: `load-invalid-structure`, `load-currency-not-string`, `load-unit-not-string`,
`load-component-not-string`, `load-tier-not-string`, `load-instant-not-string`, `load-date-not-string`,
`load-version-not-string`, `load-effort-level-not-string`.

**VAL-5. One currency per offering.** Every priced entry of one offering has the same currency, so every
priced total has one currency. Otherwise the catalog is rejected with `mixed-currencies`.
Vectors: `load-mixed-currencies`.

**VAL-6. A priced offering.** Every offering has at least one `priced` entry. Its currency is the
offering's currency. Otherwise the catalog is rejected with `offering-without-price`. A model MAY have no
offerings at all (`offerings: []`): it is listed for its effort levels, and pricing it refuses with
`unknown-offering`.
Vectors: `load-offering-without-price`, `price-model-without-offerings`.

**VER-1. The version.** `version` matches `^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[1-9][0-9]*$`. The date part
is a valid date. Otherwise the catalog is rejected with `invalid-version`. See
[versioning](versioning.md).
Vectors: `load-invalid-version`.

**EFF-1. Effort.** When present, `effort.levels` is a nonempty list of distinct levels in ascending
order from `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, whatever order the source lists
them in. `effort.default` is one of the levels, or `null` when the source states none. Otherwise the
catalog is rejected with `invalid-effort`.
Vectors: `load-effort-default-not-in-levels`.

**VAL-7. Valid catalogs load.** Every fixture under `conformance/fixtures/` that is not under `invalid/`,
and `data/catalog.json`, MUST load.
Vectors: `load-accept-text`, `load-accept-dated`, `load-accept-conditional`, `load-accept-units`,
`load-accept-next`.

## 15. Per-provider rules

This section binds consumers (TIER-3, USAGE-2). It records what the sources read on 2026-11-04 say. Where
they are silent, it says so, and a consumer that cannot establish a component from the provider's
response MUST report `partial` rather than guess. No client vector.

### Anthropic (`anthropic`)

- **`anthropic:standard`:**
  - a Claude API (first-party) Messages request, not submitted through the Message Batches API;
  - not in fast mode;
  - with `inference_geo` absent or `"global"`, because US-only inference is priced at 1.1x and is not
    modelled;
  - the response's `usage.service_tier` is `"standard"`, and `usage.inference_geo`, where present, is
    `"global"`.

  A response reporting `"priority"` (Priority Tier capacity commitments) is not this tier.
- **`anthropic:batch`:** a request submitted through the Message Batches API, with its result read from
  the batch, with `inference_geo` absent or `"global"` for every request in it. US-only inference costs
  1.1x and stacks with the Batch discount, so a US-only batch request is not this tier.
- **Components:**
  - `input` ← `usage.input_tokens` (tokens after the last cache breakpoint);
  - `input_cached` ← `usage.cache_read_input_tokens`;
  - `cache_write_5m` ← `usage.cache_creation.ephemeral_5m_input_tokens`;
  - `cache_write_1h` ← `usage.cache_creation.ephemeral_1h_input_tokens`;
  - `output` ← `usage.output_tokens`;
  - `web_search` ← `usage.server_tool_use.web_search_requests`;
  - `code_execution`: the request's code execution time (unsupported in 1.0.0).

  Anthropic documents the total input as `cache_read_input_tokens + cache_creation_input_tokens +
  input_tokens`, and `cache_creation_input_tokens` as the sum of the `cache_creation` object. A report
  without the `cache_creation` split cannot tell the two lifetimes apart, and is `partial`.
  `server_tool_use` absent means no server tool ran, so its counts are zero.

### OpenAI (`openai`)

- **`openai:standard`:**
  - a Responses or Chat Completions request, not submitted through the Batch API, with `service_tier`
    absent, `"auto"` or `"default"`;
  - on a global (non-regional) endpoint, because regional processing adds 10% and is not modelled;
  - the response's `service_tier` is `"default"`.

  A project whose service tier is set to Fast sends Fast requests by default. A Fast request that OpenAI
  downgrades is reported as `"default"` and charged standard rates.
- **Components:**
  - `input` ← `usage.input_tokens − input_tokens_details.cached_tokens − input_tokens_details.
    cache_write_tokens`;
  - `input_cached` ← `input_tokens_details.cached_tokens`;
  - `cache_write_30m` and `cache_write_12h` ← `input_tokens_details.cache_write_tokens`, split by the
    lifetime requested (`prompt_cache_options.ttl`, or a breakpoint's own `ttl`). A request that mixes
    lifetimes has no reported split, and is `partial`;
  - `output` ← `usage.output_tokens`, which includes reasoning tokens;
  - `web_search` and `file_search` ← the tool calls of each kind;
  - `containers`: hosted shell and code interpreter sessions (unsupported).

  The `inputTokens` condition input is `input + input_cached + cache_write_30m + cache_write_12h`, which
  is `usage.input_tokens`.
- **Codex CLI.** Codex's `turn.completed` usage reports `input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens` (since Codex PR #33454) and `output_tokens`, and no tool calls.
  - Both cache shares are inside `input_tokens`. Codex copies the Responses API's `usage.input_tokens`
    and the two members of `input_tokens_details` unchanged (codex-rs 0.163.0 and 0.166.0,
    `codex-api/src/sse/responses.rs`). So `input` is `input_tokens` minus both shares, and
    `input_cached` and the write component take the shares.
  - Codex sends no cache lifetime, so the writes have OpenAI's default 30-minute lifetime and map to
    `cache_write_30m`. A Codex version that sets a lifetime changes this mapping.
  - A report built from it is `partial` unless the consumer establishes the tool components otherwise.

### Google Gemini (`google-gemini`)

- **`google-gemini:standard`:**
  - a Gemini Developer API request (`generativelanguage.googleapis.com`) from a paid-tier project;
  - not submitted through the Batch API;
  - not requesting Flex or Priority inference;
  - not on the Contributor tier.

  The free tier is not modelled. Vertex AI is a different product with its own prices, and is not this
  provider.
- **Components:**
  - `output` includes thinking tokens: the page prices "Output price (including thinking tokens)", and
    the Interactions API reports thinking separately as `total_thought_tokens`, so `output` ←
    `total_output_tokens + total_thought_tokens`;
  - `input_cached` ← `total_cached_tokens` (context-cache reads);
  - `input` ← the remaining input. The sources read do not state whether `total_input_tokens` includes
    `total_cached_tokens`, or how `total_tool_use_tokens` is billed, so a consumer MUST establish this
    before reporting `complete`;
  - Gemini 3.8 Flash publishes one input price for every input modality, so audio input is `input`;
  - for the speech models, `input` is the text tokens and `output_audio` the audio tokens, at 25 tokens
    per second of audio;
  - `grounding_search`, `grounding_maps`: grounding requests (unsupported, since they include a monthly
    free allowance);
  - `generation` ← the number of successful generations. The page prices Lyria "per request", as
    "$0.08 per song" and "$0.04 per song", so a song or a clip is one `generation` at `request` per 1. A
    consumer reports one `generation` per song that was generated and returned, and none for a request
    that failed or produced nothing. Whether Google bills a failed or blocked request is not stated on
    the page, so a consumer MUST NOT report a `generation` it did not receive;
  - `cache_storage` is not per call.

### ElevenLabs (`elevenlabs`)

- **`elevenlabs:pay-as-you-go`:** an API request billed in US dollars at the per-product API rate. The
  page gives the same per-unit API rate in every plan column. Characters or minutes included in a plan
  are not modelled.
- **Components:**
  - `characters`: the characters billed for a text-to-speech request. The page says "billed per
    character" and does not say which characters count;
  - `output_audio_duration`: the duration of the generated music or sound effect, in milliseconds. The
    page states the price per minute and that music and sound effects are "billed per generation". It
    does not state how a generation's billed duration is measured: no rounding, minimum or granularity.
    The catalog therefore records the rate the page states, and nothing about the quantity.
  - A consumer that reports the generated duration is assuming that billed duration equals generated
    duration, prorated to the millisecond. That is the consumer's assumption, not the provider's
    statement. The consumer MUST record the figure as an estimate, not as a reported charge, until it has
    established the metering from the provider's invoice or documentation.
- **Product names:** the page names products, not model ids. The name map is in
  [sources](sources.md#elevenlabs-product-names).

## 16. Versioning of the contract

- `schemaVersion` follows SemVer. A **patch** version changes text and examples only. A **minor** version
  may add components, units, tiers, currencies, condition inputs or optional members, and never changes
  the meaning of what an earlier version defines: a client of a later minor version reads every
  earlier minor version unchanged. A **major** version may change meanings. Clients reject versions
  outside their range (VAL-3).
- Version 1.1.0 adds the component `generation` (COMP-1) and nothing else.
- The basis has its own `basisVersion` (currently 1). A client reads every basis version it ever wrote,
  forever, and never rewrites a stored basis.
- Data versions are dated: see [versioning](versioning.md).

## Appendix A. Error codes

| Code                          | Raised by           | Rule             |
| ----------------------------- | ------------------- | ---------------- |
| `invalid-json`                | load, price, replay | JSON-1, JSON-2   |
| `hash-mismatch`               | load                | VAL-2            |
| `version-conflict`            | load                | VAL-2            |
| `unsupported-schema-version`  | load                | VAL-3            |
| `invalid-structure`           | load                | VAL-4, COND-1    |
| `invalid-amount`              | load, conv          | NUM-1            |
| `invalid-per`                 | load, convertRate   | NUM-2, UNIT-4    |
| `unknown-currency`            | load                | ROUND-1          |
| `unknown-unit`                | load, conv          | UNIT-1           |
| `unit-mismatch`               | load                | UNIT-1           |
| `unknown-component`           | load                | COMP-1           |
| `unknown-tier`                | load                | TIER-1           |
| `tier-provider-mismatch`      | load                | TIER-1           |
| `invalid-instant`             | load, price         | TIME-1           |
| `invalid-window`              | load                | TIME-3           |
| `windows-overlap`             | load                | TIME-3           |
| `condition-inputs-invalid`    | load                | COND-2           |
| `conditions-mixed`            | load                | COND-3           |
| `conditions-not-exclusive`    | load                | COND-4           |
| `conditions-not-covering`     | load                | COND-4           |
| `schedules-mismatch`          | load                | COND-5           |
| `duplicate-provider`          | load                | ID-3             |
| `duplicate-model`             | load                | ID-3             |
| `duplicate-alias`             | load                | ID-3             |
| `duplicate-offering`          | load                | ID-3             |
| `alias-collision`             | load                | ID-4             |
| `mixed-currencies`            | load                | VAL-5            |
| `offering-without-price`      | load                | VAL-6            |
| `invalid-version`             | load                | VER-1            |
| `invalid-effort`              | load                | EFF-1            |
| `invalid-request`             | price, replay, conv | PRICE-1          |
| `unknown-provider`            | price               | ID-1             |
| `unknown-model`               | price               | ID-1             |
| `unknown-offering`            | price               | TIER-2, VAL-6    |
| `invalid-usage`               | price, replay       | USAGE-4, NUM-3   |
| `quantity-out-of-range`       | price, replay       | NUM-3            |
| `usage-incomplete`            | price, replay       | USAGE-1, USAGE-2 |
| `component-not-offered`       | price, replay       | COMP-3           |
| `unsupported-component`       | price, replay       | COMP-2           |
| `inapplicable-component-used` | price, replay       | COMP-2           |
| `no-rate-in-force`            | price, replay       | TIME-4           |
| `unsupported-unit`            | price, replay, conv | UNIT-3, UNIT-4   |
| `basis-hash-mismatch`         | replay              | BASIS-4          |
| `unsupported-basis-version`   | replay              | BASIS-4          |
| `invalid-basis`               | replay              | BASIS-4          |
| `dimension-mismatch`          | convertRate         | UNIT-4           |
| `inexact-conversion`          | convertRate         | UNIT-4           |

`invalid-json` is raised by `load`, and by `price` and `priceFromBasis` for a usage report that is read
from JSON text (JSON-1, JSON-2).

A `usage-incomplete` refusal also carries `missing`, the sorted list of USAGE-1.

## Appendix B. Rules and their vectors

Each vector's `rule` names one rule from this page. The check `npm run conformance:check` fails when a
vector names a rule this page does not define, or when a rule above that names vectors has none.

| Rule    | Vectors                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NUM-1   | `load-amount-leading-zero`, `load-amount-number`, `load-amount-exponent`, `load-amount-too-many-decimals`, `load-amount-negative`, `load-amount-negative-zero`                                                                                                                                                                                                                                                                |
| NUM-2   | `load-per-not-power-of-ten`, `load-per-zero`, `load-per-too-large`, `load-per-string`                                                                                                                                                                                                                                                                                                                                         |
| NUM-3   | `price-quantity-over-bound`, `price-quantity-negative`, `price-quantity-fraction`, `price-quantity-negative-zero`                                                                                                                                                                                                                                                                                                             |
| NUM-4   | `price-unit-minute`, `convert-characters`                                                                                                                                                                                                                                                                                                                                                                                     |
| NUM-5   | `price-typical`, `price-unit-minute-recurring`, `price-zero-usage`                                                                                                                                                                                                                                                                                                                                                            |
| ROUND-1 | `load-unknown-currency`                                                                                                                                                                                                                                                                                                                                                                                                       |
| ROUND-2 | `price-rounded-once`, `price-sub-cent`, `price-typical`                                                                                                                                                                                                                                                                                                                                                                       |
| ROUND-3 | `price-sub-cent`, `price-unit-minute-recurring`, `price-zero-usage`                                                                                                                                                                                                                                                                                                                                                           |
| ROUND-4 | `price-settlement-estimate`                                                                                                                                                                                                                                                                                                                                                                                                   |
| UNIT-1  | `load-unknown-unit`, `load-unit-mismatch`, `load-unknown-unit-inherited-name`, `load-storage-priced-unit-mismatch`, `load-storage-priced-unknown-unit`, `load-generation-unit-mismatch`                                                                                                                                                                                                                                       |
| UNIT-2  | `price-unit-character`, `price-unit-request`, `price-unit-millisecond`, `price-unit-second`, `price-unit-minute`, `price-unit-minute-recurring`, `price-unit-hour`, `price-typical`, `price-unit-generation`                                                                                                                                                                                                                  |
| UNIT-3  | `price-unit-token-hour`, `convert-compound`                                                                                                                                                                                                                                                                                                                                                                                   |
| UNIT-4  | `convert-minute-to-million-ms`, `convert-minute-recurring`, `convert-characters`, `convert-scale-too-small`, `convert-scale-enough`, `convert-second-to-ms`, `convert-dimension-mismatch`, `convert-invalid-per`                                                                                                                                                                                                              |
| COMP-1  | `load-unknown-component`, `load-unknown-component-inherited-name`, `load-generation-in-schema-1-0`                                                                                                                                                                                                                                                                                                                            |
| COMP-2  | `price-unsupported-in-use`, `price-inapplicable-in-use`, `price-condition-above-unsupported-write`                                                                                                                                                                                                                                                                                                                            |
| COMP-3  | `price-component-not-offered`                                                                                                                                                                                                                                                                                                                                                                                                 |
| COMP-4  | `price-window-before`, `price-unit-token-hour`                                                                                                                                                                                                                                                                                                                                                                                |
| USAGE-1 | `price-usage-partial`, `price-usage-totals-only`, `price-usage-unknown`                                                                                                                                                                                                                                                                                                                                                       |
| USAGE-2 | `price-usage-complete-missing`                                                                                                                                                                                                                                                                                                                                                                                                |
| USAGE-3 | `price-zero-usage`                                                                                                                                                                                                                                                                                                                                                                                                            |
| USAGE-4 | `price-usage-invalid-completeness`                                                                                                                                                                                                                                                                                                                                                                                            |
| TIER-1  | `load-unknown-tier`, `load-tier-provider-mismatch`, `load-tier-unknown-prefix`                                                                                                                                                                                                                                                                                                                                                |
| TIER-2  | `price-unknown-offering`                                                                                                                                                                                                                                                                                                                                                                                                      |
| COND-2  | `load-condition-inputs-invalid`, `load-condition-inputs-empty`, `load-condition-inputs-duplicate`, `load-condition-inputs-unknown-component`                                                                                                                                                                                                                                                                                  |
| COND-3  | `load-conditions-mixed`                                                                                                                                                                                                                                                                                                                                                                                                       |
| COND-4  | `load-conditions-not-exclusive`, `load-conditions-not-covering`, `load-conditions-last-bounded`                                                                                                                                                                                                                                                                                                                               |
| COND-5  | `load-schedules-mismatch`                                                                                                                                                                                                                                                                                                                                                                                                     |
| COND-6  | `price-condition-below`, `price-condition-at`, `price-condition-above`                                                                                                                                                                                                                                                                                                                                                        |
| COND-7  | `price-condition-unknown`, `basis-replay-reserve`, `basis-replay-settle-below`, `basis-replay-settle-above`                                                                                                                                                                                                                                                                                                                   |
| TIME-1  | `load-instant-offset`, `load-instant-fraction-in-window`, `load-instant-not-a-date`, `load-readat-not-a-date`, `load-model-readat-not-a-date`, `load-retires-on-not-a-date`, `price-invalid-instant`, `basis-window-not-a-date`                                                                                                                                                                                               |
| TIME-2  | `price-window-before`, `price-window-whole-second-before`, `price-window-at`, `price-window-after`                                                                                                                                                                                                                                                                                                                            |
| TIME-3  | `load-windows-overlap`, `load-window-inverted`                                                                                                                                                                                                                                                                                                                                                                                |
| TIME-4  | `price-no-rate-in-force`                                                                                                                                                                                                                                                                                                                                                                                                      |
| ID-1    | `price-unknown-provider`, `price-unknown-model`                                                                                                                                                                                                                                                                                                                                                                               |
| ID-2    | `price-alias-active`, `price-alias-retired`                                                                                                                                                                                                                                                                                                                                                                                   |
| ID-3    | `load-duplicate-provider`, `load-duplicate-model`, `load-duplicate-alias`, `load-duplicate-offering`                                                                                                                                                                                                                                                                                                                          |
| ID-4    | `load-alias-collision`, `price-exact-id-wins`                                                                                                                                                                                                                                                                                                                                                                                 |
| ID-5    | `price-alias-active`, `price-alias-retired`                                                                                                                                                                                                                                                                                                                                                                                   |
| PRICE-1 | `price-invalid-request`                                                                                                                                                                                                                                                                                                                                                                                                       |
| API-1   | `price-request-not-object`, `price-request-array`, `price-provider-not-string`, `price-model-id-not-string`, `price-tier-not-string`, `price-at-not-string`, `price-condition-inputs-invalid`, `basis-replay-condition-inputs-invalid`, `convert-scale-too-large`, `convert-scale-not-integer`, `convert-unknown-unit`, `convert-unknown-target-unit`, `convert-invalid-amount`, `convert-invalid-source-per`                 |
| BASIS-3 | `basis-replay-reserve`, `basis-replay-settle-below`, `basis-replay-settle-above`, `basis-replay-window`                                                                                                                                                                                                                                                                                                                       |
| BASIS-4 | `basis-hash-mismatch`, `basis-not-canonical`, `basis-unsupported-version`, `basis-factor-mismatch`, `basis-exponent-mismatch`, `basis-duplicate-component`, `basis-schedules-not-exclusive`, `basis-schedules-inverted`, `basis-window-not-a-date`, `basis-windows-disjoint`, `basis-tier-provider-mismatch`, `basis-bom`, `basis-not-utf8`, `basis-unpaired-surrogate`, `basis-too-deep`, `basis-windows-disjoint-schedules` |
| VAL-2   | `load-hash-mismatch`, `load-version-conflict`, `load-hash-uppercase`, `load-sidecar-two-fields`, `load-sidecar-uppercase`, `load-sidecar-no-digest`                                                                                                                                                                                                                                                                           |
| VAL-3   | `load-unsupported-schema-version`, `load-accept-schema-1-0`                                                                                                                                                                                                                                                                                                                                                                   |
| VAL-4   | `load-invalid-structure`, `load-currency-not-string`, `load-unit-not-string`, `load-component-not-string`, `load-tier-not-string`, `load-instant-not-string`, `load-date-not-string`, `load-version-not-string`, `load-effort-level-not-string`                                                                                                                                                                               |
| VAL-5   | `load-mixed-currencies`                                                                                                                                                                                                                                                                                                                                                                                                       |
| VAL-6   | `load-offering-without-price`, `price-model-without-offerings`                                                                                                                                                                                                                                                                                                                                                                |
| VAL-7   | `load-accept-text`, `load-accept-dated`, `load-accept-conditional`, `load-accept-units`, `load-accept-next`, `load-accept-generation`                                                                                                                                                                                                                                                                                         |
| JSON-1  | `load-duplicate-member`, `load-json-bom`, `load-json-not-utf8`, `load-json-unpaired-surrogate`, `load-json-too-deep`                                                                                                                                                                                                                                                                                                          |
| JSON-2  | `load-per-fraction-rounds`, `load-per-negative-zero`, `load-integer-negative-zero`                                                                                                                                                                                                                                                                                                                                            |
| VER-1   | `load-invalid-version`                                                                                                                                                                                                                                                                                                                                                                                                        |
| EFF-1   | `load-effort-default-not-in-levels`                                                                                                                                                                                                                                                                                                                                                                                           |

PRICE-2, PRICE-3, BASIS-1 and BASIS-2 are pinned by every accepting `price-*` vector. COND-1, TIER-3,
TIME-5, TIME-6 and VAL-1 bind data authors or consumers, or are checked through the codes above.

## Appendix C. Worked examples

The hand-check set in the [conformance README](../conformance/README.md#hand-checked-vectors) writes out
five vectors in full. Every vector carries its own `derivation`.
