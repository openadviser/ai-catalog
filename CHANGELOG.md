# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Schema and data are versioned separately (see [docs/versioning.md](docs/versioning.md)), so they have
separate sections. Schema changes follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) via
`schemaVersion`. Data releases are dated versions.

## [Unreleased]

### Schema

- **1.0.0.** The first schema, with the normative [specification](docs/specification.md):
  - the JSON Schemas of the catalog, the usage report, the pricing basis and the conformance vector file;
  - exact rational arithmetic, one half-up rounding on the total, and the `estimate` and `booked`
    figures;
  - unit kinds including `minute`, `hour` and the compound `token-hour`, metered in milliseconds and
    converted by `convertRate`;
  - a closed component vocabulary with the `priced`, `inapplicable` and `unsupported` dispositions;
  - usage completeness, provider-specific tiers, and whole-request conditions that partition every input;
  - half-open UTC validity windows, and identity by `(provider, modelId)` with aliases;
  - the RFC 8785 basis with `priceFromBasis`, and load-time validation with error codes.
- 110 conformance vectors over byte-exact fixtures, with hand derivations and pinned basis bytes.

### Data

- The first catalog, `2026.11.04.1`, entered by hand from the providers' pages read on 2026-11-04, with
  the evidence of every value. It covers the models omf-app uses: Anthropic (Claude Sonnet 5 Standard
  and Batch, and four models for their effort levels), OpenAI (GPT-6.1 Sol Standard with its long-context
  schedule, and three models for their effort levels), Google Gemini (3.8 Flash and three speech models,
  with the 2027-01-01 step as two windows), and ElevenLabs (three speech models, and the deprecated
  `music_v1` and `eleven_text_to_sound_v2`). Released as `data-v2026.11.04.1`.

### Repository

- Published for reuse, not as a community project: the Code of Conduct, SUPPORT.md, the DCO sign-off
  check and three issue forms are removed; contributions are reviewed case by case, with no support
  promise. The remaining issue forms are _Wrong or missing price_ and _Client bug_.
- Added the update job and the release (slice C4).
  - **The reconciler** (`reconcile/`). It compares whole price facts with the latest release and classes
    each change `confirmed`, `single-source`, `conflict` or `needs-review`, with unreadable sources
    apart.
    - Generic coverage: a fact the catalog holds that no source yields any more is "tracked, not read".
    - The ×1.5 factor; lineage-deduplicated, freshness-checked cross-checks.
    - The excerpt re-check, and acknowledged standing observations.
  - **Two cross-check readers**, `readers/models-dev/` and `readers/genai-prices/`; the latter reads the
    current v2 data at one commit.
  - **`update.yml`**, daily and on demand. It runs:
    - a confirmed pull request, checked on its exact tree and merged through the API;
    - a review pull request, never merged;
    - one issue per unreadable source, and one for findings without a change;
    - a missing API key as "no key", never a failure.
  - **`release.yml`**. It restamps the version, `publishedAt` and the TIME-6 bounds in its own validated
    commit, then publishes the tag `data-v<version>` and an immutable release with both files before
    "latest" moves.
  - **Evidence.** A run's evidence is kept 90 days as a workflow artifact, and only the bytes a change
    cites are committed. Evidence is never deleted: a body no value cites any more is listed in
    `evidence/superseded.json`.
  - **The OpenAI reader (0.2.0)** states the long-context condition's inputs on its conditional
    readings, as the Anthropic reader does.
  - **Reader tests** are now pinned to the seed's pages and a frozen seed catalog.
- Added the TypeScript client `@openadviser/ai-catalog` in `clients/ts/` (slice C5). It loads and
  validates a catalog, prices a call with exact `bigint` arithmetic, replays a price from its basis, and
  passes every conformance vector. Not published yet.
- Added the per-route [migration matrix](docs/migration-matrix.md) against omf-app, and the data,
  evidence and conformance checks to `npm run check`.
- Added the repository foundation: layout, README, community files, issue forms, documentation skeleton,
  toolchain and CI.
