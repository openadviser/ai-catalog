# readers/

One reader per source. **Empty until slice C2.**

| Slice | Readers                                            |
| ----- | -------------------------------------------------- |
| C2    | `anthropic`, `gemini`                              |
| C3    | `openai`, `elevenlabs`                             |
| C4    | Cross-check readers, the reconciler and the policy |

Each reader keeps its saved pages in its own `fixtures/` directory. See
[sources](../docs/sources.md) and [adding a source](../docs/adding-a-source.md).

## Rules that already bind it

- A reader returns readings: provider, model, tier, component, unit, `per`, amount, currency, optional
  validity window and condition, URL and time read. It also returns model and effort readings.
- **Readers fail closed.** A missing table, a missing model or an unparseable price is an `unreadable`
  reading with the reason, never a zero or a guess.
- A reader asserts the structure of the page, not only the cells it reads: the expected table headers,
  tier headings and the footnotes it understands. An unknown header, tier or footnote that touches a model
  we track yields `needs-review`, never a partial price.
- Each reader is tested against saved copies of its page. A test fails when a saved page's reading
  changes. Mutation fixtures (an inserted column, a moved heading, a footnote whose scope changed) must
  each produce `needs-review`.
- Every production read keeps its response bytes as [evidence](../evidence/).
- Model lists follow pagination and record the account scope they were read with. Absence from a list
  never retires a model.
- Cross-check sources are read, never depended on.
