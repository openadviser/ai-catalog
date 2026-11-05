# Migration matrix: omf-app parity

> **Status: for the owner to decide.** This page compares, route by route, how omf-app prices each paid
> route today with what the first catalog (`2026.11.04.1`) says. It decides nothing. Every difference
> is listed in [the differences](#the-differences-for-the-owner) for the owner, and A1 imports today's
> YAML as overrides wherever the owner keeps a difference.

Read from omf-app `origin/dev` at `40e4b61c`: `config/tariffs.yaml`, `config/provider_registry.yaml`,
`config/model_efforts.yaml`, and the code they feed, inventoried at `04d1e473`. `40e4b61c` is the stopgap
`fix/gemini-tts-2027-rates` merged as #554, and it changes no configuration file other than the two
Gemini 3.8 TTS entries in `tariffs.yaml`. The catalog values and their evidence are in
[`data/catalog.json`](../data/catalog.json). Rates are USD per million units unless a unit is named.

## Two models omf-app runs are deprecated

> **`music.elevenlabs` and `sound-effects.elevenlabs` are the only paid routes enabled today, and both
> models are deprecated.** ElevenLabs' models page says:
>
> - `music_v1` "is deprecated and will be removed on January 31, 2027". Its successors are `music_v2`
>   and `music_v2_5`.
> - `eleven_text_to_sound_v2` "is still the default but is deprecated and will be removed on March 1,
>   2027". Its successor is `eleven_text_to_sound_v3`.
>
> The catalog carries both as `status: deprecated` with `retiresOn` and the notice as evidence. Both routes
> stop working on those dates unless the registry moves to a successor. A successor is a new model, so it
> needs its own catalog entry and price reading. The pricing page gives one price per product ("Music",
> "Sound Effects"), not per model id.

## How to read the matrix

- **Identity:** the route's `(provider, modelId, tier)` in the catalog.
- **Components:** omf-app's `RateComponent` ← the catalog component.
- **Conversion:** the `convertRate` (UNIT-4) that turns the catalog rate into omf-app's per-million
  `Rate`, and whether it is exact. Every conversion below is exact.
- **Synthetic zeros:** components omf-app declares at `'0'` because its grammar requires `input`,
  `input_cached` and `output` on every route, while the catalog lists no such billable component.
- **Provenance:** where the cost of a call comes from today.
  - `reported`: the provider reports money.
  - `retained tariff`: tokens × the rates retained at admission.
  - `estimate`: tokens × rates, as an estimate only.
- **Estimate and settlement:** which figure reserves and which settles (TokenCharge `total()` is half-up,
  `billed()` books at least one minor unit), and when the rates are read.
- **Dated:** what happens at a dated step.

## The matrix

| Route                                                  | Identity                                                                                                                                                                                                                                            | Components (omf-app ← catalog)                                                                                                                                                                                                    | Conversion                                                                                  | Synthetic zeros                                                                                                                                                            | Provenance                                                                                                                                                               | Estimate and settlement                                                                                                                                                                                                    | Dated                                                                                         | Old → catalog                                                                                                                          | Differs                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `text.claude.synchronous` (off)                        | `anthropic` / `claude-sonnet-5` / `anthropic:standard`                                                                                                                                                                                              | `input`←`input`; `input_cached`←`input_cached`; `output`←`output`; `cache_creation_5m`←`cache_write_5m`; `cache_creation_1h`←`cache_write_1h` (not declared today); none←`web_search`, `code_execution`                           | None: per 10^6 tokens on both sides                                                         | None today. The catalog requires `web_search: 0` and `code_execution: 0` in a complete report                                                                              | Retained tariff (`estimated`, Execution ledger)                                                                                                                          | Rates retained at the claim. Reserves the owner's allowance (shipped 0), not a price. Settles with `PricingBasis::estimate()`: half-up, **no one-unit floor**. Totals without a cache split are priced at input and output | None (Sonnet 5 has no step)                                                                   | 2 / 0.20 / 10 / 2.50 → 2 / 0.20 / 10 / 2.50; 1h write none → 4; web search none → $10 per 1K                                           | D5, D8, D12, D14        |
| `text.claude.headless-api` (off)                       | `anthropic` / `claude-sonnet-5` / `anthropic:standard`                                                                                                                                                                                              | Estimate only: the prompt at max(`input`, `cache_creation_5m`) = 2.50, 32,000 output tokens at `output`                                                                                                                           | None                                                                                        | `input_cached` is never read                                                                                                                                               | `reported`: the CLI's `total_cost_usd`, rounded up to the cent                                                                                                           | Estimate at audio admission: `total()` then at least 1 cent. Settles on the reported cost. No rates retained, none needed                                                                                                  | None                                                                                          | As above, for the estimate only                                                                                                        | D5 (estimate), D12, D17 |
| `text.claude.batch` (off)                              | `anthropic` / `claude-sonnet-5` / `anthropic:batch`                                                                                                                                                                                                 | As `text.claude.synchronous`                                                                                                                                                                                                      | None                                                                                        | None                                                                                                                                                                       | None: no adapter or runtime consumer exists                                                                                                                              | None: checked only at compile time                                                                                                                                                                                         | None                                                                                          | 1 / 0.10 / 5 / 1.25 → 1 / 0.10ᵈ / 5 / 1.25ᵈ; 1h write none → 2ᵈ; web search none → unsupported                                         | D5, D19                 |
| `text.codex.headless-api` (off)                        | `openai` / `gpt-6.1-sol` / `openai:standard`                                                                                                                                                                                                        | `input`←`input`; `input_cached`←`input_cached`; `output`←`output` (reasoning included); `cache_creation_30m`←`cache_write_30m`; none←`cache_write_12h`, `web_search`, `file_search`, `containers`                                 | None                                                                                        | None once D6 is built. Codex reports cache writes (`cache_write_input_tokens`, Codex PR #33454) and no tool calls, so a complete report states the tool components as zero | Retained tariff (`PricingBasis::billed()`, audio cap)                                                                                                                    | Estimate at admission: prompt at `input`, 32,000 output tokens, `total()` then at least 1 cent. Basis snapshotted when the request is filed. Settled from `turn.completed` tokens with `billed()`                          | None. The catalog adds a whole-request schedule above 272K input tokens                       | Input 2.00 → 2.00; **cached 0.20 → 0.10**; output 10.00 → 10.00; writes none → 2.50 and 5.00; above 272K none → 4.00ᵈ / 0.20ᵈ / 15.00ᵈ | D1, D6, D7, D8, D17     |
| `speech.gemini-tts-3-8-flash.belarusian` (off)         | `google-gemini` / `gemini-3.8-flash-tts` / `google-gemini:standard`                                                                                                                                                                                 | `input`←`input` (text tokens); `output`←`output_audio` (audio tokens)                                                                                                                                                             | None: per 10^6 tokens. 25 audio tokens per second only in the estimate                      | `input_cached` '0' (never read; not a catalog component)                                                                                                                   | Tariff arithmetic, an unlabelled `actual_minor`                                                                                                                          | Estimate at admission (`total()`, then at least 1 cent). **The tariff is looked up again after the response.** Settles with `billed()`                                                                                     | No code at the step. Before #554, 0.50 / 9 all year. Since #554 (`40e4b61c`), 1 / 18 all year | 1 / 18 (since #554) → 0.50 / 9.00 until 2027-01-01T00:00:00Z, 1.00 / 18.00 from it                                                     | D3, D9, D13, D18        |
| `speech.gemini-tts-3-8-flash-lite.belarusian` (off)    | `google-gemini` / `gemini-3.8-flash-lite-tts` / `google-gemini:standard`                                                                                                                                                                            | As above                                                                                                                                                                                                                          | As above                                                                                    | As above                                                                                                                                                                   | As above                                                                                                                                                                 | As above                                                                                                                                                                                                                   | Before #554, 0.50 / 6 all year. Since #554, 1 / 12 all year                                   | 1 / 12 (since #554) → 0.50 / 6.00 until 2027-01-01T00:00:00Z, 1.00 / 12.00 from it                                                     | D3, D9, D13, D18        |
| `speech.gemini-tts.belarusian` (off, retired)          | `google-gemini` / `gemini-3.1-flash-tts-preview` / `google-gemini:standard`                                                                                                                                                                         | As above                                                                                                                                                                                                                          | None                                                                                        | `input_cached` '0' (never read)                                                                                                                                            | None: the model is refused at the estimate and the send (`RetiredSpeechModels`)                                                                                          | None for new work                                                                                                                                                                                                          | None                                                                                          | 1 / 20 → 1.00 / 20.00 (same); catalog status `preview`                                                                                 | D9                      |
| `speech.elevenlabs-v3.belarusian` (off)                | `elevenlabs` / `eleven_v3` / `elevenlabs:pay-as-you-go`                                                                                                                                                                                             | `input`←`characters`                                                                                                                                                                                                              | 0.08 per 1,000 characters → `convertRate` to per 10^6 at scale 6 = **80**, exact            | `input_cached` '0' and `output` '0' (never read)                                                                                                                           | Tariff arithmetic over the `character-cost` response header, or the sent text's length when the header is absent                                                         | Estimate at admission. **The tariff is looked up again after the response.** Settles with `billed()`                                                                                                                       | None                                                                                          | 80 → 0.08 per 1K (= 80 per 10^6): same                                                                                                 | D9, D13, D21            |
| `speech.elevenlabs-v4.belarusian` (off)                | `elevenlabs` / `eleven_v4` / `elevenlabs:pay-as-you-go`                                                                                                                                                                                             | As above                                                                                                                                                                                                                          | As above, exact                                                                             | As above                                                                                                                                                                   | As above                                                                                                                                                                 | As above                                                                                                                                                                                                                   | None                                                                                          | 80 → 0.08 per 1K: same                                                                                                                 | D9, D13, D21            |
| `speech.elevenlabs-multilingual-v2.multilingual` (off) | `elevenlabs` / `eleven_multilingual_v2` / `elevenlabs:pay-as-you-go`                                                                                                                                                                                | As above                                                                                                                                                                                                                          | As above, exact                                                                             | As above                                                                                                                                                                   | As above                                                                                                                                                                 | As above                                                                                                                                                                                                                   | None                                                                                          | 80 → 0.08 per 1K: same                                                                                                                 | D9, D13, D21            |
| `text.gemini-3-8-flash.synchronous` (off)              | `google-gemini` / `gemini-3.8-flash` / `google-gemini:standard`                                                                                                                                                                                     | `input`←`input`; `input_cached`←`input_cached` (declared 0.15, **never read**: `cachedContentTokenCount` is not parsed); `output`←`output` (candidates plus thoughts); none←`cache_storage`, `grounding_search`, `grounding_maps` | None                                                                                        | None                                                                                                                                                                       | Tariff arithmetic after the response, an unlabelled `actual_minor`                                                                                                       | Estimate at admission. The tariff is looked up again before the send and after the response. Settles with `billed()`. The script drafter confirms `costMinor ?? estimate`                                                  | No code. **Carries the 2027 rates all year**                                                  | 1.50 / 0.15 / 7.50 → 0.75 / 0.075 / 3.75 until 2027-01-01T00:00:00Z, then 1.50 / 0.15 / 7.50                                           | D2, D4, D13             |
| `audio-evaluation.gemini-flash` (off)                  | `google-gemini` / `gemini-3.8-flash` / `google-gemini:standard`                                                                                                                                                                                     | `input`←`input` (text and audio: one price for every modality); `input_cached`←`input_cached` (declared **0**, never read); `output`←`output`                                                                                     | None. Audio at 32 tokens per second plus a 20% margin, in the estimate only                 | `input_cached` '0', while the catalog prices cached input                                                                                                                  | As above                                                                                                                                                                 | As above                                                                                                                                                                                                                   | No code. Carries the 2027 rates all year                                                      | 1.50 / **0** / 7.50 → 0.75 / 0.075 / 3.75, then 1.50 / 0.15 / 7.50                                                                     | D2, D4, D13             |
| **`music.elevenlabs` (on)**                            | `elevenlabs` / `music_v1` / `elevenlabs:pay-as-you-go`                                                                                                                                                                                              | `output`←`output_audio_duration`                                                                                                                                                                                                  | 0.15 per minute → `convertRate` to per 10^6 ms at scale 6 = **2.5**, exact                  | `input` '0' and `input_cached` '0' (never read)                                                                                                                            | Tariff arithmetic over the decoded length in ms (not a provider figure)                                                                                                  | Estimate at admission on `lengthMs`, or the 600,000 ms bound. **The tariff is looked up again after decoding.** Settles with `billed()`                                                                                    | **Deprecated: removed on 2027-01-31**                                                         | 2.50 per 10^6 ms → 0.15 per minute (= 2.5 per 10^6 ms): same                                                                           | **D10**, D11, D13       |
| **`sound-effects.elevenlabs` (on)**                    | `elevenlabs` / `eleven_text_to_sound_v2` / `elevenlabs:pay-as-you-go`                                                                                                                                                                               | `output`←`output_audio_duration`                                                                                                                                                                                                  | 0.12 per minute → per 10^6 ms = **2**, exact                                                | As above                                                                                                                                                                   | As above                                                                                                                                                                 | Estimate on `durationMs`, or the 30,000 ms bound. Looked up again after decoding. `billed()`                                                                                                                               | **Deprecated: removed on 2027-03-01**                                                         | 2.00 per 10^6 ms → 0.12 per minute (= 2 per 10^6 ms): same                                                                             | **D10**, D11, D13       |
| **`music.gemini-lyria` (new route, omf-app #557)**     | `google-gemini` / `lyria-3.5` / `google-gemini:standard`. Legacy: `lyria-3-clip-preview` ($0.04 per 30 s song) and `lyria-3-pro-preview` ($0.08). `lyria-3.5` is `available`; the two Lyria 3 models are `preview`, with no shutdown date announced | `generation`←one per song                                                                                                                                                                                                         | $0.08 per song = 0.08 per 1 `request`. No `convertRate`: the unit is a song, not a duration | None                                                                                                                                                                       | **New route: Lyria is not in omf-app today (#557). It is the preferred music route, ahead of `music.elevenlabs`.** The catalog states the rate; omf-app builds the route | To be built, in songs: the estimate, the spend check and settlement count songs, not seconds                                                                                                                               | None                                                                                          | No current rate (new route)                                                                                                            | **D10**                 |

ᵈ Derived on the page from stated multipliers (`provenance.derivation`).

**Not a route, but a tariff consumer:** voice design (`GeminiVoiceDesign`) prices with the two Gemini 3.8 TTS
tariffs, chosen by model, and settles after the response from `total_input_tokens` and
`total_output_tokens`. Casting auditions and the smoke command also read the book. A1's selectors must
cover them (D18).

## The differences, for the owner

Nothing below is decided here. **Known** marks the differences the brief named.

- **D1. gpt-6.1-sol cached input (known).** omf-app: $0.20. Page: $0.10, 5% of input. The owner stated
  the rates on 2026-10-17, with cached input "10 percent of input by assumption" (plan §9, decision 5).
- **D2. Gemini 3.8 Flash text and evaluation carry the 2027 rates (known, on purpose).**
  - omf-app: 1.50 / 0.15 / 7.50 all year, so that an estimate bounds the charge on either side of the
    step.
  - Catalog: 0.75 / 0.075 / 3.75 until 2027-01-01T00:00:00Z, then 1.50 / 0.15 / 7.50.
  - So omf-app overstates 2026 calls by a factor of 2.
- **D3. Gemini 3.8 TTS carries the 2027 rates (known; the stopgap, merged as #554).**
  - Since `40e4b61c`, omf-app carries the 2027 rates all year (1 / 18 and 1 / 12), like D2, so it
    overstates 2026 calls by a factor of 2.
  - Before it, the introductory rates were carried all year, and no code changed them at the step.
  - The catalog has both windows.
- **D4. Gemini cached input.** The catalog prices `input_cached` at 0.075, then 0.15.
  - The text route declares 0.15 but never meters it: `cachedContentTokenCount` is not parsed, so cache
    hits are priced as input. That is conservative.
  - The evaluation route declares 0. If its usage ever split cache hits out, they would be free.
  - Under the catalog, a complete Gemini report must state `input_cached`. Section 15 of the specification
    leaves open whether `total_input_tokens` includes cached tokens.
- **D5. Anthropic 1-hour cache writes are now published.** $4 standard, and $2 Batch (derived). omf-app
  does not declare `cache_creation_1h` ("not published there"), so a call with 1-hour writes makes its
  cost unknown today. The catalog prices it.
- **D6. OpenAI bills cache writes, and Codex reports them.**
  - The page bills 30-minute writes at $2.50 and 12-hour writes at $5.00 per MTok, separately from input.
  - Since Codex PR #33454, `turn.completed` carries `cache_write_input_tokens`, so written tokens are
    reported. An earlier version of this matrix said Codex reports no cache writes. That was wrong.
  - omf-app read none of it before openadviser/omf-app#560 (2026-11-06), so written tokens were priced at the $2.00 input
    rate. With its catalog switch off they still are. Codex's `input_tokens` includes both cache
    shares (codex-rs 0.163.0 and 0.166.0), so nothing is counted twice.
  - **Owner's decision (2026-11-05, D6 = A):**
    - written tokens are priced at `cache_write_30m`, because `codex exec` sends no cache lifetime and
      OpenAI's default is 30 minutes;
    - writes replace input for those tokens: a written token is priced at the write rate, not at the
      write rate and again at the input rate (COMP-1: `input` excludes tokens written to a cache).
- **D7. GPT-6.1 Sol long-context surcharge.** Above 272K input tokens the whole request is 2x input and
  cached input, and 1.5x output; the cache writes there are `unsupported`. omf-app does not model it.
  The model page says usage drawn from a subscription has no surcharge, but the API-key route is not a
  subscription.
  - **Owner's decision (2026-11-05, D7 = C):** omf-app declares an override of the >272K whole-request
    condition.
- **D8. Server-side tools.**
  - Anthropic: web search $10 per 1K; code execution unsupported.
  - OpenAI: web search $10 per 1K and file search $2.50 per 1K; containers unsupported.
  - The metered Claude route and the API-key CLI routes report no tool calls.
  - Claude Code's `total_cost_usd` covers them. Codex's tokens do not.
  - A complete report must state each tool component, zero included.
- **D9. Synthetic zeros.** omf-app's grammar requires `input`, `input_cached` and `output` on every
  route. The catalog does not list `input_cached` for TTS or ElevenLabs, `output` for ElevenLabs speech,
  or `input` for music and sound effects. No code reads these zeros. A1 maps them to "not offered", never
  to a catalog rate.
- **D10. ElevenLabs deprecations (prominent).** `music_v1` is removed on 2027-01-31 and
  `eleven_text_to_sound_v2` on 2027-03-01, and both routes are enabled. Moving to `music_v2` / `music_v2_5`
  and `eleven_text_to_sound_v3` is a registry change, plus a catalog entry for each successor.
  - The catalog now carries the three successors (schema 1.1.0), each with `status: available`. The
    pricing page prices products, not model ids, and no page lists a model id under a product or
    states its price. The models page names `music_v2_5` and `eleven_text_to_sound_v3` the
    replacements of `music_v1` and `eleven_text_to_sound_v2`, but a migration suggestion is not a
    price, and `music_v2` is the replacement of nothing.
  - **Owner's decision (2026-11-05, decision "A"):** the product's rate applies to the successor — the
    Music card's $0.15 per minute to `music_v2_5` and `music_v2`, the Sound Effects card's $0.12 per
    minute to `eleven_text_to_sound_v3` — recorded in the catalog as an owner attribution, read fresh
    from the card on every run and falling back to `needs-review` when the page changes under it
    ([sources](sources.md#owner-attributions-2026-11-05)). omf-app can now price each successor from
    the catalog instead of keeping its own tariff (#557, item 3).
  - A model being in the catalog enables nothing in omf-app.
- **D11. ElevenLabs duration metering.**
  - omf-app prices the decoded length, prorated to the millisecond.
  - The page states a per-minute price and that music and sound effects are "billed per generation". It
    states no rounding, minimum or granularity.
  - The rates agree. Whether the quantity agrees is unestablished, so the specification makes this
    figure an estimate (Section 15).
- **D12. Rounding and settlement policy differ by path.**
  - The Execution path settles with `estimate()`: no floor, so a sub-cent call settles at 0.
  - Audio settles with `billed()`.
  - Audio estimates use `total()` then at least 1 cent, even when the total is 0.
  - The Claude CLI's cost is rounded up to the cent.
  - The catalog returns both figures, and the basis records the one chosen (ROUND-4). The owner chooses
    per path.
- **D13. Rates are looked up again after the response.**
  - Gemini speech, ElevenLabs speech, music and sound effects, and the Gemini model client read the
    tariff again at settlement.
  - With dated windows, a call admitted on 2026-12-31 and settled on 2027-01-01 would be repriced.
  - Plan §11.4.1 (A0) snapshots the rates before dispatch. The catalog's basis is that snapshot, and
    `priceFromBasis` settles from it.
- **D14. Totals-only usage.** omf-app prices a report without a cache split at input and output
  (`PricingBasis`, the owner's rule of 2026-09-11). The catalog refuses `totals-only`. A consumer that
  keeps the rule must restate such a report as a complete one itself.
- **D15. Effort `none`.** The catalog lists `none` for gpt-6.1-terra and gpt-6-luna. omf-app's
  vocabulary has no `none`, and the intersection (plan §11.4.7) drops it. No change today.
- **D16. Gemini TTS tiers.** The registry says "No batch API for TTS". The page now has Batch and Flex
  tabs for the 3.8 TTS models. The catalog carries Standard only, as omf-app uses.
- **D17. Tier verification.**
  - The specification requires the consumer to check the tier the provider reports (TIER-3): Anthropic
    `usage.service_tier`, OpenAI `service_tier`.
  - The CLI routes do not surface it.
  - An OpenAI project whose service tier is set to Fast would bill 2x on the Codex route.
- **D18. Voice design and other non-route consumers.** Voice design, casting auditions and the smoke
  command read tariffs by model, not by route. A1 needs a catalog selector for each.
- **D19. `text.claude.batch` has no runtime consumer.** The catalog carries the Batch offering with three
  derived cache rates. Nothing prices against it today.
- **D20. Registry `enabled` on the audio path.** The audio adapters pick routes with
  `ProviderRegistry::routesOf`, which does not filter on `enabled`, so the code does not show what stops a
  disabled Gemini or ElevenLabs route from being priced. This is not a catalog difference, but A1's
  effective-configuration check (plan §11.4.4) depends on it.
- **D21. ElevenLabs characters.** omf-app uses the provider's `character-cost` header, or the sent text's
  length. The page says "billed per character" and does not say which characters count. Same rates.

## Effort levels

`config/model_efforts.yaml` and `ThinkingEffort::MODELS` against the catalog's `effort`:

| Model             | omf-app (YAML and `ThinkingEffort`) | Catalog levels                          | Catalog default | Differs                                                                                                         |
| ----------------- | ----------------------------------- | --------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| gemini-3.8-flash  | low, medium, high                   | low, medium, high                       | medium          | Same levels. omf-app sends its local `low` on purpose                                                           |
| claude-sonnet-5   | low … max (5)                       | low, medium, high, xhigh, max           | high            | No                                                                                                              |
| claude-fable-5-1  | low … max (5)                       | low, medium, high, xhigh, max           | high            | No                                                                                                              |
| claude-opus-5-5   | low … max (5)                       | low, medium, high, xhigh, max           | medium          | No                                                                                                              |
| claude-sonnet-5-5 | low … max (5)                       | low, medium, high, xhigh, max           | high            | No                                                                                                              |
| claude-haiku-5-5  | low … max (5)                       | low, medium, high, xhigh, max           | medium          | No                                                                                                              |
| gpt-6.1-sol       | low … max (5)                       | low, medium, high, xhigh, max           | medium          | No                                                                                                              |
| gpt-6-astra       | low … max (5)                       | low, medium, high, xhigh, max           | none stated     | No (the page states no default)                                                                                 |
| gpt-6.1-terra     | low … max (5)                       | **none**, low, medium, high, xhigh, max | medium          | **Yes:** the catalog adds `none`, which `ThinkingEffort::LEVELS` and the runner's `REQUEST_EFFORTS` do not have |
| gpt-6-luna        | low … max (5)                       | **none**, low, medium, high, xhigh, max | medium          | **Yes:** as gpt-6.1-terra                                                                                       |

Under plan §11.4.7, the offered levels are the catalog's levels ∩ the adapter's (`ThinkingEffort`, the
runner schema) ∩ the local restrictions. So `none` drops out at the adapter, and nothing changes for a
request today.
