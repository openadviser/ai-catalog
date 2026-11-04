# Data format

> **Status: Draft — specified in C1.** This page describes the shape of the catalog. The field-by-field
> definition is the JSON Schema in [`schema/`](../schema/) and the [specification](specification.md).

## Purpose

To say what `catalog.json` contains, so that a reader of this repository can understand a model entry
without opening the schema.

## What it will hold

A catalog is published as `catalog.json` plus `catalog.json.sha256`, under a git tag and a release.

| Object       | Contents                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **catalog**  | `schemaVersion`, `version`, `generatedAt`, `providers[]`                                                                                         |
| **provider** | `id`, `name`, `pricingUrls[]`, `models[]`. Provider ids are our own and stable, for example `anthropic`, `openai`, `google-gemini`, `elevenlabs` |
| **model**    | `id` (the provider's API model id), `aliases[]`, `status`, `capabilities[]`, optional `effort`, `offerings[]`                                    |
| **offering** | One way of buying the model: a `tier` and its `rates[]`. The tier comes from the source table it was read from                                   |
| **rate**     | `component`, `unit`, `per`, `amount`, `currency`, optional `validFrom`, `validUntil` and `condition`, and `provenance`                           |

Further rules that are already decided:

- `status` is one of `preview`, `available`, `deprecated` or `retired`, with an optional `retiresOn`.
- `effort` is `{ levels[], default, source }`.
- `unit` is one of `token`, `character`, `second`, `millisecond` or `request`. Compound units, such as
  cache storage per token-hour, are a separate unit kind. A client that cannot price one refuses.
- `component` comes from a closed vocabulary that is versioned with the schema. Examples: `input`,
  `input_cached`, `output`, `cache_write_5m`, `cache_write_1h`, `input_audio`, `output_audio`,
  `characters`, `audio_seconds`, `request`.
- Each offering lists every billable component its source publishes, with one disposition each:
  `priced`, `inapplicable` (with the reason) or `unsupported`. Any use of an `unsupported` component
  makes pricing refuse.
- `provenance` is `{ source, url, readAt, readerVersion }`.
- Amounts are decimal strings, never JSON numbers. `per` is a power of ten from 1 to 10^9.
- **Dated rates.** For each model, tier, component and condition there is an ordered list of
  non-overlapping validity windows, half-open `[validFrom, validUntil)` in RFC 3339 UTC. A client picks
  the window that contains the instant it prices at.
- **Conditions** are typed predicates. The first is `inputTokens > N`, which prices the whole call at
  the tier's conditional rates when it holds. The conditional schedules of one offering must be mutually
  exclusive and cover every input.
- **Tiers** are specific to each provider and named as the source names them, for example
  `openai:standard` and `openai:batch`.
- **Identity.** Every lookup is keyed by `(provider, modelId)`. Aliases are unique within a provider, an
  exact id wins over an alias, and a retired alias still resolves for history.

## Not modelled

Plan-based discounts, credits, free tiers and regional prices. Applications express those as their own
overrides. See [trust and provenance](trust-and-provenance.md).

## Decided in later slices

The exact field names, formats and bounds are fixed in C1. Do not rely on this page for them.
