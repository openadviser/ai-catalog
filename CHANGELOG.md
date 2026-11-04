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
- 104 conformance vectors over byte-exact fixtures, with hand derivations and pinned basis bytes.

### Data

- The first catalog, `2026.11.04.1`, entered by hand from the providers' pages read on 2026-11-04, with
  the evidence of every value. It covers the models omf-app uses: Anthropic (Claude Sonnet 5 Standard
  and Batch, and four models for their effort levels), OpenAI (GPT-6.1 Sol Standard with its long-context
  schedule, and three models for their effort levels), Google Gemini (3.8 Flash and three speech models,
  with the 2027-01-01 step as two windows), and ElevenLabs (three speech models, and the deprecated
  `music_v1` and `eleven_text_to_sound_v2`). Not released yet.

### Repository

- Added the per-route [migration matrix](docs/migration-matrix.md) against omf-app, and the data,
  evidence and conformance checks to `npm run check`.
- Added the repository foundation: layout, README, community files, issue forms, documentation skeleton,
  toolchain and CI.
