# Data format

> **Status: schema 1.2.0.** This page describes the shape of `catalog.json` for people. The definition
> is the JSON Schema in [`schema/`](../schema/), and the rules no schema can express are in the
> [specification](specification.md). Where this page and those differ, they win.

## Purpose

To say what `catalog.json` contains, so that a reader of this repository can understand a model entry
without opening the schema.

## The objects

A catalog is published as `catalog.json` plus `catalog.json.sha256`, under a git tag and a release.

| Object              | Contents                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **catalog**         | `schemaVersion` (`1.0.0`, `1.1.0` or `1.2.0`), `version` (`YYYY.MM.DD.N`), `publishedAt`, `providers[]`                                                                                                                                                           |
| **provider**        | `id` (`anthropic`, `openai`, `google-gemini`, `elevenlabs`), `name`, `pricingUrls[]`, `models[]`                                                                                                                                                                  |
| **model**           | `id` (the provider's API model id), `name`, `aliases[]`, `status`, optional `retiresOn`, `capabilities[]`, optional `effort`, optional `inputModalities`, `offerings[]`, `provenance`, and `statusProvenance` when the status is not `available` or a date is set |
| **alias**           | `{ id, status }`, where `status` is `active` or `retired`                                                                                                                                                                                                         |
| **effort**          | `levels[]` in ascending order from `none` to `max`, `default` (or `null` when the source states none), `provenance`                                                                                                                                               |
| **inputModalities** | `values[]` (from `text`, `image`, `audio`, `video`, `pdf`, in that order), `provenance`. New in 1.2.0                                                                                                                                                             |
| **offering**        | `tier` (such as `openai:standard`), optional `conditionInputs`, `rates[]`                                                                                                                                                                                         |
| **rate**            | `component`, `disposition`, then either `unit`, `per`, `amount`, `currency` (priced) or `reason` (otherwise), optional `condition`, `validFrom`, `validUntil`, and `provenance`                                                                                   |

A model with `offerings: []` is listed for its identity and effort levels only. Pricing it refuses.

## Input modalities

`inputModalities` says what kinds of content a model accepts as input, as the model's own page states it:

```json
"inputModalities": {
  "values": ["text", "image", "audio", "video", "pdf"],
  "provenance": { "...": "the model page, the date read, the cited bytes" }
}
```

- **Absent means not established.** A model with no `inputModalities` says nothing about its input. It is
  never "text only".
- **Present means the page lists these.** A value that is not in `values` is one the page does not list for
  the model, so a client may read it as "not accepted". A value is never added because a sibling model
  accepts it.
- **Closed set, fixed order.** `text`, `image`, `audio`, `video` and `pdf`, each at most once, in that order.
  A new value is a minor version.
- **Entered by hand.** No reader reads the model pages, and the update job does not track the member: a
  change on a provider's page does not open a pull request. A person re-reads the page, and the member's
  `provenance` records the page and the day it was read.
- **Nothing is priced from it.** No rate depends on it, and it adds no component. A model that bills audio
  input at a rate of its own would need one; no model in the catalog does, so `input_audio` is not defined.

## Rates

```json
{
  "component": "input",
  "disposition": "priced",
  "unit": "token",
  "per": 1000000,
  "amount": "0.75",
  "currency": "USD",
  "validUntil": "2027-01-01T00:00:00Z",
  "provenance": { "...": "see below" }
}
```

- **Amounts** are decimal strings, never JSON numbers: `^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$`.
- **`per`** is a power of ten from 1 to 10^9. A rate costs `amount` for every `per` units.
- **Units** are `token`, `character`, `request`, `millisecond`, `second`, `minute`, `hour`, and the
  compound `token-hour`. A per-minute price is stored as the source states it,
  `{ "unit": "minute", "per": 1, "amount": "0.15" }`. Usage is metered in milliseconds and priced
  exactly. Compound units are never priced in 1.1.0.
- **Components** come from a closed vocabulary: `input`, `input_cached`, `cache_write_5m`,
  `cache_write_1h`, `cache_write_30m`, `cache_write_12h`, `output`, `output_audio`, `characters`,
  `output_audio_duration`, `web_search`, `file_search`, `grounding_search`, `grounding_maps`, `generation`,
  `code_execution`, `containers`, `cache_storage` and `file_search_storage`. Their meanings, and which
  are per call, are in Section 6 of the specification.
- **Dispositions:** each offering lists every billable component its source publishes, as one of:
  - `priced`;
  - `inapplicable`, with a `reason`: the source says it does not apply;
  - `unsupported`, with a `reason`: a charge this version cannot price, such as one with a monthly free
    allowance.

  Using an `unsupported` or `inapplicable` component makes pricing refuse.
- **Currencies:** `USD`, `EUR` or `GBP`. One offering has one currency.

## Dated rates

A rate entry is in force in the half-open window `[validFrom, validUntil)`, in RFC 3339 UTC, whole
seconds. An absent bound is open. For each schedule and component, windows never overlap. A step on a
known date is two entries:

```json
[
  { "component": "input", "amount": "0.75", "validUntil": "2027-01-01T00:00:00Z", "...": "..." },
  { "component": "input", "amount": "1.50", "validFrom": "2027-01-01T00:00:00Z", "...": "..." }
]
```

A date without a time means 00:00 UTC unless the source states a zone for it, and each entry's
`provenance.dateRule` records the reading (`undated`, `date-only-utc`, `date-only-zoned` or
`stated-instant`).

## Conditions

An offering whose price depends on the size of the request declares the input and gives every rate a
condition:

```json
{
  "tier": "openai:standard",
  "conditionInputs": {
    "inputTokens": ["input", "input_cached", "cache_write_30m", "cache_write_12h"]
  },
  "rates": [
    {
      "component": "input",
      "condition": { "inputTokens": { "lte": 272000 } },
      "amount": "2.00",
      "...": "..."
    },
    {
      "component": "input",
      "condition": { "inputTokens": { "gt": 272000 } },
      "amount": "4.00",
      "...": "..."
    }
  ]
}
```

The conditions of one offering partition every possible input, every schedule lists the same components,
and the whole call is priced at the one schedule that holds.

## Provenance

Every rate, model identity, status, effort list and list of input modalities carries `provenance`:

```json
{
  "source": "gemini-pricing",
  "url": "https://ai.google.dev/gemini-api/docs/pricing.md.txt",
  "readAt": "2026-11-04T16:49:21Z",
  "reader": "manual",
  "evidence": "2ec77fa3d4b0fc3437d83edcc3e8c9abbe3beb8b1457c494435e840936c9b44e",
  "location": {
    "path": "## Gemini 3.8 Flash › Standard tab › Paid Tier › 'Input price'",
    "offset": 12345,
    "excerpt": "$0.75 through December 31, 2026.",
    "anchors": [
      { "offset": 10000, "excerpt": "## Gemini 3.8 Flash  {% id=\"gemini-3.8-flash\" %}" }
    ]
  },
  "dateRule": "date-only-utc"
}
```

- **`reader`:** `manual` for a value entered by hand, otherwise `<reader>@<version>`.
- **`evidence`:** the sha256 of the page's bytes, stored under [`evidence/`](../evidence/).
- **`location`:** the cited bytes. `excerpt` is exactly the bytes at `offset` in the evidence, and
  `anchors` are further cited bytes in the same page, such as the row label and the column header.
  `npm run check` verifies every one.
- **`derivation`:** replaces `location` for a value the page states as a rule over other stated values,
  for example "Batch and prompt caching multipliers stack". It has `formula` and at least two cited
  `inputs`, each with its own evidence, URL, path, offset and excerpt.
- **`note`:** a reading the location alone does not show.

## Not modelled

Plan-based discounts, credits, free tiers and allowances, and regional prices. Applications express those
as their own overrides. See [trust and provenance](trust-and-provenance.md).
