# Sources

> **Status:** the sources and their traps below were verified on 2026-11-04 by fetching each one. The
> first catalog was entered by hand from these fetches; the bytes are in [`evidence/`](../evidence/).
> Readers for all four providers and both cross-checks are in [`readers/`](../readers/).

## Purpose

To list where each fact comes from, what to cross-check it against, and what makes each source easy to
misread. This is the page to read before you [add a source](adding-a-source.md).

## Rules

- **The source of truth is the provider's own page or API.** A third-party dataset is read as a
  cross-check only, never as the source of truth.
- **Cross-check sources are read, never depended on.** If one disappears, the changes it would have
  confirmed wait for a person.
- A model list never retires a model. See [update policy](update-policy.md).
- **A value the page does not state is not entered.** Where a page states a price as a multiplier of
  another stated price, the catalog enters the product with a `derivation` citing both. Where the scope
  of a statement is ambiguous, the component is `unsupported`, so a call that uses it refuses.

## Verified sources

| What                               | Source of truth                                                            | Cross-check                                            | Form and traps                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic prices                   | `platform.claude.com/docs/en/about-claude/pricing.md`                      | models.dev, genai-prices                               | A Markdown table, one row per model. Footnotes change rates for specific models. The Batch table states input and output only                                                                              |
| Anthropic models and effort levels | `GET /v1/models` (`capabilities.effort`: `supported` plus per-level flags) | The pricing page names the models                      | Needs an API key (a free endpoint). `capabilities.effort.xhigh` is a documented field; the reader verifies it per model                                                                                    |
| OpenAI prices                      | `developers.openai.com/api/docs/pricing`                                   | models.dev, genai-prices                               | Server-rendered HTML. Each model appears in several tables (Standard, Flex/Batch, Fast, Ultrafast) with different rates, so the reader must name the table                                                 |
| OpenAI effort levels               | `developers.openai.com/api/docs/models/<id>`                               | None                                                   | A sentence on the model page that lists the values `reasoning.effort` supports. The same page states the long-context surcharge                                                                            |
| OpenAI models                      | `GET /v1/models`                                                           | The pricing page                                       | Ids only                                                                                                                                                                                                   |
| Gemini prices, with dates          | `ai.google.dev/gemini-api/docs/pricing.md.txt`                             | models.dev (no dates), genai-prices                    | Markdown with `{% id="<model-id>" %}` anchors and one `{% tab %}` per tier. Dated rates are prose: a rate "through" one date and another "starting" the next. Lyria has no tabs: a table priced "per song" |
| Gemini effort levels               | `ai.google.dev/gemini-api/docs/thinking.md.txt`                            | None                                                   | One table: Model, Default Thinking, Levels Supported                                                                                                                                                       |
| Gemini models                      | `GET /v1beta/models` (generativelanguage)                                  | The pricing page                                       | Needs a key                                                                                                                                                                                                |
| ElevenLabs prices                  | `elevenlabs.io/pricing/api`                                                | `GET /v1/models` `model_rates` (a relative multiplier) | Server-rendered HTML with product names ("v4", "v2 Multilingual"), not API ids, so a name-to-id map is kept below. Units differ: per 1K characters, and per minute for music and sound effects             |
| ElevenLabs models and lifecycle    | `elevenlabs.io/docs/overview/models`                                       | `GET /v1/models`                                       | The model id table, and a "Deprecated models" section with removal dates                                                                                                                                   |

Model-list endpoints are free. The update job's API keys live in repository secrets, each optional per
provider — a missing key makes that list `not-configured` for the run — and no paid call is ever made.

## Found while fetching (2026-11-04)

### Anthropic

- The models overview `about-claude/models/overview.md` answers with a 307 to `/docs/en/models/overview.md`.
  Model pages are at `/docs/en/models/<model>/overview.md`. Claude Sonnet 5's page states its id, its
  default effort (`high`) and its status ("Active (legacy)").
- The effort page states which models support `xhigh` and `max`, and each current model's default.
- Footnote 3 of the pricing table says Claude Sonnet 5's introductory $2/$10 is now the standard price,
  and the scheduled increase to $3/$15 on 2026-09-01 "will not occur". So there is no dated step.
- The Batch table states input and output only. The cache prices in Batch come from the page's statement
  that the caching multipliers "stack with … the Batch API discount", and are entered as derivations.
- Web search is $10 per 1,000 searches, with no Batch price stated. Code execution has 1,550 free hours
  per organization per month, so it is `unsupported`.
- US-only inference (`inference_geo: "us"`) costs 1.1x, and fast mode is a separate price. Neither is
  part of the `anthropic:standard` tier.

### OpenAI

- The tier tables are Standard, Flex/Batch (one table, labelled "Batch"), Fast and Ultrafast. "Priority
  processing was renamed Fast mode on July 30, 2026." There is no `openai:priority`.
- Each tier is a tab pane inside one `astro-island`. The real row data is serialized in the pane's
  `props` JSON (`rows`, and `alternateRows` for the Batch pane's Flex variant); the SSR `<table>` renders
  only the first four rows, so the reader parses the serialized rows and checks them against the SSR
  cells it can see. Only `openai:standard` is a schema tier — the Batch, Fast and Ultrafast panes are
  read and flagged `needs-review`, never silently ignored.
- The Standard table has five price columns: Input, Output, Cached input, 30m write and 12h write. Cache
  writes are billed separately.
- A segmented control in the flagship section toggles between "Short: ≤272K input tokens" and
  "Long: >272K input tokens". The reader takes the context boundary from those labels — a changed
  boundary is `needs-review`.
- The pricing table does not show the long-context price of the flagship models. The model page says
  "API prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output
  for the full request".
  - The catalog enters 2x input, 2x cached input and 1.5x output as derivations.
  - It marks the two cache-write rates above 272K `unsupported`, because whether "cache rates" covers
    them is not stated.
  - It reads "272K" as 272,000.
- Each model page carries a Pricing block: summary cards (Input, Cached input, Cache writes, Output)
  that must agree with the Standard table, and prose notes that state the cache multipliers, the
  long-context surcharge and the speed-tier multipliers. A card or note that contradicts the table is
  `needs-review`; a note the reader does not understand is `needs-review`.
- Tools are a separate table with a rowSpan group column: web search $10 per 1K calls, file search tool
  calls $2.50 per 1K calls, containers per 20-minute session by memory size, and file search storage
  per GB-day with 1 GB free. A row the reader cannot map to a tracked component is `needs-review`.
- "Regional processing (data residency) endpoints are charged a 10% uplift". This is not modelled.
- The model pages state the effort levels in a `reasoning.effort` sentence. `gpt-6-astra` states no
  default. `gpt-6.1-terra` and `gpt-6-luna` also support `none`.
- `GET /v1/models` lists ids only; absence from the list never retires a model.

### Google Gemini

- The `.md.txt` URLs answer with a 301 to `aistudio.google.com/docs/<page>.md.txt`, then a 301 to
  `aistudio.google.com/docs/<page>.md`. The evidence records every hop.
- **Dates state no zone.** The page's only zone is "midnight Pacific Time", for rate-limit resets, which
  is not a statement about prices. Under the UTC rule (rule TIME-5 of the
  [specification](specification.md)), the 2027 step is at 2027-01-01T00:00:00Z. **This is the
  conservative reading:** if Google meant Pacific time, the higher price applies 8 hours early, never
  late.
- Gemini 3.8 Flash publishes one input price for every modality, and "Output price (including thinking
  tokens)". Context caching has a per-token price and a storage price per million tokens per hour
  (`cache_storage`, a compound unit).
- Grounding with Google Search and with Google Maps include 5,000 free requests a month, so they are
  `unsupported`.
- The TTS models now have Batch and Flex tabs, which the catalog does not yet carry.
- **Lyria is priced per song, not per token** (read 2026-11-05). Two sections have no tabs and a table
  headed **Paid Tier, per request in USD**:
  - `## Lyria 3.5`, whose id line is `lyria-3.5`: "Lyria 3.5 (Full Song)", $0.08 per song;
  - `## Lyria 3`, whose id line names two models, `lyria-3-clip-preview` and `lyria-3-pro-preview`, "a
    family of legacy music generation models": "Lyria 3 Clip Preview (30s)", $0.04 per song, and "Lyria 3
    Pro Preview (Full Song)", $0.08 per song.

  The free tier is "Not available" for all three.
  - **Component.** A song is one `generation` at `request`, per 1 (schema 1.1.0). A model id is bound to
    its row only when the row's name slugs to the id; a row that names no id of its section is
    `needs-review`, never guessed onto one.
  - **Lifecycle.** The schema has no "legacy" status. The models page lists `lyria-3.5` as "Stable" and the
    two Lyria 3 models as "Preview"; the deprecations page lists all three with "No shutdown date
    announced" and recommends `lyria-3.5` as the replacement of `lyria-3-pro-preview`. So `lyria-3.5` is
    `available`, the two Lyria 3 models are `preview` (the reader's rule: "Preview" in the row's name), and
    none has a `retiresOn`. A retirement needs a deprecation notice with a date (update policy).
  - **Failed requests.** The page does not say whether a failed or blocked request is billed. The
    specification's `generation` counts successful songs only (Section 15).
- `cloud.google.com/model-garden/pricing` prices **Vertex AI**. This catalog describes the Gemini Developer
  API (`generativelanguage.googleapis.com`), which is priced on `ai.google.dev`. The Vertex page is not a
  source for these models.

### ElevenLabs

- Every plan column of the per-plan table gives the same API rate, from "Free / Pay as you go" to
  "Business". The plans differ only in what they include, which is not modelled. Hence the one tier,
  `elevenlabs:pay-as-you-go`.
- The price sits on a product card ("v4", "$0.08", "Price per 1K characters") and is restated in the
  per-plan table under the matching section; the card value must equal every plan column or the rate is
  `needs-review`. Products priced on the page but absent from the name map below are flagged, never
  silently dropped or guessed onto a model id.
- "Music and Sound Effects are billed per generation", at a per-minute price. The page does not state the
  metering granularity.
- The models page lists `music_v1` as deprecated, "removed on January 31, 2027", and
  `eleven_text_to_sound_v2` as deprecated, "removed on March 1, 2027". Their successors are `music_v2` or
  `music_v2_5`, and `eleven_text_to_sound_v3`. A tracked deprecated model whose removal notice
  disappears, or a second sentence that contradicts the notice's date, is `needs-review`.
- `GET /v1/models` answers with a bare JSON array of model records, each with `model_id` and
  `model_rates` cost multipliers. The multipliers are recorded for the reconciler's cross-check — a
  multiplier is never a price. A record without a `model_id` is `needs-review`.

### ElevenLabs product names

The pricing page names products. This map ties each name the catalog uses to the API model id on the
models page.

| Pricing page product | Model id                  | Unit on the page        |
| -------------------- | ------------------------- | ----------------------- |
| v4 (Text to Speech)  | `eleven_v4`               | Price per 1K characters |
| v3 (Text to Speech)  | `eleven_v3`               | Price per 1K characters |
| v2 Multilingual      | `eleven_multilingual_v2`  | Price per 1K characters |
| Music                | `music_v1`                | Price per minute        |
| Sound Effects        | `eleven_text_to_sound_v2` | Price per minute        |

"Music" and "Sound Effects" are products, each with several model ids. The page gives one price per
product, which the catalog applies to the model id it lists.

### Successors (2026-11-05)

The pricing page names no successor and states no rate for one: it prices the products "Music" and "Sound
Effects", and no page lists a model id under a product. The name map therefore **extends to a successor
only where a page lists it under that product or states its price**. None does today, so all three
successors are tracked with their rate `needs-review`:

| Pricing page product | Model id                  | Case                                                                                                   |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Music                | `music_v2_5`              | **Not mapped.** The models page names it the replacement of `music_v1`; that is a migration suggestion |
| Music                | `music_v2`                | **Not mapped.** The models page names it the replacement of nothing                                    |
| Sound Effects        | `eleven_text_to_sound_v3` | **Not mapped.** The models page names it the replacement of `eleven_text_to_sound_v2`                  |

- Each is in the catalog with `status: available` and **no offering**, so pricing it refuses
  (`unknown-offering`) and no consumer can bill it at a rate no page states.
- For a successor the models page names a replacement, the reader shows the product's rate as a
  **candidate**: a `needs-review` rate reading with the reason `unstated-rate`, naming the replacement cell
  it saw. It never becomes a catalog entry by itself. A person enters it, with the owner's approval of the
  model id and its rate, once a page lists the model under the product or states its price.
- The models page also shows "Eleven Music v2.5" and "Eleven Music v2" under its Music heading, and says
  "SFX v3 … uses the same Sound Effects API". Those name models, not ids, and say nothing about a rate, so
  they are not enough.
- `GET /v1/models` was not read for this (it needs a key, and no key is used here). Its records state
  `model_rates` multipliers, never a price or a product. If a record ever lists a model under a product,
  that is evidence for the map.

## Cross-checks

Two third-party trackers are read as cross-checks. They are never a source of a value. They count only
as the [update policy](update-policy.md#cross-checks) says: same tier, condition and window, revised
after the catalog's observation, and deduplicated by lineage.

| Tracker      | What is read                                                                                                                                                                   | Lineage (declared upstreams)                                                    | Revision of an entry                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| models.dev   | `https://models.dev/api.json`                                                                                                                                                  | `models.dev`                                                                    | The model's `last_updated`, as 00:00 UTC of that date           |
| genai-prices | The newest commit of `prices/new_data/v2/data.json` (GitHub's commits API), then that file and `prices/providers/<provider>.yml` at that commit, so the bytes are one snapshot | `genai-prices`, `models.dev`, `litellm`, `helicone`, `llm-prices`, `openrouter` | The model's `prices_checked` in the provider file, as 00:00 UTC |

- **Lineage.** genai-prices took its initial data from, and still pulls price updates from, other
  trackers. Its README credits Helicone, OpenRouter, LiteLLM and llm-prices, and the owner adds
  models.dev. It therefore shares models.dev's upstream, and the two count as **one** independent
  cross-check.
- **genai-prices v1 is frozen.** `prices/data.json` no longer receives price updates (its README), so it
  is not read.
- **Exact ids only.** A model is matched on its exact id, never through a tracker's prefix `match` rules.
  A rule such as `starts_with: claude-fable-5` would reach `claude-fable-5-1`.
- **ElevenLabs has no third-party cross-check.** models.dev lists no ElevenLabs model, and genai-prices
  lists only the Realtime models. `GET /v1/models` `model_rates` is the provider's own, so it shares the
  source of truth's lineage. It is recorded, and a multiplier other than 1 on a tracked model is
  `needs-review`, but it never confirms a price. ElevenLabs changes are always `single-source`.

### How the trackers' fields map

| Tracker field                                                  | Component                          | Notes                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| models.dev `cost.input`; genai-prices `input_mtok`             | `input`                            | USD per million tokens. Unmapped when a modality-specific input price differs                                                                                                                                   |
| models.dev `cost.output`; genai-prices `output_mtok`           | `output`                           | Unmapped when models.dev states a separate `reasoning` price, or an output modality differs                                                                                                                     |
| models.dev `cost.cache_read`; genai-prices `cache_read_mtok`   | `input_cached`                     |                                                                                                                                                                                                                 |
| genai-prices `cache_write_5m_mtok`, `cache_write_1h_mtok`      | `cache_write_5m`, `cache_write_1h` |                                                                                                                                                                                                                 |
| models.dev `cost.cache_write`; genai-prices `cache_write_mtok` | `cache_write_5m`                   | Anthropic only (its default cache lifetime is five minutes; genai-prices prices a 5-minute write at the generic key when no 5-minute key exists). Unmapped for every other provider, where it names no lifetime |
| genai-prices `output_audio_mtok`                               | `output_audio`                     |                                                                                                                                                                                                                 |
| genai-prices `web_searches_kcount`                             | `web_search`                       | Per 1000 requests                                                                                                                                                                                               |

- **Tiers.** A tracker's base prices are the provider's standard tier. A genai-prices
  `price_variants` entry with `when: {processing: "batch"}` is `anthropic:batch`. Every other variant is
  a tier the schema does not model.
- **Windows.**
  - models.dev states no dates, so its readings are undated.
  - A genai-prices `start_date` D is 00:00 UTC, which is how genai-prices applies it. Dated entries
    chain into `[∅, D₁)`, `[D₁, D₂)`, … .
  - A Batch variant's `start_date` is genai-prices' verification date ("earlier batch history is not
    modelled"). So it covers only `[D, …)` and never confirms an undated Batch fact.
- **Conditions.** genai-prices tiers `{base, tiers: [{start, price}]}` are whole-request cliffs:
  genai-prices applies a tier to every token once the total input exceeds `start`. They map to
  `{inputTokens: {lte: start}}` and `{inputTokens: {gt: start}}`, and a flat key of the same entry covers
  every schedule. A models.dev entry with `tiers` covers nothing, because its boundary semantics are not
  stated.
  - **Conditional prices are not confirmed by either tracker.** A schedule is defined by its bound and
    by which tokens the bound counts (the condition inputs, COND-2). A conditional cross-check counts
    only when it states the same condition inputs as the official reading. genai-prices does not
    state which tokens its "total input" sums, so its conditional readings are shown and never
    counted. Long-context prices therefore always wait for a person.
- **Amounts** are read from the JSON literal, never through a binary float.

## Decided in later slices

The exact tables, headers and footnotes each reader asserts were decided in C2 (Anthropic, Gemini) and
C3 (OpenAI, ElevenLabs); see the reader sources under [`readers/`](../readers/). How long daily reads keep
their evidence is in [trust and provenance](trust-and-provenance.md#evidence-retention).
