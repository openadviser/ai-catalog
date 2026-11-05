# data/

The published catalog.

- `catalog.json`: the catalog, schema 1.1.0. See [data format](../docs/data-format.md).
- `catalog.json.sha256`: `<sha256>  catalog.json`, the hash of the file's exact bytes. Write it with
  `npm run data:hash`.

The README's coverage table is generated from `catalog.json` by `npm run coverage:table`.

## The first catalog (`2026.11.04.1`)

Released as [`data-v2026.11.04.1`](https://github.com/openadviser/ai-catalog/releases/tag/data-v2026.11.04.1).
It covers exactly the providers, models and tiers omf-app uses:

- the models of its priced routes, with their offerings;
- the models it runs only on a subscription, with their effort levels and `offerings: []`.

Every value was entered by hand from the providers' pages, fetched on 2026-11-04. Each one points at the
page's bytes in [`evidence/`](../evidence/) and at its location in them. The values that differ from
omf-app's configuration are listed in the [migration matrix](../docs/migration-matrix.md).

## Rules that bind it

- Every price carries its provenance: the source, the page URL, when it was read, the reader, the
  evidence and the exact location. `npm run check` verifies each cited excerpt against the evidence
  bytes.
- After the first entry, data changes arrive as pull requests: from the update workflow, or from a person
  with the sources linked. Nothing is edited without review.
- A release is one validated commit that produces the version, `publishedAt`, `catalog.json` and the hash
  together. Releases are immutable and addressed by version.
- No price is invented, and no price is copied from a third-party dataset without the provider's page
  agreeing with it.
- The bytes are hashed, so the formatter skips `catalog.json` and git never rewrites its line endings.
- `data/` is owned by the maintainers in [CODEOWNERS](../.github/CODEOWNERS).
- The data is MIT-licensed, like the code.

See [update policy](../docs/update-policy.md) and [trust and provenance](../docs/trust-and-provenance.md).
