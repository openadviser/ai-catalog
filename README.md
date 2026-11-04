# AI Catalog

**Prices, models and effort levels for AI APIs, read from the providers' own pages every day, cross-checked, and published as versioned JSON with dated rates.**

[![CI](https://github.com/openadviser/ai-catalog/actions/workflows/ci.yml/badge.svg)](https://github.com/openadviser/ai-catalog/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Catalog version: unreleased](https://img.shields.io/badge/catalog-unreleased-lightgrey.svg)

> **Status: contract and first data, unreleased.** The pricing [specification](docs/specification.md),
> the JSON Schema, the [conformance vectors](conformance/) and the first catalog are in place. The catalog
> was entered by hand from the providers' pages, with the evidence for every value. The readers, the
> TypeScript and PHP clients and the release workflow arrive in later slices, so no catalog has been
> released yet, and nothing here is a price to rely on until one is.

## Why it exists

Anything that spends money on AI APIs needs the current price of a model, and needs to know when that
price changes. Prices live on pricing pages meant for people, and every consumer ends up keeping its own
copy, which goes stale. This catalog keeps one copy, with a paper trail.

- **Official pages are the only truth.** Every price is read from the provider's own page. Third-party
  datasets are read as a cross-check, never depended on.
- **Every price carries its source and date.** Each rate records the page it came from, when it was read
  and by which version of the reader.
- **Changes arrive as reviewed pull requests.** A change that two independent sources agree on, within a
  set factor, merges by itself. Anything else waits for a person.
- **Dated rates are first-class.** A rate that changes on a known date is stored as two validity windows,
  so a client prices a call at the rate that applied at that instant.
- **Every client prices the same way.** Exact decimal arithmetic, one rounding, and shared conformance
  vectors that every client release must pass.

## What a model looks like

An illustrative excerpt, valid against schema 1.0.0. The tier, component and unit names are the schema's
vocabulary. **The model, the amounts, the dates, the URL, the offsets and the evidence hash are made
up.** The input rate steps up on a known date, so it is two entries, and a published charge the schema
cannot price is listed as `unsupported`. `npm run check` validates this excerpt against the schema.

```json
{
  "id": "example-model",
  "name": "Example Model",
  "aliases": [{ "id": "example-model-latest", "status": "active" }],
  "status": "available",
  "capabilities": ["text-generation"],
  "effort": {
    "levels": ["low", "medium", "high"],
    "default": "medium",
    "provenance": {
      "source": "example-models",
      "url": "https://example.com/models",
      "readAt": "2026-01-05T09:00:00Z",
      "reader": "manual",
      "evidence": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "location": {
        "path": "Example Model › effort",
        "offset": 4096,
        "excerpt": "low, medium (default), high"
      }
    }
  },
  "offerings": [
    {
      "tier": "google-gemini:standard",
      "rates": [
        {
          "component": "input",
          "disposition": "priced",
          "unit": "token",
          "per": 1000000,
          "amount": "1.00",
          "currency": "USD",
          "validUntil": "2027-01-01T00:00:00Z",
          "provenance": {
            "source": "example-pricing",
            "url": "https://example.com/pricing",
            "readAt": "2026-01-05T09:00:00Z",
            "reader": "manual",
            "evidence": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
            "location": {
              "path": "Example Model › Input",
              "offset": 2048,
              "excerpt": "$1.00 through December 31, 2026."
            },
            "dateRule": "date-only-utc"
          }
        },
        {
          "component": "input",
          "disposition": "priced",
          "unit": "token",
          "per": 1000000,
          "amount": "2.00",
          "currency": "USD",
          "validFrom": "2027-01-01T00:00:00Z",
          "provenance": {
            "source": "example-pricing",
            "url": "https://example.com/pricing",
            "readAt": "2026-01-05T09:00:00Z",
            "reader": "manual",
            "evidence": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
            "location": {
              "path": "Example Model › Input",
              "offset": 2090,
              "excerpt": "$2.00 starting January 1, 2027."
            },
            "dateRule": "date-only-utc"
          }
        },
        {
          "component": "grounding_search",
          "disposition": "unsupported",
          "reason": "Includes a monthly free allowance, which is not modelled.",
          "provenance": {
            "source": "example-pricing",
            "url": "https://example.com/pricing",
            "readAt": "2026-01-05T09:00:00Z",
            "reader": "manual",
            "evidence": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
            "location": {
              "path": "Example Model › Grounding",
              "offset": 2300,
              "excerpt": "1,000 free requests per month"
            },
            "dateRule": "undated"
          }
        }
      ]
    }
  ],
  "provenance": {
    "source": "example-pricing",
    "url": "https://example.com/pricing",
    "readAt": "2026-01-05T09:00:00Z",
    "reader": "manual",
    "evidence": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    "location": { "path": "Example Model › model id", "offset": 1980, "excerpt": "`example-model`" }
  }
}
```

The rules this excerpt follows:

- Amounts are decimal strings, never JSON numbers.
- A rate is in force in the half-open window `[validFrom, validUntil)`, in UTC.
- Every value cites the bytes of the page it was read from: its `evidence` is the sha256 of a file in
  [`evidence/`](evidence/), and its `location` gives the exact excerpt at a byte offset.

See [data format](docs/data-format.md).

## Quick start

Both clients behave the same way: load a catalog, check its hash and schema version, and price a call
for a model, a tier, a usage report and an instant.

**TypeScript** (Node 26), from [`clients/ts/`](clients/ts/). It is not published to npm yet:

```ts
import { load, price } from "@openadviser/ai-catalog";

const catalog = await load("<catalog.json URL>"); // checks the hash in <URL>.sha256
const result = price(catalog, {
  provider: "openai",
  modelId: "gpt-6.1-sol",
  tier: "openai:standard",
  at: new Date().toISOString(),
  settlement: "booked",
  usage: {
    completeness: "complete",
    quantities: {
      /* every per-call component, zero included */
    },
  },
});
result.booked; // "0.03"
```

**PHP 8.3+** — coming in slices P1 and P2, installed from the read-only mirror
`openadviser/ai-catalog-php`. A sketch of the planned shape:

```php
// Planned API, not published yet.
$catalog = $loader->load('<catalog.json URL or path>');
$price = $catalog->price('example-model', 'example:standard', $usage, $now);
```

Package names and install commands are published with the first release. See [clients](docs/clients.md).

## Coverage

Generated from [`data/catalog.json`](data/) by `npm run coverage:table`; CI fails if it is out of date.

<!-- coverage:start -->
| Provider                             | Models | With prices | Units             | Tiers                               |
| ------------------------------------ | -----: | ----------: | ----------------- | ----------------------------------- |
| Anthropic                            |      5 |           1 | request, token    | anthropic:batch, anthropic:standard |
| OpenAI                               |      4 |           1 | request, token    | openai:standard                     |
| Google Gemini (Gemini Developer API) |      4 |           4 | token, token-hour | google-gemini:standard              |
| ElevenLabs                           |      5 |           5 | character, minute | elevenlabs:pay-as-you-go            |
<!-- coverage:end -->

## How updates work

```mermaid
flowchart LR
    reader["Reader<br/>reads the official page"] --> evidence["Evidence<br/>saves the page bytes"]
    evidence --> reconcile["Reconcile<br/>compare with the catalog<br/>and the cross-checks"]
    reconcile -->|"confirmed"| auto["PR: confirmed changes<br/>merges automatically"]
    reconcile -->|"everything else"| review["PR: needs a person"]
    auto --> release["Immutable release<br/>catalog.json + sha256"]
    review --> release
    release --> clients["Clients adopt<br/>when their owner says so"]
```

A scheduled workflow reads each source, and a reader that cannot read its page reports it as unreadable,
never as a zero. Every change is classed by how many independent sources agree. Releases are immutable
and addressed by version. Each client decides for itself when to adopt a new one. See the
[update policy](docs/update-policy.md) and [versioning](docs/versioning.md).

## Trust and limits

- **Not affiliated with any provider.** This is an independent project. Provider names are used only to
  say whose price is described.
- **The provider's invoice is authoritative.** The catalog is a best-effort reading of public pages. It
  can be wrong or late. Use it to estimate and to enforce budgets, and reconcile against the invoice.
- **Not modelled:** plan-based discounts, credits, free tiers and regional prices. Applications
  express those as their own overrides on top of the catalog.
- **A wrong price is a bug; a tampered price is a vulnerability.** See [SECURITY.md](SECURITY.md).

See [trust and provenance](docs/trust-and-provenance.md).

## Links

- Documentation: [data format](docs/data-format.md), [sources](docs/sources.md),
  [update policy](docs/update-policy.md), [versioning](docs/versioning.md),
  [adding a source](docs/adding-a-source.md), [clients](docs/clients.md),
  [trust and provenance](docs/trust-and-provenance.md), [specification](docs/specification.md)
- [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md) ·
  [Support](SUPPORT.md) · [Changelog](CHANGELOG.md)
- [MIT licence](LICENSE), for both the code and the data.
