# readers/

One reader per source, all built on the shared kit.

| Directory    | Reads                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `kit/`       | `@openadviser/ai-catalog-readers-kit` — fetch with evidence, reading types, structure assertions, |
|              | date rules, paginated API reads, decimal amount arithmetic                                        |
| `anthropic/` | `pricing.md` + footnotes, the models overview, `effort.md`, per-model pages, `GET /v1/models`     |
| `gemini/`    | `pricing.md.txt` prose windows and tier tabs, `thinking.md.txt`, `GET /v1beta/models`             |

## Running

```
npm run read -- <anthropic|google-gemini> [--live]
```

Without `--live` the reader works on the newest body saved under `evidence/` for each URL it reads and
prints the `ReadReport` as JSON. With `--live` it fetches the pages, stores bytes and retrieval records
under `evidence/` first, and runs the API list read when the key is in the environment
(`ANTHROPIC_API_KEY` / `GEMINI_API_KEY`). An API read never runs without `--live` and never without the
key.

## The rules it enforces

- **Readers fail closed.** A missing table, a missing tracked model or an unparseable price is a
  `needs-review` or `unreadable` reading with the reason, never a zero or a guess.
- Each reading carries the whole fact identity — provider, modelId, tier, component, unit, `per`,
  currency, condition, window — plus the amount and provenance: evidence sha256, byte offset and the
  exact excerpt there, verified by the kit at citation time and by `check-data.ts` at release.
- A reader asserts the structure of the page, not only the cells it reads: expected table headers, tier
  headings and the footnotes it understands. An unknown header, tier or footnote touching a tracked
  model is `needs-review`.
- A tier the schema does not model on a tracked model is a `needs-review` "tier not in schema 1.0.0"
  observation, never a rate.
- Model lists follow pagination and record the account scope. Absence from a list never retires a model.
- Tests run on the saved evidence plus mutation fixtures; each mutation produces `needs-review`.

See [adding a source](../docs/adding-a-source.md) for the contributor workflow.
