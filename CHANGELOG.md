# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Schema and data are versioned separately (see [docs/versioning.md](docs/versioning.md)), so they have
separate sections. Schema changes follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) via
`schemaVersion`. Data releases are dated versions.

## [Unreleased]

### Schema

- **1.1.0** (a minor version: it only adds).
  - **New component `generation`.** Dimension requests, per call, priced in the unit `request` (enforced
    in the schema like the search components). Meaning: "Generated media items, such as a song or a clip,
    priced per item." A usage report counts one `generation` per successful song.
  - **Compatibility.**
    - A client of 1.1.0 reads `1.0.x` and `1.1.x` catalogs and rejects everything else (VAL-3). Every
      `1.0.0` catalog, fixture and vector means what it meant.
    - A catalog that declares `1.0.x` uses the 1.0.0 vocabulary: naming `generation` in one is
      `unknown-component` (COMP-1).
    - A 1.0.0 client reads `1.0.x` only. It rejects a `1.1.x` catalog with `unsupported-schema-version`
      and keeps its last good copy, so a consumer upgrades its client before it adopts data that
      declares `1.1.0` (PHP client 0.2.0 reads both).
    - The existing components, units and rates keep their meaning.
  - Section 15 maps Google Gemini's Lyria songs to `generation`.
  - Conformance: `price-unit-generation` (accepting), `load-accept-generation`, `load-accept-schema-1-0`
    (a `1.0.0` catalog still loads), `load-generation-unit-mismatch` (rejecting: wrong unit) and
    `load-generation-in-schema-1-0` (rejecting: `generation` under a `1.0.x` declaration). The fixture of
    `load-unsupported-schema-version` now declares `1.2.0`, since `1.1.0` is supported.
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

- Data release after `2026.11.04.1` (schema `1.1.0`), the first to carry the music and sound-effects
  successors (omf-app #557). A model being in the catalog enables nothing in omf-app.
  - **Google Gemini:** `lyria-3.5` (`available`, $0.08 per song) and the legacy `lyria-3-clip-preview`
    ($0.04 per song) and `lyria-3-pro-preview` ($0.08 per song) (`preview`, no shutdown date announced),
    each with a priced `generation` at `google-gemini:standard`.
  - **ElevenLabs:** `music_v2_5` ($0.15 per minute) and `eleven_text_to_sound_v3` ($0.12 per minute),
    which the models page names the replacements of `music_v1` and `eleven_text_to_sound_v2`, and
    `music_v2`, tracked with no rate: the pages state none for it.
  - The Gemini reader (0.2.0) reads the per-request Lyria tables, failing closed; the ElevenLabs reader
    (0.2.0) extends its name map to a successor only through the models page's replacement column.

- The first catalog, `2026.11.04.1`, entered by hand from the providers' pages read on 2026-11-04, with
  the evidence of every value. It covers the models omf-app uses: Anthropic (Claude Sonnet 5 Standard
  and Batch, and four models for their effort levels), OpenAI (GPT-6.1 Sol Standard with its long-context
  schedule, and three models for their effort levels), Google Gemini (3.8 Flash and three speech models,
  with the 2027-01-01 step as two windows), and ElevenLabs (three speech models, and the deprecated
  `music_v1` and `eleven_text_to_sound_v2`). Released as `data-v2026.11.04.1`.

### Repository

- Prepared PHP client `0.2.0` (`clients/php/src/Version.php` and its changelog): it reads schema `1.0.x`
  and `1.1.x` and knows `generation`. The tag `php-v0.2.0` is made by the maintainer after the merge. The
  TypeScript client reads the same versions.
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
