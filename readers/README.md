# readers/

One reader per source, all built on the shared kit. The four providers' readers are the sources of
truth; `models-dev/` and `genai-prices/` are cross-checks, never the source of a value.

| Directory       | Reads                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `kit/`          | `@openadviser/ai-catalog-readers-kit`: fetch with evidence, reading types, structure assertions,                 |
|                 | date rules, paginated API reads, decimal amount arithmetic, a span-keeping JSON parser                           |
| `anthropic/`    | `pricing.md` + footnotes, the models overview, `effort.md`, per-model pages, `GET /v1/models`                    |
| `gemini/`       | `pricing.md.txt` prose windows, tier tabs and the per-song Lyria tables, `thinking.md.txt`, `GET /v1beta/models` |
| `openai/`       | the pricing page's serialized tier panes and Tools table, per-model pages, `GET /v1/models`                      |
| `elevenlabs/`   | `pricing/api` product cards and per-plan grids, the models/deprecation page, `GET /v1/models`                    |
| `models-dev/`   | cross-check: `models.dev/api.json`, each tracked model's `cost` and `last_updated`                               |
| `genai-prices/` | cross-check: `prices/new_data/v2/data.json` and each model's `prices_checked`, at one commit                     |

`run.ts` runs any of them (`readSource`); the CLI and the update job ([`reconcile/`](../reconcile/))
both call it.

## Running

```
npm run read -- <anthropic|google-gemini|openai|elevenlabs|models-dev|genai-prices> [--live]
```

Without `--live` the reader works on saved bytes, the newest body for each URL it reads, and prints the
`ReadReport` as JSON. The saved bytes are those under `evidence/`, and for the cross-checks their
fixtures.

With `--live` it fetches the pages and stores bytes and retrieval records under `evidence/` first. It
runs the API list read when the key is in the environment (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` /
`OPENAI_API_KEY` / `ELEVENLABS_API_KEY`). Each key is optional: without it, that API source is a
`not-configured` "no key" observation — the read is skipped, and the update's run summary lists it. An
API read never runs without `--live`; the update job still reports each absent key the same way.

The update job stores a live run's bytes in its own run directory instead, and commits only the ones a
change cites ([trust and provenance](../docs/trust-and-provenance.md#evidence-retention)).

## The rules it enforces

- **Readers fail closed.** A missing table, a missing tracked model or an unparseable price is a
  `needs-review` or `unreadable` reading with the reason, never a zero or a guess.
- **Whole facts.** Each reading carries the whole fact identity — provider, modelId, tier, component,
  unit, `per`, currency, condition, window — plus the amount. It also carries its provenance: evidence
  sha256, byte offset and the exact excerpt there.
  - The kit verifies it when the reading is made.
  - The reconciler re-checks every run that the excerpt contains the value.
  - `check-data.ts` re-checks it at every commit.
- **Structure assertions.** A reader asserts the structure of the page, not only the cells it reads:
  expected table headers, tier headings and the footnotes it understands. An unknown header, tier or
  footnote touching a tracked model is `needs-review`.
- **Untracked tiers.** A tier the schema does not model, on a tracked model, is a `needs-review` "tier
  not in schema 1.0.0" observation, never a rate.
- **Model lists** follow pagination and record the account scope. Absence from a list never retires a
  model.
- **Cross-checks** declare their lineage on the report and a revision date on each reading. They match
  models by exact id only. A field whose meaning the tracker does not fix is left unmapped
  ([sources](../docs/sources.md#cross-checks)).
- **Tests.**
  - The tests run on the seed: each URL's earliest saved body, and the frozen seed catalog in
    `fixtures/seed-catalog.json`. The update job commits newer pages and changes `data/catalog.json`,
    and the readers' regression tests must not move with them.
  - Each mutation fixture produces `needs-review`.

See [adding a source](../docs/adding-a-source.md) for the contributor workflow.
