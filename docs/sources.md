# Sources

> **Status:** the sources and their traps below were verified on 2026-11-04 by fetching each one. The
> first catalog was entered by hand from these fetches; the bytes are in [`evidence/`](../evidence/). The
> readers arrive in slices C2 and C3, and the cross-check readers in C4.

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

| What                               | Source of truth                                                            | Cross-check                                            | Form and traps                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic prices                   | `platform.claude.com/docs/en/about-claude/pricing.md`                      | models.dev, genai-prices                               | A Markdown table, one row per model. Footnotes change rates for specific models. The Batch table states input and output only                                                                  |
| Anthropic models and effort levels | `GET /v1/models` (`capabilities.effort`: `supported` plus per-level flags) | The pricing page names the models                      | Needs an API key (a free endpoint). `capabilities.effort.xhigh` is a documented field; the reader verifies it per model                                                                        |
| OpenAI prices                      | `developers.openai.com/api/docs/pricing`                                   | models.dev, genai-prices                               | Server-rendered HTML. Each model appears in several tables (Standard, Flex/Batch, Fast, Ultrafast) with different rates, so the reader must name the table                                     |
| OpenAI effort levels               | `developers.openai.com/api/docs/models/<id>`                               | None                                                   | A sentence on the model page that lists the values `reasoning.effort` supports. The same page states the long-context surcharge                                                                |
| OpenAI models                      | `GET /v1/models`                                                           | The pricing page                                       | Ids only                                                                                                                                                                                       |
| Gemini prices, with dates          | `ai.google.dev/gemini-api/docs/pricing.md.txt`                             | models.dev (no dates), genai-prices                    | Markdown with `{% id="<model-id>" %}` anchors and one `{% tab %}` per tier. Dated rates are prose: a rate "through" one date and another "starting" the next                                   |
| Gemini effort levels               | `ai.google.dev/gemini-api/docs/thinking.md.txt`                            | None                                                   | One table: Model, Default Thinking, Levels Supported                                                                                                                                           |
| Gemini models                      | `GET /v1beta/models` (generativelanguage)                                  | The pricing page                                       | Needs a key                                                                                                                                                                                    |
| ElevenLabs prices                  | `elevenlabs.io/pricing/api`                                                | `GET /v1/models` `model_rates` (a relative multiplier) | Server-rendered HTML with product names ("v4", "v2 Multilingual"), not API ids, so a name-to-id map is kept below. Units differ: per 1K characters, and per minute for music and sound effects |
| ElevenLabs models and lifecycle    | `elevenlabs.io/docs/overview/models`                                       | `GET /v1/models`                                       | The model id table, and a "Deprecated models" section with removal dates                                                                                                                       |

Model-list endpoints are free. The update job's API keys live in repository secrets, and no paid call is
ever made.

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
- The Standard table has five price columns: Input, Output, Cached input, 30m write and 12h write. Cache
  writes are billed separately.
- The pricing table does not show the long-context price of the flagship models. The model page says
  "API prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output
  for the full request".
  - The catalog enters 2x input, 2x cached input and 1.5x output as derivations.
  - It marks the two cache-write rates above 272K `unsupported`, because whether "cache rates" covers
    them is not stated.
  - It reads "272K" as 272,000.
- Tools are a separate table: web search $10 per 1K calls, file search tool calls $2.50 per 1K calls,
  containers per 20-minute session by memory size, and file search storage per GB-day with 1 GB free.
- "Regional processing (data residency) endpoints are charged a 10% uplift". This is not modelled.
- The model pages state the effort levels. `gpt-6-astra` states no default. `gpt-6.1-terra` and
  `gpt-6-luna` also support `none`.

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
- `cloud.google.com/model-garden/pricing` prices **Vertex AI**. This catalog describes the Gemini Developer
  API (`generativelanguage.googleapis.com`), which is priced on `ai.google.dev`. The Vertex page is not a
  source for these models.

### ElevenLabs

- Every plan column of the per-plan table gives the same API rate, from "Free / Pay as you go" to
  "Business". The plans differ only in what they include, which is not modelled. Hence the one tier,
  `elevenlabs:pay-as-you-go`.
- "Music and Sound Effects are billed per generation", at a per-minute price. The page does not state the
  metering granularity.
- The models page lists `music_v1` as deprecated, "removed on January 31, 2027", and
  `eleven_text_to_sound_v2` as deprecated, "removed on March 1, 2027". Their successors are `music_v2` or
  `music_v2_5`, and `eleven_text_to_sound_v3`.

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

## Decided in later slices

- The exact tables, headers and footnotes each reader asserts: C2 for Anthropic and Gemini, C3 for OpenAI
  and ElevenLabs.
- Which cross-check each source declares, and its lineage: C4.
- How long daily reads keep their evidence: C4.
