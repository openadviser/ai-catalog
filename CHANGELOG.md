# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Schema and data are versioned separately (see [docs/versioning.md](docs/versioning.md)), so they have
separate sections. Schema changes follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) via
`schemaVersion`. Data releases are dated versions.

## [Unreleased]

### Schema

- **1.2.0** (a minor version: it only adds).
  - **New optional model member `inputModalities`** (MOD-1): `{ "values": [...], "provenance": {...} }`,
    what the model accepts as input. `values` is a nonempty list of distinct values from the closed set
    `text`, `image`, `audio`, `video` and `pdf`, in that order. The set is the one the providers' model
    pages use: Anthropic "Text and images", OpenAI "text, image", Gemini "Text, Image, Video, Audio, and
    PDF". **Absent means not established**, never "text only"; present means the model's own page lists
    those inputs. Like `effort`, it carries its own provenance.
  - **No `input_audio` component.** No model in the catalog has a separate audio input rate: the Gemini
    models of the catalog list one input price, the Claude and GPT-6 models take no audio, and the
    speech, music and ElevenLabs models price their output. The component is added when a catalog model
    prices audio input on its own.
  - **Compatibility.**
    - A client of 1.2.0 reads `1.0.x`, `1.1.x` and `1.2.x` catalogs and rejects everything else (VAL-3).
      Every `1.0.x` and `1.1.x` catalog, fixture and vector means what it meant, and a catalog without the
      member is unchanged.
    - A catalog that declares `1.0.x` or `1.1.x` does not know the member: a model that carries one is
      `invalid-structure`.
    - A 1.1.0 client reads `1.0.x` and `1.1.x` only. It rejects a `1.2.x` catalog with
      `unsupported-schema-version` and keeps its last good copy, so a consumer upgrades its client before
      it adopts data that declares `1.2.0`. A reader that ignores `inputModalities` prices exactly as
      before: no rate, component or usage report depends on it.
    - An empty list, or an unknown, repeated or misordered string, is `invalid-input-modalities` (new error
      code, MOD-1); a value that is not a string is `invalid-structure`.
  - Conformance: `load-accept-input-modalities` (accepting), `load-input-modalities-out-of-order`,
    `load-input-modalities-in-schema-1-1`, `load-input-modalities-not-string` and
    `load-input-modalities-values-not-list` (rejecting). The fixture
    of `load-unsupported-schema-version` now declares `1.3.0`, since `1.2.0` is supported.
  - TypeScript client: `inputModalities(catalog, provider, id)` and `ModelInfo.inputModalities`. PHP client:
    `Catalog::inputModalities()` and `Model::$inputModalities` (see its changelog).
  - The reconciler keeps the member when it replaces a model's effort or lifecycle, and the release notes
    name a change of it. Before this, a rebuilt model would have lost any member it did not list.
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

- The next data release (schema `1.2.0`), the first to carry `inputModalities`. Each value is read from the
  model's own documentation page on 2026-11-25 and cites the line it comes from, with the page's bytes
  under `evidence/`. Nothing else changes: no rate, status, effort or model.
  - **Anthropic:** the six models state `text` and `image` (the "Input → output" row, "Text and images →
    text"): `claude-sonnet-5`, `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`,
    `claude-haiku-5-5` and `claude-fable-5-2`.
  - **OpenAI:** the seven GPT-6 models state `text` and `image` ("Input modalities: text, image"). The
    pages of `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6.2-astra` and `gpt-6.2-sol` also list audio and video as
    unsupported.
  - **Google Gemini:** `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-neon`, `gemini-4-hydrogen` and
    `gemini-3.8-flash` state `text`, `image`, `audio`, `video` and `pdf` ("Inputs: Text, Image, Video,
    Audio, and PDF"). The three TTS models state `text`; the three Lyria models state `text` and `image`.
  - **ElevenLabs:** no value. The model pages of ElevenLabs were not read for this, so its models stay
    not established.
  - Audio is stated only where the model's own page lists it: the five Gemini text models. It is never
    inferred from a sibling.
  - The version stamp (`2026.11.25.1`) and `publishedAt` are the provisional ones of this pull request. The
    release workflow restamps them.

- Data release after `2026.11.22.1` (schema `1.1.0`), the first to price the current Claude and GPT API
  models (OLP-528). A model being in the catalog enables nothing in omf-app. Every rate is read from the
  provider's published API pricing page of 2026-11-23; no existing rate changed.
  - **Anthropic:** `claude-fable-5-2` is new (`available`, effort `low` to `max`, default `high`).
    `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` each get an
    `anthropic:standard` offering: input, cache writes (5 minutes and 1 hour), cached input, output,
    web search ($10 per 1,000 searches) and code execution (`unsupported`, billed by container time).
    Fable 5.2 is $8 / $40 per 1M tokens, Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10. Haiku 5.5 states two
    whole-request schedules, at most 100,000 input tokens ($0.10 / $0.50) and more than 100,000
    ($0.50 / $2.50). `claude-fable-5-1` stays tracked with no offering: the owner replaced it with 5.2.
  - **OpenAI:** `gpt-6-astra`, `gpt-6.1-terra` and `gpt-6-luna` get an `openai:standard` offering, and
    the other API models the page's Flagship Standard table prices are added with one: `gpt-6.2-astra`,
    `gpt-6.2-sol` and `gpt-6-sol` (`gpt-6.1-sol` already had one). Each has input, cached input, the
    30-minute cache write, the 12-hour cache write where the pricing table or the model page states it
    (`gpt-6.1-terra`'s $2.50 comes from its model page; it is `unsupported` for `gpt-6-luna` and
    `gpt-6-sol`), output, web search and file search at their
    ≤272,000-token rates, and the model page's 2x input and cached input and 1.5x output above 272,000
    input tokens. Cache writes above that boundary stay `unsupported`, as they do for `gpt-6.1-sol`.
    `gpt-6.2-astra` and `gpt-6.2-sol` state no effort levels on their pages, so they carry none.
  - Not carried: the specialized models `gpt-6-cyber`, `gpt-6-rosalind`, `gpt-6.2-astra-law` and
    `gpt-6-astra-law`, which need Trusted Access or a legal configuration and are priced in their own
    section; the Batch, Flex, Fast and Ultrafast tiers; and the Haiku long-context data-residency
    sentence.
  - The Anthropic reader (0.2.0) also reads the pricing page's 2026-11-23 form: footnote 1 naming
    Fable 5.2 and Mythos 5.2, a "Compare models" table, the "on most models" cache-hit multiplier with the
    per-model table that follows (which must agree with the footnotes), and the reworded web search
    sentence. The OpenAI reader (0.3.0) reads the model pages' "Model IDs" section, the long-context
    note's new wording, the Flex pane, the pricing note without a summary card and the Tools table's
    renamed rows. Each form is exact; anything else is left for a person.

- Data release after `2026.11.05.2` (schema `1.1.0`), the first to carry the Gemini 4 models, added on the
  owner's word of 2026-11-22. A model being in the catalog enables nothing in omf-app.
  - **Google Gemini:** `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-neon` and `gemini-4-hydrogen`
    (`available`), each with a `google-gemini:standard` offering read from the pricing page of
    2026-11-22 and the effort levels of the thinking page of the same day.
    - Carbon and Argon: input $2.00, cached input $0.10 and output $10.00 per 1M tokens through
      2026-11-30, then $4.00, $0.20 and $20.00 from 2026-12-01 (the page's dates state no zone, read as
      UTC). Effort `low`, `medium`, `high`; default `medium`.
    - Neon: $3.00, $0.15 and $15.00. Hydrogen: $1.50, $0.075 and $7.50. Effort `low`, `medium`, `high`,
      `xhigh`; default `high`.
    - The page says explicit caching is not supported, so it states no cache storage price and the
      offerings hold none. Grounding with Google Search and with Google Maps are `unsupported`, as on
      Gemini 3.8 Flash. The Batch, Flex, Priority and Contributor tabs are not carried.
  - The Gemini reader (0.3.0) reads a caching cell that ends with the "Implicit caching only" sentence
    in one exact form only: plain prices, with their date windows, and nothing else in the cell. Any
    other text (a qualification, a link, a storage price) leaves the whole cell for a person. It tells
    a footnote's definition from a marker inside a cell. The marker on a Google Search grounding row
    must resolve to exactly one definition, the complete Search definition with nothing after it, so
    a changed or added sentence, another footnote in its place, a further paragraph or a second
    definition with its glyph fails closed (where the page puts the definition does not matter); the
    other footnotes are matched as before. It cites each rate's own row label, not the first model's.

- Data release after `2026.11.04.1` (schema `1.1.0`), the first to carry the music and sound-effects
  successors (omf-app #557). A model being in the catalog enables nothing in omf-app.
  - **Google Gemini:** `lyria-3.5` (`available`, $0.08 per song) and the legacy `lyria-3-clip-preview`
    ($0.04 per song) and `lyria-3-pro-preview` ($0.08 per song) (`preview`, no shutdown date announced),
    each with a priced `generation` at `google-gemini:standard`.
  - **ElevenLabs:** `music_v2_5`, `music_v2` and `eleven_text_to_sound_v3`, tracked (`available`) with no
    offering and no rate: no page lists a model id under a pricing product or states a rate for it, and a
    "replacement model suggestion" is not a price.
  - The Gemini reader (0.2.0) reads the per-request Lyria tables, failing closed on anything in the section
    beyond one known table; the ElevenLabs reader (0.2.0) shows a named replacement's product rate as a
    `needs-review` candidate, never as a rate.

- **ElevenLabs successor rates, by owner attribution (reader 0.3.0).** The owner decided on 2026-11-05
  (decision "A") that the pricing page's product rates apply to the three successors: `music_v2_5` and
  `music_v2` at the Music card's rate, `eleven_text_to_sound_v3` at the Sound Effects card's — each an
  `elevenlabs:pay-as-you-go` offering of `output_audio_duration` per minute. The page states no model id
  and no rate for them; the provenance says plainly the rate is the product's, applied by the owner's
  decision, and is read fresh from the card on every run. The attribution fails closed to `needs-review`
  when the model leaves the models page's current table or the pricing page starts distinguishing models
  of the product. A successor the owner did not list keeps the `unstated-rate` candidate behaviour.

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
