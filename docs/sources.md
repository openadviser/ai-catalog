# Sources

> **Status:** the sources and their traps below were verified on 2026-11-04 by fetching each one. The
> readers that implement them arrive in slices C2 and C3, and the cross-check readers in C4.

## Purpose

To list where each fact comes from, what to cross-check it against, and what makes each source easy to
misread. This is the page to read before you [add a source](adding-a-source.md).

## Rules

- **The source of truth is the provider's own page or API.** A third-party dataset is read as a
  cross-check only, never as the source of truth.
- **Cross-check sources are read, never depended on.** If one disappears, the changes it would have
  confirmed wait for a person.
- A model list never retires a model. See [update policy](update-policy.md).

## Verified sources

| What                               | Source of truth                                                            | Cross-check                                            | Form and traps                                                                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic prices                   | `platform.claude.com/docs/en/about-claude/pricing.md`                      | models.dev, genai-prices                               | A Markdown table, one row per model. Footnotes change rates for specific models, for example cache-hit multipliers and notes on introductory pricing                                                                    |
| Anthropic models and effort levels | `GET /v1/models` (`capabilities.effort`: `supported` plus per-level flags) | The pricing page names the models                      | Needs an API key (a free endpoint). `capabilities.effort.xhigh` is a documented field; the reader verifies it per model                                                                                                 |
| OpenAI prices                      | `developers.openai.com/api/docs/pricing`                                   | models.dev, genai-prices                               | Server-rendered HTML. Each model appears in several tables (Standard, Batch, ...) with different rates, so the reader must name the table                                                                               |
| OpenAI effort levels               | `developers.openai.com/api/docs/models/<id>`                               | None                                                   | A sentence on the model page that lists the values `reasoning.effort` supports                                                                                                                                          |
| OpenAI models                      | `GET /v1/models`                                                           | The pricing page                                       | Ids only                                                                                                                                                                                                                |
| Gemini prices, with dates          | `ai.google.dev/gemini-api/docs/pricing.md.txt`                             | models.dev (no dates), genai-prices                    | Markdown with `{% id="<model-id>" %}` anchors. Dated rates are prose: a rate "through" one date and another "starting" the next                                                                                         |
| Gemini effort levels               | `ai.google.dev/gemini-api/docs/thinking.md.txt`                            | None                                                   | One table: Model, Default Thinking, Levels Supported                                                                                                                                                                    |
| Gemini models                      | `GET /v1beta/models` (generativelanguage)                                  | The pricing page                                       | Needs a key                                                                                                                                                                                                             |
| ElevenLabs prices                  | `elevenlabs.io/pricing/api`                                                | `GET /v1/models` `model_rates` (a relative multiplier) | Server-rendered HTML with product names ("v3", "v4 Turbo"), not API ids (`eleven_v3`), so a name-to-id map is maintained in the repository. Units differ: per 1K characters, and per minute for music and sound effects |

Model-list endpoints are free. The update job's API keys live in repository secrets, and no paid call is
ever made.

## Not a source

`cloud.google.com/model-garden/pricing` prices **Vertex AI**. This catalog describes the Gemini Developer
API (`generativelanguage.googleapis.com`), which is priced on `ai.google.dev`. The Vertex page is not a
source for these models.

## Decided in later slices

- The exact tables, headers and footnotes each reader asserts: C2 for Anthropic and Gemini, C3 for OpenAI
  and ElevenLabs.
- Which cross-check each source declares, and its lineage: C4.
