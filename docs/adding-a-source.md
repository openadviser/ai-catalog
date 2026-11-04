# Adding a source or a provider

## Purpose

To walk a contributor through adding a pricing source, a model list or a whole provider, using the reader
kit in [`readers/kit/`](../readers/kit/). Anthropic ([`readers/anthropic/`](../readers/anthropic/)) is the
worked example throughout.

## Before you start

Open a _New model or provider_ issue and link the provider's official pricing page. If the page is not the
provider's own, it cannot be the source of truth. It can only be a cross-check. See
[sources](sources.md).

## The steps

1. **Read the page by hand first.** Note every table, tier, unit and footnote that changes a rate, every
   dated window, and every model qualifier. The Anthropic page's traps: `<sup>N</sup>` markers on cells,
   model-specific cache multipliers, the Batch table whose cache prices are only implied by the standard
   table, and the US-only `inference_geo` 1.1x statement.

2. **Add a reader** in `readers/<name>/` — a package depending on
   `@openadviser/ai-catalog-readers-kit`. Its entry point takes the evidence it reads, the
   `TrackedScope` from `trackedScope(catalog, provider)`, and returns `Reading[]`.
   - Emit facts with `Readings.rate / model / effort`, and `needs-review`/`unreadable` with
     `Readings.review` / `Readings.observe`. A `Reading` carries the whole fact identity — provider,
     modelId, tier, component, unit, `per`, currency, condition, window — plus the amount and provenance.
   - Build every `Provenance` with `evidence.cite(path, offset, excerpt, anchors)`: the kit checks the
     excerpt is exactly the bytes at the offset, and `check-data.ts` re-verifies at release time. A
     derived value uses `derive(formula, inputs)` whose every input is cited.
   - Assert structure, not just cells: `MarkdownPage.tableUnder`, `expectColumns`, `footnoteDefs` +
     `expectFootnotes` declare the headers, tier names and footnotes understood. Anthropic declares its
     footnotes as `FOOTNOTE_SPECS`; an undeclared footnote a tracked row cites is `needs-review`.
   - Fail closed: throw `NeedsReview` where the page contradicts itself or holds a form never seen, and
     `Unreadable` where the document itself is missing or the wrong kind. Never emit a zero or a guess.
   - Parse cell text exactly. A price cell holds only the forms declared (`$N / MTok`, `through` /
     `starting` date windows); anything unexplained between phrases is `needs-review`. Non-ASCII text
     is the norm — all offsets are evidence bytes; convert char indices with `evidence.byteOffset()`.
   - Date bounds come from the kit: `throughDate` / `startingDate` / `undated` / `statedInstant`,
     and the rule applied is recorded on the provenance as `dateRule`.

3. **Handle every tier the page states.** The schema's tiers are fixed; a tier the page prices but the
   schema does not model (Anthropic's fast mode, Gemini's Batch/Flex/Priority tabs) touching a tracked
   model is a `needs-review` "tier not in schema 1.0.0" observation — never silently skipped, never a
   guessed rate.

4. **Derive only what the page states.** The Anthropic Batch cache prices are derived: the stated
   multiplier times the stated 50% Batch discount times the stated standard base input — the formula and
   every input cited. A derivative that cannot be stated exactly is never rounded into a wrong price.

5. **Read the model list as an API source,** if the provider has one: `readPaged` follows `has_more` /
   `nextPageToken` style pagination through a `PageLoader`, stores each response as evidence, and the
   report records the account scope. The key comes from `apiKey("PROVIDER_API_KEY")` — the environment,
   never a file. Absence from a list never retires a model: emit readings only for what the list
   contains, and validate each item's declared shape (`type`, `id`, capabilities) strictly.

6. **Save the page as evidence** (C1's `evidence/` store, via `EvidenceStore.latest(url)`) and write the
   tests: a seed-parity test reproducing every fact the catalog covers, mutation fixtures — an inserted
   column, a moved heading, a new footnote touching a tracked model, a changed footnote scope, a missing
   model, an unparseable amount — each producing `needs-review`, and the API fixtures from the
   provider's documented response shape under `readers/<name>/fixtures/`.

7. **Document it** in [sources](sources.md): the source, its cross-check, its form and its traps.
   - **A source of truth** runs in `readers/run.ts` (`readSource`), so the update job reads it every
     day.
   - **A cross-check** also declares its `lineage` (the trackers it copies from), and gives each
     reading the tracker's own `revisedAt` for that entry. Without a revision date it never counts.
     It matches models by exact id, and leaves unmapped any field whose meaning the tracker does not
     fix ([update policy](update-policy.md#cross-checks)).

8. **Open a pull request** with the checklist filled in. `npm run read -- <provider>` prints the
   readings from the saved evidence; `npm run read -- <provider> --live` fetches fresh pages and stores
   them under `evidence/` first.
